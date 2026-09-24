// Franka Panda kinematics: modified (Craig) DH forward kinematics, geometric Jacobian,
// and a damped-least-squares IK step with singularity-adaptive damping.
import { KIN, ENV } from '../config.ts';
import { aat, atv, av, solve } from '../math/linalg.ts';
import type { Vec3 } from '../math/vec.ts';

export const DOF = 7;

/** Modified DH rows (a_{i-1}, d_i, alpha_{i-1}); index 7 is the flange (theta = 0). */
export const PANDA_MDH: ReadonlyArray<{ a: number; d: number; alpha: number }> = [
  { a: 0, d: 0.333, alpha: 0 },
  { a: 0, d: 0, alpha: -Math.PI / 2 },
  { a: 0, d: 0.316, alpha: Math.PI / 2 },
  { a: 0.0825, d: 0, alpha: Math.PI / 2 },
  { a: -0.0825, d: 0.384, alpha: -Math.PI / 2 },
  { a: 0, d: 0, alpha: Math.PI / 2 },
  { a: 0.088, d: 0, alpha: Math.PI / 2 },
  { a: 0, d: 0.107, alpha: 0 },
];

export const Q_MIN = [-2.8973, -1.7628, -2.8973, -3.0718, -2.8973, -0.0175, -2.8973];
export const Q_MAX = [2.8973, 1.7628, 2.8973, -0.0698, 2.8973, 3.7525, 2.8973];

/** Initial ("ready") configuration from the task specification. */
export const Q_INIT = [0, -Math.PI / 4, 0, (-3 * Math.PI) / 4, 0, Math.PI / 2, Math.PI / 4];

/** 4x4 homogeneous transform, row-major, length 16. */
export type Mat4 = Float64Array;

function mdh(a: number, d: number, alpha: number, theta: number): Mat4 {
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const ca = Math.cos(alpha);
  const sa = Math.sin(alpha);
  // RotX(alpha) * TransX(a) * RotZ(theta) * TransZ(d)
  return Float64Array.of(
    ct, -st, 0, a,
    st * ca, ct * ca, -sa, -d * sa,
    st * sa, ct * sa, ca, d * ca,
    0, 0, 0, 1,
  );
}

export function mul4(A: Mat4, B: Mat4): Mat4 {
  const C = new Float64Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += A[i * 4 + k] * B[k * 4 + j];
      C[i * 4 + j] = s;
    }
  }
  return C;
}

export const translation = (T: Mat4): Vec3 => [T[3], T[7], T[11]];
export const zAxis = (T: Mat4): Vec3 => [T[2], T[6], T[10]];

/** Returns frames T_1..T_7 (joint frames) followed by the flange frame (length 8). */
export function forwardFrames(q: ArrayLike<number>): Mat4[] {
  const frames: Mat4[] = [];
  let T: Mat4 = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  for (let i = 0; i < 8; i++) {
    const p = PANDA_MDH[i];
    T = mul4(T, mdh(p.a, p.d, p.alpha, i < 7 ? q[i] : 0));
    frames.push(T);
  }
  return frames;
}

export function flangePose(q: ArrayLike<number>): Mat4 {
  return forwardFrames(q)[7];
}

/** Tool point: flange origin + tcpOffset along the flange z axis. */
export function tcpPosition(q: ArrayLike<number>, tcpOffset: number = ENV.tcpOffset): Vec3 {
  const F = flangePose(q);
  return [F[3] + tcpOffset * F[2], F[7] + tcpOffset * F[6], F[11] + tcpOffset * F[10]];
}

/** 6x7 geometric Jacobian of the tool point (rows: vx vy vz wx wy wz). */
export function jacobian(frames: Mat4[], tcpOffset: number): number[][] {
  const F = frames[7];
  const pe: Vec3 = [F[3] + tcpOffset * F[2], F[7] + tcpOffset * F[6], F[11] + tcpOffset * F[10]];
  const J: number[][] = [[], [], [], [], [], []];
  for (let i = 0; i < DOF; i++) {
    const z = zAxis(frames[i]);
    const p = translation(frames[i]);
    const r: Vec3 = [pe[0] - p[0], pe[1] - p[1], pe[2] - p[2]];
    const lin: Vec3 = [z[1] * r[2] - z[2] * r[1], z[2] * r[0] - z[0] * r[2], z[0] * r[1] - z[1] * r[0]];
    J[0][i] = lin[0];
    J[1][i] = lin[1];
    J[2][i] = lin[2];
    J[3][i] = z[0];
    J[4][i] = z[1];
    J[5][i] = z[2];
  }
  return J;
}

