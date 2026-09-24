// NTP-style four-timestamp clock synchronization with a minimum-delay clock filter.
import { COMM } from '../config.ts';

export interface SyncSample {
  /** estimated offset theta = server - client [ms] */
  offset: number;
  /** round-trip delay excluding server processing [ms] */
  delay: number;
  /** client time when the sample was taken */
  at: number;
}

export function syncSample(t0: number, t1: number, t2: number, t3: number): SyncSample {
  return {
    offset: (t1 - t0 + (t2 - t3)) / 2,
    delay: t3 - t0 - (t2 - t1),
    at: t3,
  };
}

export class ClockSync {
  private samples: SyncSample[] = [];
  private best: SyncSample | null = null;

  private readonly size: number;

  constructor(size: number = COMM.syncFilterSize) {
    this.size = size;
  }

  add(t0: number, t1: number, t2: number, t3: number): SyncSample {
    const s = syncSample(t0, t1, t2, t3);
    this.samples.push(s);
    if (this.samples.length > this.size) this.samples.shift();
    this.best = this.samples.reduce((a, b) => (b.delay < a.delay ? b : a));
    return s;
  }

  get synced(): boolean {
    return this.best !== null;
  }

  /** Current offset estimate (server - client) [ms]; 0 before the first sample. */
  get offset(): number {
    return this.best ? this.best.offset : 0;
  }

  /** Round-trip time of the selected sample [ms]. */
  get rtt(): number {
    return this.best ? this.best.delay : NaN;
  }

  /** Latest (unfiltered) RTT sample. */
  get lastRtt(): number {
    return this.samples.length ? this.samples[this.samples.length - 1].delay : NaN;
  }

  toServer(clientTime: number): number {
    return clientTime + this.offset;
  }

  toClient(serverTime: number): number {
    return serverTime - this.offset;
  }

  reset(): void {
    this.samples = [];
    this.best = null;
  }
}
