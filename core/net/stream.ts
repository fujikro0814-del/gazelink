// Per-(sender, type) receive-side accounting: loss / reordering / duplicates via sequence numbers,
// RFC 3550 interarrival jitter, receive rate, and one-way delay histogram.
import { OWD_BINS, owdBin, type StreamStats } from '../protocol/messages.ts';

export type Verdict = 'fresh' | 'late' | 'duplicate';

const WINDOW = 64;

export class StreamMeter {
  private first = -1;
  private highest = -1;
  /** bit i set => (highest - i) was received */
  private mask = 0n;
  received = 0;
  late = 0;
  duplicate = 0;
  /** RFC 3550 interarrival jitter estimate [ms] */
  jitterMs = 0;
  private lastTransit: number | null = null;
  readonly owdHist = new Array<number>(OWD_BINS).fill(0);
  lastOwdMs = NaN;
  /** arrival times of the last second, for the rate estimate */
  private arrivals: number[] = [];

  /**
   * Record one arrival. `sendTs` and `recvTs` may be on different clocks; jitter only uses
   * their differences. `owdMs` is the synchronized one-way delay estimate, if known.
   */
  observe(seq: number, sendTs: number, recvTs: number, owdMs?: number): Verdict {
    if (this.first < 0) {
      this.first = seq;
      this.highest = seq;
      this.mask = 1n;
      this.account(sendTs, recvTs, owdMs);
      return 'fresh';
    }
    if (seq > this.highest) {
      const shift = seq - this.highest;
      this.mask = shift >= WINDOW ? 1n : ((this.mask << BigInt(shift)) | 1n) & ((1n << BigInt(WINDOW)) - 1n);
      this.highest = seq;
      this.account(sendTs, recvTs, owdMs);
      return 'fresh';
    }
    const back = this.highest - seq;
    if (back < WINDOW && (this.mask >> BigInt(back)) & 1n) {
      this.duplicate++;
      return 'duplicate';
    }
    if (back < WINDOW) this.mask |= 1n << BigInt(back);
    this.late++;
    this.account(sendTs, recvTs, owdMs);
    return 'late';
  }

  private account(sendTs: number, recvTs: number, owdMs?: number) {
    this.received++;
    const transit = recvTs - sendTs;
    if (this.lastTransit !== null) {
      const d = Math.abs(transit - this.lastTransit);
      this.jitterMs += (d - this.jitterMs) / 16;
    }
    this.lastTransit = transit;
    if (owdMs !== undefined && Number.isFinite(owdMs)) {
      this.lastOwdMs = owdMs;
      this.owdHist[owdBin(owdMs)]++;
    }
    this.arrivals.push(recvTs);
    const cutoff = recvTs - 1000;
    while (this.arrivals.length && this.arrivals[0] < cutoff) this.arrivals.shift();
  }

  /** Packets never seen (sequence gaps), counting late arrivals as received. */
  get lost(): number {
    if (this.first < 0) return 0;
    return Math.max(0, this.highest - this.first + 1 - this.received);
  }

  get lossRatio(): number {
    if (this.first < 0) return 0;
    return this.lost / (this.highest - this.first + 1);
  }

  rateHz(now: number): number {
    const cutoff = now - 1000;
    return this.arrivals.filter((t) => t >= cutoff).length;
  }

  snapshot(now: number): StreamStats {
    return {
      received: this.received,
      lost: this.lost,
      late: this.late,
      duplicate: this.duplicate,
      rateHz: this.rateHz(now),
      jitterMs: this.jitterMs,
      owdHist: [...this.owdHist],
    };
  }
}

/** Loss ratio over a sliding window computed from two snapshots of (highest-first+1, received). */
export class WindowedLoss {
  private samples: Array<{ t: number; expected: number; received: number }> = [];
  private readonly windowMs: number;

  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
  }
  update(t: number, expected: number, received: number): number {
    this.samples.push({ t, expected, received });
    while (this.samples.length > 2 && this.samples[1].t < t - this.windowMs) this.samples.shift();
    const a = this.samples[0];
    const de = expected - a.expected;
    const dr = received - a.received;
    return de > 0 ? Math.max(0, 1 - dr / de) : 0;
  }
}
