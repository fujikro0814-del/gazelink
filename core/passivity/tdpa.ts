// Time-domain passivity observers / controllers for the delayed channel (docs/CONTROL.md §4.2),
// after Ryu, Artigas & Preusche (2010).
import type { Vec3 } from '../math/vec.ts';
import { dot3 } from './energy.ts';

const EPS = 1e-9;

export interface SlavePcResult {
  /** velocity command actually emitted at the slave port */
  vd: Vec3;
  /** energy removed by the PC in this step [J] */
  dissipated: number;
  /** observer value after this step (>= 0 when the PC is active) */
  observer: number;
}

/**
 * Slave-side admittance-type PC (series): the channel outputs velocity, receives force f_c.
 * Output power is f_c . v_d. If emitting v_ref would push the output energy above what arrived
 * from the master (eInRcvd), subtract beta * f_c so the observer lands exactly on zero.
 */
export function slavePc(fc: Vec3, vRef: Vec3, eInRcvd: number, eOutPrev: number, dt: number): SlavePcResult {
  const pOut = dot3(fc, vRef);
  const w = eInRcvd - eOutPrev - Math.max(0, pOut) * dt;
  const f2 = dot3(fc, fc);
  if (w >= 0 || f2 < EPS) {
    return { vd: [vRef[0], vRef[1], vRef[2]], dissipated: 0, observer: w };
  }
  const beta = -w / (dt * f2);
  return {
    vd: [vRef[0] - beta * fc[0], vRef[1] - beta * fc[1], vRef[2] - beta * fc[2]],
    dissipated: -w,
    observer: 0,
  };
}

export interface MasterPcResult {
  /** force applied by the channel on the master */
  fm: Vec3;
  dissipated: number;
  observer: number;
  /** variable damping used [N s/m] */
  alpha: number;
}

/**
 * Master-side impedance-type PC (parallel damper): the channel receives velocity v_m and outputs
 * force f_m on the master. Output power is f_m . v_m; if it would exceed the energy that arrived
 * from the slave (eInRcvd), add damping -alpha * v_m.
 */
export function masterPc(fRef: Vec3, vm: Vec3, eInRcvd: number, eOutPrev: number, dt: number): MasterPcResult {
  const pOut = dot3(fRef, vm);
  const w = eInRcvd - eOutPrev - Math.max(0, pOut) * dt;
  const v2 = dot3(vm, vm);
  if (w >= 0 || v2 < EPS) {
    return { fm: [fRef[0], fRef[1], fRef[2]], dissipated: 0, observer: w, alpha: 0 };
  }
  const alpha = -w / (dt * v2);
  return {
    fm: [fRef[0] - alpha * vm[0], fRef[1] - alpha * vm[1], fRef[2] - alpha * vm[2]],
    dissipated: -w,
    observer: 0,
    alpha,
  };
}

/**
 * Drift-compensation velocity limited by an energy budget: the extra output energy
 * max(0, f_c . v_drift) * dt may use at most `budget` of the current observer surplus.
 */
export function budgetedDrift(fc: Vec3, posError: Vec3, gain: number, surplus: number, budget: number, dt: number): Vec3 {
  const v: Vec3 = [gain * posError[0], gain * posError[1], gain * posError[2]];
  const extra = Math.max(0, dot3(fc, v)) * dt;
  const allowed = Math.max(0, surplus) * budget;
  if (extra <= allowed || extra <= 0) return v;
  const s = allowed / extra;
  return [v[0] * s, v[1] * s, v[2] * s];
}
