import { describe, expect, it } from 'vitest';
import { runTrial, scriptedHand } from '../core/sim/experiment.ts';
import { OfflineTeleop } from '../core/sim/teleop.ts';
import { NET_DEFAULTS } from '../core/config.ts';
import { masterPc, slavePc, budgetedDrift } from '../core/passivity/tdpa.ts';
import { waveMaster, waveSlave } from '../core/passivity/wave.ts';
import { PortEnergy } from '../core/passivity/energy.ts';
import type { Vec3 } from '../core/math/vec.ts';

const dt = 0.001;

describe('TDPA controllers (one step)', () => {
  it('slave PC removes exactly the energy deficit', () => {
    const fc: Vec3 = [10, -5, 2];
    const vRef: Vec3 = [0.3, -0.1, 0.05];
    const eOutPrev = 1.0;
    const eIn = 1.0005; // not enough for this step's output f.v*dt = 3.6e-3
    const r = slavePc(fc, vRef, eIn, eOutPrev, dt);
    const out = (fc[0] * r.vd[0] + fc[1] * r.vd[1] + fc[2] * r.vd[2]) * dt;
    expect(eOutPrev + out).toBeCloseTo(eIn, 12);
    expect(r.observer).toBe(0);
    expect(r.dissipated).toBeGreaterThan(0);
  });

  it('slave PC is inactive while there is enough energy', () => {
    const r = slavePc([1, 0, 0], [0.1, 0, 0], 5, 1, dt);
    expect(r.vd).toEqual([0.1, 0, 0]);
    expect(r.dissipated).toBe(0);
  });

  it('master PC adds exactly the damping needed', () => {
    const fRef: Vec3 = [-8, 3, 0];
    const vm: Vec3 = [-0.4, 0.2, 0];
    const eOutPrev = 2;
    const eIn = 2.001;
    const r = masterPc(fRef, vm, eIn, eOutPrev, dt);
    const out = (r.fm[0] * vm[0] + r.fm[1] * vm[1] + r.fm[2] * vm[2]) * dt;
    expect(eOutPrev + out).toBeCloseTo(eIn, 12);
    expect(r.alpha).toBeGreaterThan(0);
  });

  it('a deficit carried over from earlier only stops the output, never reverses or amplifies it', () => {
    // 98 J more out than in (e.g., "none" before a mode switch) and a tiny velocity
    const fRef: Vec3 = [-80, 20, 0];
    const vm: Vec3 = [-1e-3, 2e-4, 0];
    const r = masterPc(fRef, vm, 0, 98, dt);
    const out = r.fm[0] * vm[0] + r.fm[1] * vm[1] + r.fm[2] * vm[2];
    expect(out).toBeCloseTo(0, 9); // no energy leaves this step
    expect(Math.hypot(...r.fm)).toBeLessThanOrEqual(Math.hypot(...fRef) + 1e-9); // bounded force
    const fc: Vec3 = [60, -10, 5];
    const s = slavePc(fc, [0.2, 0.01, 0], 0, 50, dt);
    expect(fc[0] * s.vd[0] + fc[1] * s.vd[1] + fc[2] * s.vd[2]).toBeCloseTo(0, 9);
    expect(Math.hypot(...s.vd)).toBeLessThanOrEqual(Math.hypot(0.2, 0.01, 0) + 1e-9);
  });

  it('drift compensation never spends more than its share of the surplus', () => {
    const fc: Vec3 = [20, 0, 0];
    const v = budgetedDrift(fc, [0.05, 0, 0], 4, 1e-4, 0.5, dt);
    expect(fc[0] * v[0] * dt).toBeCloseTo(0.5e-4, 12);
    const free = budgetedDrift(fc, [-0.05, 0, 0], 4, 0, 0.5, dt); // absorbs energy: allowed
    expect(free[0]).toBeCloseTo(-0.2, 12);
  });

  it('port energy splits inflow and outflow', () => {
    const e = new PortEnergy();
    e.add(3, dt);
    e.add(-2, dt);
    expect(e.in).toBeCloseTo(0.003, 12);
    expect(e.out).toBeCloseTo(0.002, 12);
  });
});

