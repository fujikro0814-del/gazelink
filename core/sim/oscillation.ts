// Oscillation detection from the contact-force magnitude (docs/CONTROL.md §7).

export interface OscillationVerdict {
  oscillating: boolean;
  /** dominant frequency [Hz] in 1..20 Hz */
  freqHz: number;
  /** amplitude of the dominant spectral peak [N] */
  amp: number;
  /** mean contact force [N] */
  mean: number;
  /** contact on/off transitions inside the window */
  transitions: number;
}

export const OSC = {
  sampleHz: 200,
  windowS: 1.0,
  fMin: 1,
  fMax: 20,
  minAmp: 2,
  relAmp: 0.3,
  minTransitions: 4,
  /** mean crossings (with hysteresis) required for a spectral peak to count: 3 full cycles */
  minCrossings: 6,
  /** bouncing only counts if the force in the window reaches this level [N] */
  minBounceForce: 5,
} as const;

/**
 * Analyze a force-magnitude series sampled at `sampleHz` and the matching contact flags.
 * Bouncing counts only when the force is significant (a feather-light touch that flickers
 * on and off is not an instability).
 */
export function analyzeForce(
  force: ArrayLike<number>,
  contact: ArrayLike<boolean>,
  sampleHz: number = OSC.sampleHz,
  minTransitions: number = OSC.minTransitions,
): OscillationVerdict {
  const n = force.length;
  let mean = 0;
  let maxF = 0;
  let anyContact = false;
  let transitions = 0;
  for (let i = 0; i < n; i++) {
    mean += force[i];
    maxF = Math.max(maxF, force[i]);
    if (contact[i]) anyContact = true;
    if (i > 0 && contact[i] !== contact[i - 1]) transitions++;
  }
  mean /= Math.max(1, n);
  let best = 0;
  let bestF = 0;
  if (n >= 8) {
    const T = n / sampleHz;
    // Hann window suppresses the leakage of a single contact-onset step into the low bins
    let wsum = 0;
    const xw = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      xw[i] = (force[i] - mean) * h;
      wsum += h;
    }
    // scan 0.5 Hz steps for resolution on short windows
    for (let f = Math.max(OSC.fMin, 2 / T); f <= OSC.fMax; f += 0.5) {
      let re = 0;
      let im = 0;
      const w = (2 * Math.PI * f) / sampleHz;
      for (let i = 0; i < n; i++) {
        re += xw[i] * Math.cos(w * i);
        im -= xw[i] * Math.sin(w * i);
      }
      // single-sided amplitude of a sinusoid, corrected for the window gain
      const amp = (2 * Math.hypot(re, im)) / wsum;
      if (amp > best) {
        best = amp;
        bestF = f;
      }
    }
  }
  // a genuine oscillation crosses its mean repeatedly; a step or ramp does not
  const band = Math.max(0.5, 0.25 * best);
  let crossings = 0;
  let side = 0;
  for (let i = 0; i < n; i++) {
    const x = force[i] - mean;
    const s = x > band ? 1 : x < -band ? -1 : 0;
    if (s !== 0 && s !== side) {
      if (side !== 0) crossings++;
      side = s;
    }
  }
  const periodic = best > Math.max(OSC.minAmp, OSC.relAmp * mean) && crossings >= OSC.minCrossings;
  const bouncing = transitions >= minTransitions && maxF >= OSC.minBounceForce;
  const oscillating = anyContact && (periodic || bouncing);
  return { oscillating, freqHz: bestF, amp: best, mean, transitions };
}

/** Streaming detector: feed every physics step, evaluate every `evalEveryS`. */
export class OscillationDetector {
  private readonly size = Math.round(OSC.sampleHz * OSC.windowS);
  private readonly force = new Float64Array(this.size);
  private readonly contact = new Array<boolean>(this.size).fill(false);
  private head = 0;
  private count = 0;
  private decim = 0;
  private sinceEval = 0;
  last: OscillationVerdict = { oscillating: false, freqHz: 0, amp: 0, mean: 0, transitions: 0 };

  private readonly physicsHz: number;
  private readonly evalEveryS: number;

  constructor(physicsHz = 1000, evalEveryS = 0.1) {
    this.physicsHz = physicsHz;
    this.evalEveryS = evalEveryS;
  }

  /** Returns a verdict when an evaluation happened in this call, else null. */
  push(forceMag: number, inContact: boolean): OscillationVerdict | null {
    const every = Math.round(this.physicsHz / OSC.sampleHz);
    if (++this.decim < every) return null;
    this.decim = 0;
    this.force[this.head] = forceMag;
    this.contact[this.head] = inContact;
    this.head = (this.head + 1) % this.size;
    this.count = Math.min(this.size, this.count + 1);
    this.sinceEval += 1 / OSC.sampleHz;
    if (this.sinceEval + 1e-9 < this.evalEveryS || this.count < this.size / 2) return null;
    this.sinceEval = 0;
    const f: number[] = [];
    const c: boolean[] = [];
    for (let i = 0; i < this.count; i++) {
      const k = (this.head - this.count + i + this.size) % this.size;
      f.push(this.force[k]);
      c.push(this.contact[k]);
    }
    this.last = analyzeForce(f, c);
    return this.last;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.decim = 0;
    this.sinceEval = 0;
    this.last = { oscillating: false, freqHz: 0, amp: 0, mean: 0, transitions: 0 };
  }
}
