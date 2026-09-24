// Time-domain passivity observers / controllers for the delayed channel (docs/CONTROL.md §4.2),
// after Ryu, Artigas & Preusche (2010).
//
// Both controllers only ever *shrink* this step's output toward zero: the energy they may emit in
// a step is max(0, E_in_received - E_out_so_far). A deficit carried over from earlier (e.g., a
// mode switch arriving before the energy counters are restarted) therefore stops the output
// instead of being "repaid" with an unbounded correction, and the corrected velocity / force
// never exceeds the uncorrected one.
import type { Vec3 } from '../math/vec.ts';
import { dot3 } from './energy.ts';

const EPS = 1e-9;

export interface SlavePcResult {
  /** velocity command actually emitted at the slave port */
  vd: Vec3;
  /** energy removed by the PC in this step [J] */
  dissipated: number;
  /** observer value W = E_in - E_out after this step */
  observer: number;
}

/**
 * Slave-side admittance-type PC (series): the channel outputs velocity, receives force f_c.
 * Output power is f_c . v_d. If emitting v_ref would push the output energy above what arrived
 * from the master (eInRcvd), subtract beta * f_c so the output lands exactly on the allowance.
 */
export function slavePc(fc: Vec3, vRef: Vec3, eInRcvd: number, eOutPrev: number, dt: number): SlavePcResult {
  const need = Math.max(0, dot3(fc, vRef)) * dt;
  const allowance = Math.max(0, eInRcvd - eOutPrev);
  const f2 = dot3(fc, fc);
  if (need <= allowance || f2 < EPS) {
    return { vd: [vRef[0], vRef[1], vRef[2]], dissipated: 0, observer: eInRcvd - eOutPrev - need };
  }
  // beta * |f|^2 * dt = need - allowance  (0 < beta * |f|^2 <= f.v_ref, so |v_d . f| <= |v_ref . f|)
  const beta = (need - allowance) / (dt * f2);
  return {
    vd: [vRef[0] - beta * fc[0], vRef[1] - beta * fc[1], vRef[2] - beta * fc[2]],
    dissipated: need - allowance,
    observer: eInRcvd - eOutPrev - allowance,
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
  const need = Math.max(0, dot3(fRef, vm)) * dt;
  const allowance = Math.max(0, eInRcvd - eOutPrev);
  const v2 = dot3(vm, vm);
  if (need <= allowance || v2 < EPS) {
    return { fm: [fRef[0], fRef[1], fRef[2]], dissipated: 0, observer: eInRcvd - eOutPrev - need, alpha: 0 };
  }
  const alpha = (need - allowance) / (dt * v2);
  return {
    fm: [fRef[0] - alpha * vm[0], fRef[1] - alpha * vm[1], fRef[2] - alpha * vm[2]],
    dissipated: need - allowance,
    observer: eInRcvd - eOutPrev - allowance,
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