describe('wave variables', () => {
  it('port power equals (u^2 - v^2)/2 on both sides', () => {
    const b = 40;
    const vm: Vec3 = [0.2, -0.1, 0.05];
    const vIn: Vec3 = [0.5, 0.3, -0.2];
    const m = waveMaster(vm, vIn, b);
    for (let i = 0; i < 3; i++) expect(m.Fm[i] * vm[i]).toBeCloseTo((m.um[i] ** 2 - vIn[i] ** 2) / 2, 12);
    const fc: Vec3 = [3, -1, 2];
    const s = waveSlave(m.um, fc, b);
    for (let i = 0; i < 3; i++) expect(fc[i] * s.vd[i]).toBeCloseTo((m.um[i] ** 2 - s.vs[i] ** 2) / 2, 12);
  });
});

describe('bilateral control under delay (scripted wall press, gaze adaptation off)', () => {
  it('"none" does not oscillate at 0 / 50 / 100 ms', () => {
    for (const delayMs of [0, 50, 100]) {
      const r = runTrial({ mode: 'none', delayMs, gaze: false });
      expect(r.oscillating, `none @ ${delayMs} ms`).toBe(false);
    }
  });

  it('"none" oscillates at 200 ms and above, and the channel generates energy', () => {
    for (const delayMs of [200, 400, 800]) {
      const r = runTrial({ mode: 'none', delayMs, gaze: false });
      expect(r.oscillating, `none @ ${delayMs} ms`).toBe(true);
      expect(r.eGenMax, `none @ ${delayMs} ms`).toBeGreaterThan(0.5);
    }
  });

  it('TDPA suppresses the oscillation and keeps the channel passive (E_gen <= 0 at every step)', () => {
    for (const delayMs of [200, 400, 800]) {
      const r = runTrial({ mode: 'tdpa', delayMs, gaze: false });
      expect(r.oscillating, `tdpa @ ${delayMs} ms`).toBe(false);
      expect(r.eGenMax, `tdpa @ ${delayMs} ms`).toBeLessThanOrEqual(1e-9);
      expect(r.eDiss).toBeGreaterThan(0);
    }
  });

  it('TDPA stays passive with jitter and bursty loss as well', () => {
    const r = runTrial({ mode: 'tdpa', delayMs: 300, jitterMs: 40, loss: 0.1, gaze: false, seed: 5 });
    expect(r.oscillating).toBe(false);
    expect(r.eGenMax).toBeLessThanOrEqual(1e-9);
  });

  it('switching from an energy-generating "none" to TDPA mid-contact causes no force spike', () => {
    const sim = new OfflineTeleop({ mode: 'none', gazeEnabled: false, net: { ...NET_DEFAULTS, delayMs: 400 } });
    const home = sim.slave.home;
    let maxFcAfter = 0;
    let eGenMaxAfter = -Infinity;
    for (let k = 0; k < 14000; k++) {
      const t = k / 1000;
      sim.setHand(scriptedHand(t, home));
      if (k === 7000) {
        expect(sim.slave.eGen).toBeGreaterThan(0.5); // "none" has been generating energy
        sim.switchMode('tdpa');
      }
      sim.step();
      if (k > 7000) {
        const fc = sim.slave.fc;
        maxFcAfter = Math.max(maxFcAfter, Math.hypot(fc[0], fc[1], fc[2]));
        eGenMaxAfter = Math.max(eGenMaxAfter, sim.slave.eGen);
      }
    }
    expect(maxFcAfter).toBeLessThan(80);
    expect(eGenMaxAfter).toBeLessThanOrEqual(1e-9);
  });

  it('wave variables stay stable across delays', () => {
    for (const delayMs of [50, 200, 800]) {
      const r = runTrial({ mode: 'wave', delayMs, gaze: false });
      expect(r.oscillating, `wave @ ${delayMs} ms`).toBe(false);
      expect(r.maxForce).toBeLessThan(40);
    }
  });
}, 60_000);
