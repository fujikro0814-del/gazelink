import { describe, expect, it } from 'vitest';
import { HandJog, JOG_CODES, noKeys } from '../src/scene/jog.ts';
import { JOG } from '../core/config.ts';

const dt = 1 / 120;
const FWD: [number, number] = [1, 0]; // camera looks along robot +x

function run(jog: HandJog, keys: ReturnType<typeof noKeys>, seconds: number, forward = FWD) {
  const speeds: number[] = [];
  const pos = [0, 0, 0];
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    const d = jog.step(dt, keys, forward);
    pos[0] += d[0];
    pos[1] += d[1];
    pos[2] += d[2];
    speeds.push(Math.hypot(...jog.v));
  }
  return { speeds, pos };
}

describe('keyboard jogging', () => {
  it('ramps up smoothly: 10-90 % rise between 0.1 and 0.2 s, no step', () => {
    const jog = new HandJog();
    const { speeds } = run(jog, { ...noKeys(), forward: true }, 0.6);
    const vmax = JOG.speed;
    expect(speeds[0]).toBeLessThan(0.2 * vmax); // first frame: far from a step
    const t10 = speeds.findIndex((s) => s >= 0.1 * vmax) * dt;
    const t90 = speeds.findIndex((s) => s >= 0.9 * vmax) * dt;
    expect(t90 - t10).toBeGreaterThan(0.1);
    expect(t90 - t10).toBeLessThan(0.2);
    expect(speeds[speeds.length - 1]).toBeCloseTo(vmax, 3);
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]).toBeGreaterThanOrEqual(speeds[i - 1] - 1e-12); // monotone
  });

  it('ramps down smoothly after release', () => {
    const jog = new HandJog();
    run(jog, { ...noKeys(), forward: true }, 0.6);
    const { speeds } = run(jog, noKeys(), 0.5);
    expect(speeds[0]).toBeGreaterThan(0.8 * JOG.speed); // no instant stop
    const t10 = speeds.findIndex((s) => s <= 0.1 * JOG.speed) * dt;
    expect(t10).toBeGreaterThan(0.1);
    expect(t10).toBeLessThan(0.2);
  });

  it('comes to a complete stop (no endless creeping) after release', () => {
    const jog = new HandJog();
    run(jog, { ...noKeys(), up: true }, 0.5);
    run(jog, noKeys(), 0.8);
    expect(jog.v).toEqual([0, 0, 0]);
    expect(jog.step(dt, noKeys(), FWD)).toEqual([0, 0, 0]);
  });

  it('Shift slows down to the precision speed', () => {
    const jog = new HandJog();
    const { speeds } = run(jog, { ...noKeys(), forward: true, slow: true }, 0.8);
    expect(speeds[speeds.length - 1]).toBeCloseTo(JOG.speed * JOG.slowFactor, 4);
  });

  it('moves relative to the view: W forward, D right, Q up; diagonals are not faster', () => {
    const view: [number, number] = [0, 1]; // camera looks along robot +y
    const w = run(new HandJog(), { ...noKeys(), forward: true }, 0.5, view).pos;
    expect(w[1]).toBeGreaterThan(0.05);
    expect(Math.abs(w[0])).toBeLessThan(1e-9);
    const d = run(new HandJog(), { ...noKeys(), right: true }, 0.5, view).pos;
    expect(d[0]).toBeGreaterThan(0.05); // right of +y (z up) is +x
    const q = run(new HandJog(), { ...noKeys(), up: true }, 0.5, view).pos;
    expect(q[2]).toBeGreaterThan(0.05);
    const diag = run(new HandJog(), { ...noKeys(), forward: true, right: true }, 0.8, view);
    expect(diag.speeds[diag.speeds.length - 1]).toBeCloseTo(JOG.speed, 3);
  });

  it('maps physical key codes (Shift does not change the key)', () => {
    expect(JOG_CODES.KeyW).toBe('forward');
    expect(JOG_CODES.KeyQ).toBe('up');
    expect(JOG_CODES.ShiftLeft).toBe('slow');
    expect(JOG_CODES.ShiftRight).toBe('slow');
  });
});
