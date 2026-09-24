// Scripted "press against the wall" trial used by the automated experiment and the tests.
import { NET_DEFAULTS } from '../config.ts';
import type { Vec3 } from '../math/vec.ts';
import type { ControlMode } from '../protocol/messages.ts';
import { analyzeForce, OSC } from './oscillation.ts';
import { OfflineTeleop } from './teleop.ts';

export interface TrialCondition {
  delayMs: number;
  mode: ControlMode;
  gaze: boolean;
  jitterMs?: number;
  loss?: number;
  seed?: number;
}

export interface TrialResult {
  condition: TrialCondition;
  maxForce: number;
  oscillating: boolean;
  oscFreqHz: number;
  oscAmp: number;
  contactTransitions: number;
  /** max over time of the channel-generated energy E_gen [J] */
  eGenMax: number;
  /** E_gen at the end [J] */
  eGenFinal: number;
  /** energy removed by the passivity controllers [J] */
  eDiss: number;
  /** time when the slave passed the waypoint ring [s], NaN if never */
  passTime: number;
  /** final distance between master and slave positions [m] (drift) */
  finalDrift: number;
  /** traces for plotting, sampled at 100 Hz */
  trace: { t: number[]; force: number[]; eGen: number[]; b: number[]; xs: number[]; xm: number[] };
}

const PRE: Vec3 = [0.4, -0.16, 0.3];
const RING: Vec3 = [0.46, -0.16, 0.3];
const PRESS: Vec3 = [0.66, -0.16, 0.3];
const RETRACT: Vec3 = [0.52, -0.16, 0.3];

function smooth(s: number): number {
  const x = Math.min(1, Math.max(0, s));
  return x * x * (3 - 2 * x);
}

function lerp(a: Vec3, b: Vec3, s: number): Vec3 {
  const k = smooth(s);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

const HOLD_END = 9.0;

/** Hand trajectory: home -> before the ring -> through the ring into the wall (4 cm deep) -> hold -> retract. */
export function scriptedHand(t: number, home: Vec3): Vec3 {
  if (t < 1.5) return lerp(home, PRE, t / 1.5);
  if (t < 3.5) return lerp(PRE, PRESS, (t - 1.5) / 2.0);
  if (t < HOLD_END) return PRESS;
  if (t < HOLD_END + 1) return lerp(PRESS, RETRACT, t - HOLD_END);
  return RETRACT;
}

/** Synthetic gaze: the operator looks slightly ahead along the path (ring first, then the contact point). */
export function scriptedGaze(t: number): Vec3 {
  if (t < 2.2) return RING;
  return [0.62, -0.16, 0.3];
}

export const TRIAL_DURATION = HOLD_END + 1.5;
/**
 * Oscillation is judged on the steady part of the press: from SETTLE_S after the first wall
 * contact until the retraction starts (a single impact rebound is physics, not instability).
 */
export const SETTLE_S = 1.0;
/** In the steady window, even one lost-and-regained contact (2 transitions) is a bounce. */
const STEADY_MIN_TRANSITIONS = 2;

export function runTrial(cond: TrialCondition, duration = TRIAL_DURATION): TrialResult {
  const sim = new OfflineTeleop({
    mode: cond.mode,
    gazeEnabled: cond.gaze,
    seed: cond.seed ?? 42,
    net: { ...NET_DEFAULTS, delayMs: cond.delayMs, jitterMs: cond.jitterMs ?? 0, loss: cond.loss ?? 0 },
  });
  const home = sim.slave.home;
  const steps = Math.round(duration * 1000);
  const decim = 1000 / OSC.sampleHz;
  const pressForce: number[] = [];
  const pressContact: boolean[] = [];
  const trace: TrialResult['trace'] = { t: [], force: [], eGen: [], b: [], xs: [], xm: [] };
  let maxForce = 0;
  let eGenMax = -Infinity;
  let passTime = NaN;
  let firstWallContact = NaN;
  let gazeClock = 0;

  for (let k = 0; k < steps; k++) {
    const t = k / 1000;
    sim.setHand(scriptedHand(t, home));
    if (cond.gaze && t >= gazeClock) {
      sim.gaze(scriptedGaze(t), 1);
      gazeClock += 1 / 30;
    }
    sim.step();
    const s = sim.slave;
    const f = Math.hypot(s.fe[0], s.fe[1], s.fe[2]);
    maxForce = Math.max(maxForce, f);
    eGenMax = Math.max(eGenMax, s.eGen);
    for (const e of s.drainEvents()) {
      if (e.kind === 'ring' && Number.isNaN(passTime)) passTime = s.t;
      if (e.kind === 'contact_start' && e.data.surface === 'wall' && Number.isNaN(firstWallContact)) firstWallContact = s.t;
    }
    if (k % decim === 0 && t >= firstWallContact + SETTLE_S && t < HOLD_END) {
      pressForce.push(f);
      pressContact.push(s.contact !== 0);
    }
    if (k % 10 === 0) {
      trace.t.push(t);
      trace.force.push(f);
      trace.eGen.push(s.eGen);
      trace.b.push(s.b);
      trace.xs.push(s.xs[0]);
      trace.xm.push(sim.master.xm[0]);
    }
  }
  const v = analyzeForce(pressForce, pressContact, OSC.sampleHz, STEADY_MIN_TRANSITIONS);
  const s = sim.slave;
  const m = sim.master;
  return {
    condition: cond,
    maxForce,
    oscillating: v.oscillating,
    oscFreqHz: v.freqHz,
    oscAmp: v.amp,
    contactTransitions: v.transitions,
    eGenMax,
    eGenFinal: s.eGen,
    eDiss: s.eDiss + m.eDiss,
    passTime,
    finalDrift: Math.hypot(m.xm[0] - s.xd[0], m.xm[1] - s.xd[1], m.xm[2] - s.xd[2]),
    trace,
  };
}
