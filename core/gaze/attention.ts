// Attention field: gaze samples accumulated with exponentially decaying weights (docs/CONTROL.md §5.2).
import { GAZE } from '../config.ts';
import type { Vec3 } from '../math/vec.ts';

export interface GazeSample {
  /** time [s] on the simulation clock */
  t: number;
  p: Vec3;
  conf: number;
}

export class GazeHistory {
  readonly samples: GazeSample[] = [];

  forgetTau: number;

  constructor(forgetTau: number = GAZE.forgetTau) {
    this.forgetTau = forgetTau;
  }

  add(s: GazeSample): void {
    this.samples.push(s);
  }

  /** Drop samples whose weight has decayed below exp(-5) (or older than the horizon). */
  prune(now: number): void {
    const horizon = Math.min(GAZE.historyHorizon, 5 * this.forgetTau);
    let n = 0;
    while (n < this.samples.length && now - this.samples[n].t > horizon) n++;
    if (n > 0) this.samples.splice(0, n);
  }

  clear(): void {
    this.samples.length = 0;
  }

  /** Latest sample, if any. */
  get last(): GazeSample | undefined {
    return this.samples[this.samples.length - 1];
  }
}

/**
 * Normalized attention A(p, t) in [0, 1]: the decayed-weight share of recent gaze that fell near p.
 * Returns 0 when there is no usable history.
 */
export function attentionAt(h: GazeHistory, p: Vec3, now: number, sigma: number): number {
  const inv2s2 = 1 / (2 * sigma * sigma);
  const invTau = 1 / h.forgetTau;
  let num = 0;
  let den = 0;
  for (const s of h.samples) {
    const w = s.conf * Math.exp(-(now - s.t) * invTau);
    if (w <= 0) continue;
    const dx = p[0] - s.p[0];
    const dy = p[1] - s.p[1];
    const dz = p[2] - s.p[2];
    num += w * Math.exp(-(dx * dx + dy * dy + dz * dz) * inv2s2);
    den += w;
  }
  return den > 1e-9 ? num / den : 0;
}

/**
 * Evaluate the field on an nx x ny grid over the table (z = zPlane), row-major, for the floor heat map.
 * Uses the unnormalized density scaled by its max so the map shows where attention is concentrated.
 */
export function attentionGrid(
  h: GazeHistory,
  now: number,
  sigma: number,
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
  nx: number,
  ny: number,
): Float32Array {
  const out = new Float32Array(nx * ny);
  const inv2s2 = 1 / (2 * sigma * sigma);
  const invTau = 1 / h.forgetTau;
  const ws = h.samples.map((s) => s.conf * Math.exp(-(now - s.t) * invTau));
  let max = 0;
  for (let j = 0; j < ny; j++) {
    const y = bounds.yMin + ((j + 0.5) / ny) * (bounds.yMax - bounds.yMin);
    for (let i = 0; i < nx; i++) {
      const x = bounds.xMin + ((i + 0.5) / nx) * (bounds.xMax - bounds.xMin);
      let v = 0;
      for (let k = 0; k < h.samples.length; k++) {
        const s = h.samples[k];
        const dx = x - s.p[0];
        const dy = y - s.p[1];
        // project samples onto the table: use horizontal distance only
        v += ws[k] * Math.exp(-(dx * dx + dy * dy) * inv2s2);
      }
      out[j * nx + i] = v;
      if (v > max) max = v;
    }
  }
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max;
  return out;
}