/** Rotation part (row-major 3x3) of a transform. */
export function rotation(T: Mat4): number[] {
  return [T[0], T[1], T[2], T[4], T[5], T[6], T[8], T[9], T[10]];
}

/** Small-angle orientation error vector taking R toward Rd (both row-major 3x3). */
function orientationError(R: number[], Rd: number[]): Vec3 {
  // 0.5 * sum_i (r_i x rd_i) over the column vectors
  const e: Vec3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const r: Vec3 = [R[c], R[3 + c], R[6 + c]];
    const d: Vec3 = [Rd[c], Rd[3 + c], Rd[6 + c]];
    e[0] += 0.5 * (r[1] * d[2] - r[2] * d[1]);
    e[1] += 0.5 * (r[2] * d[0] - r[0] * d[2]);
    e[2] += 0.5 * (r[0] * d[1] - r[1] * d[0]);
  }
  return e;
}

/** Fixed tool orientation: the flange orientation of the initial pose (pointing down). */
export const R_DOWN = rotation(flangePose(Q_INIT));

export interface IkInfo {
  /** Manipulability sqrt(det(J J^T)). */
  manipulability: number;
  /** Damping used in this step. */
  lambda: number;
  /** Remaining position error [m]. */
  posError: number;
  /** True if any joint was clamped to its limit. */
  atLimit: boolean;
}

/**
 * One damped-least-squares IK iteration toward the tool target position with fixed downward
 * orientation. The damping grows smoothly as manipulability drops below the threshold
 * (Nakamura/Hanafusa style), and a null-space term pulls toward Q_INIT.
 * Writes the result into q and returns diagnostics.
 */
export function ikStep(q: number[], target: Vec3, tcpOffset: number = ENV.tcpOffset): IkInfo {
  const frames = forwardFrames(q);
  const F = frames[7];
  const pe: Vec3 = [F[3] + tcpOffset * F[2], F[7] + tcpOffset * F[6], F[11] + tcpOffset * F[10]];
  const ep: Vec3 = [target[0] - pe[0], target[1] - pe[1], target[2] - pe[2]];
  const posError = Math.hypot(ep[0], ep[1], ep[2]);
  // Clamp the task-space error so a far/unreachable target yields a small, well-conditioned step.
  if (posError > KIN.maxStepPos) {
    const s = KIN.maxStepPos / posError;
    ep[0] *= s;
    ep[1] *= s;
    ep[2] *= s;
  }
  const eo = orientationError(rotation(F), R_DOWN);
  const w = KIN.orientWeight;
  const e = [ep[0], ep[1], ep[2], w * eo[0], w * eo[1], w * eo[2]];

  const J = jacobian(frames, tcpOffset);
  for (let k = 0; k < DOF; k++) {
    J[3][k] *= w;
    J[4][k] *= w;
    J[5][k] *= w;
  }
  const JJt = aat(J);
  const manip = Math.sqrt(Math.max(0, solve(JJt, [0, 0, 0, 0, 0, 0]).det)) / (w * w * w);
  const ratio = Math.min(1, manip / KIN.manipThreshold);
  const lambda = KIN.lambdaMin + (KIN.lambdaMax - KIN.lambdaMin) * (1 - ratio) * (1 - ratio);
  const A = JJt.map((row, i) => row.map((v, j) => (i === j ? v + lambda * lambda : v)));

  // primary task: dq1 = J^T (J J^T + l^2 I)^-1 e
  const dq1 = atv(J, solve(A, e).x);
  // null-space posture: (I - J# J) k (q0 - q)
  const z = Q_INIT.map((q0, i) => KIN.nullGain * (q0 - q[i]));
  const Jz = av(J, z);
  const proj = atv(J, solve(A, Jz).x);

  const dq = dq1.map((v, i) => v + z[i] - proj[i]);
  const maxAbs = Math.max(...dq.map(Math.abs));
  const dqScale = maxAbs > KIN.maxStepJoint ? KIN.maxStepJoint / maxAbs : 1;

  let atLimit = false;
  for (let i = 0; i < DOF; i++) {
    let qi = q[i] + dq[i] * dqScale;
    if (qi < Q_MIN[i]) {
      qi = Q_MIN[i];
      atLimit = true;
    } else if (qi > Q_MAX[i]) {
      qi = Q_MAX[i];
      atLimit = true;
    }
    q[i] = qi;
  }
  return { manipulability: manip, lambda, posError, atLimit };
}
