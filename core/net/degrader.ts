// Artificial network impairment: fixed delay + truncated Gaussian jitter (optionally FIFO),
// Bernoulli or Gilbert-Elliott loss. One Degrader per direction and peer; every message type
// is an independent stream with its own RNG, GE state and FIFO clock (docs/PROTOCOL.md §6).
import { NET_DEFAULTS } from '../config.ts';
import { Rng, hash32 } from '../math/rng.ts';
import { OWD_BINS, owdBin, type NetParams } from '../protocol/messages.ts';

export const defaultNetParams = (): NetParams => ({ ...NET_DEFAULTS });

/** Gilbert-Elliott transition probabilities giving long-run loss `loss` and mean burst `L`. */
export function geTransitions(loss: number, burstLength: number): { pGB: number; pBG: number } {
  const pBG = 1 / Math.max(1, burstLength);
  const l = Math.min(Math.max(loss, 0), 0.95);
  const pGB = l <= 0 ? 0 : Math.min(1, (l * pBG) / (1 - l));
  return { pGB, pBG };
}

interface StreamState {
  rng: Rng;
  bad: boolean;
  lastDelivery: number;
  run: number;
}

interface Pending<T> {
  at: number;
  order: number;
  item: T;
}

export const BURST_BINS = 16;

export class Degrader<T> {
  private params: NetParams;
  private streams = new Map<string, StreamState>();
  private queue: Pending<T>[] = [];
  private counter = 0;
  // observations of what was actually applied
  readonly appliedDelayHist = new Array<number>(OWD_BINS).fill(0);
  readonly burstHist = new Array<number>(BURST_BINS).fill(0);
  dropped = 0;
  passed = 0;

  private seed: number;

  constructor(params: NetParams, seed = 1) {
    this.params = { ...params };
    this.seed = seed;
  }

  setParams(p: NetParams, seed?: number): void {
    this.params = { ...p };
    if (seed !== undefined && seed !== this.seed) {
      this.seed = seed;
      this.streams.clear();
    }
  }

  get current(): NetParams {
    return this.params;
  }

  private stream(key: string): StreamState {
    let s = this.streams.get(key);
    if (!s) {
      s = { rng: new Rng(this.seed ^ hash32(key)), bad: false, lastDelivery: -Infinity, run: 0 };
      this.streams.set(key, s);
    }
    return s;
  }

  private drop(s: StreamState): boolean {
    const p = this.params;
    if (p.loss <= 0) {
      s.bad = false;
      return false;
    }
    if (!p.burst) return s.rng.next() < p.loss;
    const { pGB, pBG } = geTransitions(p.loss, p.burstLength);
    // transition, then emit according to the new state (good: deliver, bad: drop)
    if (s.bad) {
      if (s.rng.next() < pBG) s.bad = false;
    } else if (s.rng.next() < pGB) {
      s.bad = true;
    }
    return s.bad;
  }

  /**
   * Submit an item sent at `now` on stream `key`. Returns false if it was dropped.
   * `lossy = false` exempts control messages from loss (they are still delayed).
   */
  submit(item: T, now: number, key: string, lossy: boolean): boolean {
    const s = this.stream(key);
    if (lossy && this.drop(s)) {
      this.dropped++;
      s.run++;
      return false;
    }
    if (s.run > 0) {
      this.burstHist[Math.min(BURST_BINS - 1, s.run)]++;
      s.run = 0;
    }
    this.passed++;
    const p = this.params;
    let delay = p.delayMs + (p.jitterMs > 0 ? p.jitterMs * s.rng.gauss() : 0);
    if (delay < 0) delay = 0;
    let at = now + delay;
    if (!p.allowReorder && at < s.lastDelivery) at = s.lastDelivery;
    s.lastDelivery = Math.max(s.lastDelivery, at);
    this.appliedDelayHist[owdBin(at - now)]++;
    this.insert({ at, order: this.counter++, item });
    return true;
  }

  private insert(p: Pending<T>) {
    // binary search on (at, order) keeps equal-time items in submission order
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const q = this.queue[mid];
      if (q.at < p.at || (q.at === p.at && q.order < p.order)) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, p);
  }

  /** Remove and return all items due at or before `now`, in delivery order. */
  poll(now: number): T[] {
    let n = 0;
    while (n < this.queue.length && this.queue[n].at <= now) n++;
    if (n === 0) return [];
    return this.queue.splice(0, n).map((p) => p.item);
  }

  /** Time of the next due item, or Infinity. */
  get nextDue(): number {
    return this.queue.length ? this.queue[0].at : Infinity;
  }

  get pending(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue = [];
  }
}
