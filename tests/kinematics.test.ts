import { describe, expect, it } from 'vitest';
import {
  Q_INIT,
  Q_MAX,
  Q_MIN,
  flangePose,
  forwardFrames,
  ikStep,
  jacobian,
  tcpPosition,
  translation,
} from '../core/sim/kinematics.ts';
import { ENV } from '../core/config.ts';
import { dist, type Vec3 } from '../core/math/vec.ts';

describe('Panda forward kinematics', () => {
  it('zero configuration: flange at (0.088, 0, 0.926)', () => {
    // Straight-up arm: z = 0.333 + 0.316 + 0.384 - 0.107, x = a7 = 0.088 (a4 + a5 cancel).
    const p = translation(flangePose([0, 0, 0, 0, 0, 0, 0]));
    expect(p[0]).toBeCloseTo(0.088, 6);
    expect(p[1]).toBeCloseTo(0, 6);
    expect(p[2]).toBeCloseTo(0.926, 6);
  });

  it('ready pose: flange at about (0.307, 0, 0.590), pointing down', () => {
    // Franka's documented ready pose puts the Franka Hand TCP at about (0.307, 0, 0.487);
    // the flange is 0.1034 m above it.
    const F = flangePose(Q_INIT);
    expect(F[3]).toBeCloseTo(0.3069, 3);
    expect(F[7]).toBeCloseTo(0, 6);
    expect(F[11]).toBeCloseTo(0.5903, 3);
    // flange z axis points straight down
    expect(F[2]).toBeCloseTo(0, 6);
    expect(F[6]).toBeCloseTo(0, 6);
    expect(F[10]).toBeCloseTo(-1, 6);
    const tcp = tcpPosition(Q_INIT);
    expect(tcp[2]).toBeCloseTo(0.4869, 3);
  });

  it('Jacobian matches finite differences', () => {
    const q = [0.3, -0.5, 0.2, -2.0, 0.1, 1.8, 0.6];
    const J = jacobian(forwardFrames(q), ENV.tcpOffset);
    const h = 1e-7;
    for (let i = 0; i < 7; i++) {
      const qp = [...q];
      qp[i] += h;
      const a = tcpPosition(q);
      const b = tcpPosition(qp);
      for (let r = 0; r < 3; r++) expect(J[r][i]).toBeCloseTo((b[r] - a[r]) / h, 5);
    }
  });
});

describe('DLS inverse kinematics', () => {
  it('tracks a moving target within 1 mm', () => {
    const q = [...Q_INIT];
    const start = tcpPosition(q);
    let maxErr = 0;
    // 1 kHz, one IK iteration per step, circle of radius 0.12 m at 0.5 Hz
    for (let k = 0; k < 4000; k++) {
      const t = k * 0.001;
      const target: Vec3 = [
        start[0] + 0.12 * Math.sin(2 * Math.PI * 0.5 * t),
        start[1] + 0.12 * (1 - Math.cos(2 * Math.PI * 0.5 * t)),
        start[2] - 0.1 * Math.min(1, t),
      ];
      const info = ikStep(q, target);
      if (k > 200) maxErr = Math.max(maxErr, info.posError);
    }
    expect(maxErr).toBeLessThan(1e-3);
    for (let i = 0; i < 7; i++) {
      expect(q[i]).toBeGreaterThanOrEqual(Q_MIN[i]);
      expect(q[i]).toBeLessThanOrEqual(Q_MAX[i]);
    }
  });

  it('converges to a static target across the workspace and keeps the tool pointing down', () => {
    const targets: Vec3[] = [
      [0.55, 0.25, 0.05],
      [0.45, -0.3, 0.35],
      [0.7, 0.0, 0.2],
      [0.3, 0.0, 0.6],
    ];
    for (const target of targets) {
      const q = [...Q_INIT];
      for (let k = 0; k < 3000; k++) ikStep(q, target);
      expect(dist(tcpPosition(q), target)).toBeLessThan(1e-3);
      const F = flangePose(q);
      expect(F[10]).toBeLessThan(-0.99);
    }
  });

  it('stays finite and bounded when asked to reach beyond the workspace (singularity)', () => {
    const q = [...Q_INIT];
    let last = { manipulability: 1, lambda: 0, posError: 0, atLimit: false };
    for (let k = 0; k < 3000; k++) last = ikStep(q, [1.4, 0, 0.3]);
    expect(q.every(Number.isFinite)).toBe(true);
    expect(last.lambda).toBeGreaterThan(0.001);
    // it should still get as close as it can (reach ~0.85 m horizontally)
    expect(tcpPosition(q)[0]).toBeGreaterThan(0.75);
  });
});
