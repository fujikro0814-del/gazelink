// Gaze-adaptive damping (docs/CONTROL.md §5.3-5.4).
//
// `dampingLaw` is the single replaceable formulation: it maps (gaze history, tip position,
// environment, parameters, time) to a damping target b*. Everything around it (confidence
// fallback, slew-rate limiting, reset semantics) lives in `GazeDamping` and does not need to change.
import { GAZE } from '../config.ts';
import type { Vec3 } from '../math/vec.ts';
import type { GazeParams } from '../protocol/messages.ts';
import { obstacleDistance, type Environment } from '../sim/env.ts';
import { attentionAt, type GazeHistory } from './attention.ts';

export interface DampingLawResult {
  /** target damping b* [N s/m] */
  bTarget: number;
  /** attention at the tip in [0, 1] */
  attention: number;
  /** distance to the nearest obstacle [m] */
  obstacle: number;
}

export const defaultGazeParams = (): GazeParams => ({
  enabled: true,
  target: 'master',
  forgetTau: GAZE.forgetTau,
  bMin: GAZE.bMin,
  bMax: GAZE.bMax,
  slewRate: GAZE.slewRate,
  sigma: GAZE.sigma,
});

/** Light where attention is, heavy outside attention and near obstacles. */
export function dampingLaw(
  history: GazeHistory,
  tip: Vec3,
  env: Environment,
  params: GazeParams,
  now: number,
): DampingLawResult {
  const attention = attentionAt(history, tip, now, params.sigma);
  const obstacle = obstacleDistance(tip, env);
  const proximity = Math.min(1, Math.max(0, 1 - obstacle / GAZE.obstacleRange));
  const u = Math.min(1, Math.max(0, GAZE.wAttention * (1 - attention) + GAZE.wObstacle * proximity));
  return { bTarget: params.bMin + (params.bMax - params.bMin) * u, attention, obstacle };
}

/** Stateful wrapper: confidence fallback to mid-range and slew-rate limiting of b(t). */
export class GazeDamping {
  /** current (rate-limited) damping */
  b: number;
  /** filtered confidence indicator in [0, 1] */
  confFilt = 0;
  last: DampingLawResult = { bTarget: 0, attention: 0, obstacle: Infinity };
  lowConfidence = true;

  params: GazeParams;

  constructor(params: GazeParams = defaultGazeParams()) {
    this.params = { ...params };
    this.b = params.bMin;
  }

  /**
   * Reset the slew-limiter state to B_MIN. Must be called at the start of every trial and on
   * every control-mode switch, so the next condition does not inherit a slowly-decaying b.
   */
  reset(): void {
    this.b = this.params.bMin;
  }

  setParams(p: GazeParams): void {
    this.params = { ...p };
    this.b = Math.min(Math.max(this.b, p.bMin), p.bMax);
  }

  /** Advance one physics step. `confidence` is that of the latest gaze sample (0 if none/stale). */
  step(history: GazeHistory, tip: Vec3, env: Environment, now: number, confidence: number, dt: number): number {
    const p = this.params;
    if (!p.enabled) {
      this.b = p.bMin;
      this.last = { bTarget: p.bMin, attention: 0, obstacle: obstacleDistance(tip, env) };
      this.lowConfidence = false;
      return this.b;
    }
    this.last = dampingLaw(history, tip, env, p, now);
    this.lowConfidence = confidence < GAZE.minConfidence;
    const indicator = this.lowConfidence ? 0 : 1;
    this.confFilt += (indicator - this.confFilt) * Math.min(1, dt / GAZE.lowConfTau);
    const bMid = 0.5 * (p.bMin + p.bMax);
    const goal = this.confFilt * this.last.bTarget + (1 - this.confFilt) * bMid;
    const maxStep = p.slewRate * dt;
    const delta = Math.min(maxStep, Math.max(-maxStep, goal - this.b));
    // keep b inside [bMin, bMax] with bMin >= 0: the damper can only dissipate (CONTROL.md §5.5)
    this.b = Math.min(p.bMax, Math.max(Math.max(0, p.bMin), this.b + delta));
    return this.b;
  }
}
