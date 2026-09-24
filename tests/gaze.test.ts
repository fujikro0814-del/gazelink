import { describe, expect, it } from 'vitest';
import { GazeHistory, attentionAt } from '../core/gaze/attention.ts';
import { GazeDamping, dampingLaw, defaultGazeParams } from '../core/gaze/damping.ts';
import { DEFAULT_ENV } from '../core/sim/env.ts';
import { SlaveSim } from '../core/sim/slave.ts';
import { GAZE } from '../core/config.ts';
import type { Vec3 } from '../core/math/vec.ts';

const dt = 0.001;
const TARGET: Vec3 = [0.53, 0.21, 0.08]; // above the target box, far from the wall
const ELSEWHERE: Vec3 = [0.3, -0.35, 0.1];

function historyAt(p: Vec3, from: number, to: number, conf = 1): GazeHistory {
  const h = new GazeHistory(2.0);
  for (let t = from; t <= to; t += 1 / 30) h.add({ t, p, conf });
  return h;
}

describe('attention field', () => {
  it('is high where the gaze has been and low elsewhere', () => {
    const h = historyAt(TARGET, 0, 2);
    expect(attentionAt(h, TARGET, 2, 0.08)).toBeGreaterThan(0.95);
    expect(attentionAt(h, ELSEWHERE, 2, 0.08)).toBeLessThan(0.01);
  });

  it('forgets exponentially: after the gaze moves away, old attention fades with the time constant', () => {
    const h = historyAt(TARGET, 0, 2);
    for (let t = 2; t <= 4; t += 1 / 30) h.add({ t, p: ELSEWHERE, conf: 1 });
    // 2 s later with tau = 2 s, the old samples weigh e^-1 relative to... their share has dropped
    const a = attentionAt(h, TARGET, 4, 0.08);
    expect(a).toBeGreaterThan(0.2);
    expect(a).toBeLessThan(0.5);
    const shortMemory = new GazeHistory(0.3);
    shortMemory.samples.push(...h.samples);
    expect(attentionAt(shortMemory, TARGET, 4, 0.08)).toBeLessThan(0.02);
  });

  it('prunes samples that no longer matter', () => {
    const h = historyAt(TARGET, 0, 20);
    h.prune(20);
    const oldest = h.samples[0].t;
    expect(20 - oldest).toBeLessThanOrEqual(Math.min(GAZE.historyHorizon, 5 * h.forgetTau) + 1e-9);
  });
});

describe('damping law', () => {
  const p = defaultGazeParams();
  it('is light where attention is (and away from obstacles)', () => {
    const h = historyAt(TARGET, 0, 2);
    const r = dampingLaw(h, TARGET, DEFAULT_ENV, p, 2);
    expect(r.bTarget).toBeLessThan(p.bMin + 0.1 * (p.bMax - p.bMin));
  });
  it('is heavy outside attention', () => {
    const h = historyAt(TARGET, 0, 2);
    const r = dampingLaw(h, ELSEWHERE, DEFAULT_ENV, p, 2);
    expect(r.bTarget).toBeGreaterThan(p.bMax - 0.05 * (p.bMax - p.bMin));
  });
  it('is heavier next to the wall even where the operator looks', () => {
    const nearWall: Vec3 = [0.6, -0.16, 0.3]; // 2 cm from the wall face
    const h = historyAt(nearWall, 0, 2);
    const far = dampingLaw(historyAt(TARGET, 0, 2), TARGET, DEFAULT_ENV, p, 2).bTarget;
    const near = dampingLaw(h, nearWall, DEFAULT_ENV, p, 2).bTarget;
    expect(near).toBeGreaterThan(far + 0.4 * (p.bMax - p.bMin));
  });
  it('always stays within [B_MIN, B_MAX] with B_MIN >= 0 (passivity, CONTROL.md 5.6)', () => {
    const h = historyAt(TARGET, 0, 2);
    for (let x = 0.1; x < 0.8; x += 0.05)
      for (let y = -0.4; y < 0.4; y += 0.05) {
        const b = dampingLaw(h, [x, y, 0.2], DEFAULT_ENV, p, 2).bTarget;
        expect(b).toBeGreaterThanOrEqual(p.bMin);
        expect(b).toBeLessThanOrEqual(p.bMax);
      }
  });
});

describe('slew-rate limited b(t)', () => {
  it('respects the rate limit', () => {
    const g = new GazeDamping(defaultGazeParams());
    const h = historyAt(TARGET, 0, 3);
    let prev = g.b;
    for (let k = 0; k < 2000; k++) {
      const b = g.step(h, ELSEWHERE, DEFAULT_ENV, 3, 1, dt);
      expect(Math.abs(b - prev)).toBeLessThanOrEqual(g.params.slewRate * dt + 1e-9);
      prev = b;
    }
    expect(prev).toBeGreaterThan(g.params.bMax - 1); // reached the heavy level
  });

  it('returns smoothly to mid-range when the gaze confidence drops', () => {
    const g = new GazeDamping(defaultGazeParams());
    const h = historyAt(TARGET, 0, 3);
    for (let k = 0; k < 2000; k++) g.step(h, TARGET, DEFAULT_ENV, 3, 1, dt); // light
    expect(g.b).toBeLessThan(10);
    for (let k = 0; k < 3000; k++) g.step(h, TARGET, DEFAULT_ENV, 3, 0, dt); // blink / face lost
    const mid = (g.params.bMin + g.params.bMax) / 2;
    expect(Math.abs(g.b - mid)).toBeLessThan(1);
  });

  it('resets its state to B_MIN at the start of a trial (RESET)', () => {
    const s = new SlaveSim();
    s.damping.setParams({ ...defaultGazeParams(), enabled: true });
    // look away from the tip for a while -> b climbs to B_MAX
    for (let k = 0; k < 3000; k++) {
      if (k % 33 === 0) s.receiveGaze(ELSEWHERE, 1, s.t);
      s.step(dt);
    }
    expect(s.b).toBeGreaterThan(s.damping.params.bMax - 1);
    s.reset();
    expect(s.b).toBe(s.damping.params.bMin);
    expect(s.damping.b).toBe(s.damping.params.bMin);
  });

  it('resets its state to B_MIN when the control mode is switched', () => {
    const s = new SlaveSim();
    for (let k = 0; k < 3000; k++) {
      if (k % 33 === 0) s.receiveGaze(ELSEWHERE, 1, s.t);
      s.step(dt);
    }
    expect(s.b).toBeGreaterThan(40);
    s.setMode('tdpa');
    expect(s.b).toBe(s.damping.params.bMin);
    // ... and it then rises again from B_MIN at the slew rate, not from the old value
    s.step(dt);
    expect(s.b - s.damping.params.bMin).toBeLessThanOrEqual(s.damping.params.slewRate * dt + 1e-9);
  });

  it('is constant B_MIN when the adaptation is disabled', () => {
    const g = new GazeDamping({ ...defaultGazeParams(), enabled: false });
    const h = historyAt(TARGET, 0, 3);
    for (let k = 0; k < 500; k++) expect(g.step(h, ELSEWHERE, DEFAULT_ENV, 3, 1, dt)).toBe(g.params.bMin);
  });
});
