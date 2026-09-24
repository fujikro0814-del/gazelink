// Wave-variable transformation (Niemeyer & Slotine), per axis (docs/CONTROL.md §4.3).
import type { Vec3 } from '../math/vec.ts';

/**
 * Master side: given master velocity and the returning wave v (from the slave), return the force
 * the master applies to the channel (F_m; the channel applies -F_m on the master) and the forward wave u_m.
 */
export function waveMaster(vm: Vec3, vIn: Vec3, b: number): { Fm: Vec3; um: Vec3 } {
  const s = Math.sqrt(2 * b);
  const Fm: Vec3 = [0, 0, 0];
  const um: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    Fm[i] = b * vm[i] - s * vIn[i];
    um[i] = s * vm[i] - vIn[i];
  }
  return { Fm, um };
}

/**
 * Slave side: given the incoming wave u (from the master) and the coupling force f_c, return the
 * velocity command v_d and the returning wave v_s.
 */
export function waveSlave(uIn: Vec3, fc: Vec3, b: number): { vd: Vec3; vs: Vec3 } {
  const s = Math.sqrt(2 * b);
  const vd: Vec3 = [0, 0, 0];
  const vs: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    vd[i] = (s * uIn[i] - fc[i]) / b;
    vs[i] = uIn[i] - Math.sqrt(2 / b) * fc[i];
  }
  return { vd, vs };
}
