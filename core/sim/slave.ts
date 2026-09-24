// Slave (remote) side: command point -> PD coupling -> virtual tip mass in the environment, with
// the passivity controller of the selected mode and gaze-adaptive damping (docs/CONTROL.md §2.2, §4, §5).
import { COMM, ENV, SLAVE, TDPA } from '../config.ts';
import { GazeHistory } from '../gaze/attention.ts';
import { GazeDamping } from '../gaze/damping.ts';
import type { Vec3 } from '../math/vec.ts';
import { PortEnergy, dot3 } from '../passivity/energy.ts';
import { budgetedDrift, slavePc } from '../passivity/tdpa.ts';
import { waveSlave } from '../passivity/wave.ts';
import type { ControlMode, EventKind } from '../protocol/messages.ts';
import {
  CONTACT_FLOOR,
  CONTACT_TARGET,
  CONTACT_WALL,
  DEFAULT_ENV,
  contactForce,
  ringCrossed,
  targetReached,
  type Environment,
} from './env.ts';
import { Q_INIT, ikStep, tcpPosition } from './kinematics.ts';
import { stepsPerPacket } from './master.ts';
import { OscillationDetector } from './oscillation.ts';

/** The latest command as seen by the slave. */
export interface SlaveCommand {
  seq: number;
  /** slave-clock time of arrival [s] */
  recvTime: number;
  xm: Vec3;
  vm: Vec3;
  eIn: number;
  eOut: number;
  um: Vec3;
}

export interface SimEvent {
  kind: EventKind;
  data: Record<string, unknown>;
}

const SURFACE_NAMES: Array<[number, string]> = [
  [CONTACT_WALL, 'wall'],
  [CONTACT_FLOOR, 'floor'],
  [CONTACT_TARGET, 'target'],
];

export class SlaveSim {
  mode: ControlMode = 'none';
  waveB = 40;
  readonly env: Environment;
  readonly home: Vec3;

  t = 0;
  xs: Vec3;
  vs: Vec3 = [0, 0, 0];
  xd: Vec3;
  vd: Vec3 = [0, 0, 0];
  fc: Vec3 = [0, 0, 0];
  fe: Vec3 = [0, 0, 0];
  contact = 0;
  contactDepth = 0;
  q: number[] = [...Q_INIT];
  atJointLimit = false;
  /** returning wave v_s (instantaneous) */
  us: Vec3 = [0, 0, 0];
  private usSum: Vec3 = [0, 0, 0];
  private usCount = 0;
  private umBudget = 0;
  readonly energy = new PortEnergy();
  eDiss = 0;
  /** slave-side observer W_R (last step) */
  observer = 0;
  /** power dissipated by the PC in the last step [W] */
  pcPower = 0;

  cmd: SlaveCommand;
  readonly gazeHistory = new GazeHistory();
  readonly damping = new GazeDamping();
  gazeConfidence = 0;
  private gazeStamp = -Infinity;
  b = 0;

  readonly oscillation = new OscillationDetector();
  oscillating = false;
  ringsPassed = new Set<string>();
  targetDone = false;
  events: SimEvent[] = [];

  constructor(env: Environment = DEFAULT_ENV) {
    this.env = env;
    this.home = tcpPosition(Q_INIT);
    this.xs = [...this.home];
    this.xd = [...this.home];
    this.cmd = this.idleCommand();
    this.b = this.damping.b;
  }

  private idleCommand(): SlaveCommand {
    return { seq: 0, recvTime: 0, xm: [...this.home], vm: [0, 0, 0], eIn: 0, eOut: 0, um: [0, 0, 0] };
  }

  /** Back to the initial pose; clears energies, events, task progress and the damping slew state. */
  reset(): void {
    this.xs = [...this.home];
    this.vs = [0, 0, 0];
    this.xd = [...this.home];
    this.vd = [0, 0, 0];
    this.fc = [0, 0, 0];
    this.fe = [0, 0, 0];
    this.contact = 0;
    this.q = [...Q_INIT];
    this.us = [0, 0, 0];
    this.usSum = [0, 0, 0];
    this.usCount = 0;
    this.umBudget = 0;
    this.energy.reset();
    this.eDiss = 0;
    this.observer = 0;
    this.pcPower = 0;
    this.cmd = { ...this.idleCommand(), recvTime: this.t };
    this.damping.reset();
    this.b = this.damping.b;
    this.oscillation.reset();
    this.oscillating = false;
    this.ringsPassed.clear();
    this.targetDone = false;
  }

  setMode(mode: ControlMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    // CONTROL.md §5.4: a mode switch starts a new condition -> reset the slew-limiter state
    this.damping.reset();
    this.b = this.damping.b;
  }

  /** Accept a command if it is newer than the one in use. */
  receiveCommand(c: Omit<SlaveCommand, 'recvTime'>, recvTime: number): boolean {
    if (c.seq <= this.cmd.seq) return false;
    this.cmd = { ...c, recvTime };
    this.umBudget = stepsPerPacket();
    return true;
  }

  /** Interval-averaged returning wave for the next STATE (see MasterSim.command). */
  takeWaveOut(): Vec3 {
    const n = this.usCount;
    const v: Vec3 = n > 0 ? [this.usSum[0] / n, this.usSum[1] / n, this.usSum[2] / n] : [0, 0, 0];
    this.usSum = [0, 0, 0];
    this.usCount = 0;
    return v;
  }

  receiveGaze(p: Vec3, conf: number, time: number): void {
    this.gazeHistory.add({ t: time, p, conf });
    this.gazeConfidence = conf;
    this.gazeStamp = time;
  }

  step(dt: number): void {
    const t = this.t;
    const c = this.cmd;

    // 1. coupling force from the previous command point (known input at this step)
    const fc: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      fc[i] = SLAVE.couplingK * (this.xd[i] - this.xs[i]) + SLAVE.couplingB * (this.vd[i] - this.vs[i]);
    }

    // 2. command-point velocity according to the mode
    let vd: Vec3;
    this.pcPower = 0;
    if (this.mode === 'none') {
      // first-order-hold extrapolation of the held command, tracked with time constant tau so
      // the command point never jumps when a new CMD arrives
      const period = 1 / COMM.controlRateHz;
      const hold = Math.min(Math.max(0, t - c.recvTime), 1.5 * period);
      vd = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        const target = c.xm[i] + c.vm[i] * hold;
        vd[i] = c.vm[i] + (target - this.xd[i]) / period;
      }
      this.observer = c.eIn - this.energy.out - Math.max(0, dot3(fc, vd)) * dt;
    } else {
      let vRef: Vec3;
      if (this.mode === 'wave') {
        // each forward wave sample carries energy for one interval only; afterwards use zero
        const uIn: Vec3 = this.umBudget > 0 ? c.um : [0, 0, 0];
        if (this.umBudget > 0) this.umBudget--;
        const w = waveSlave(uIn, fc, this.waveB);
        vRef = w.vd;
        this.us = w.vs;
        for (let i = 0; i < 3; i++) this.usSum[i] += w.vs[i];
        this.usCount++;
      } else {
        vRef = [c.vm[0], c.vm[1], c.vm[2]];
      }
      // drift compensation within the energy budget of the observer
      const surplus = c.eIn - this.energy.out - Math.max(0, dot3(fc, vRef)) * dt;
      const drift = budgetedDrift(
        fc,
        [c.xm[0] - this.xd[0], c.xm[1] - this.xd[1], c.xm[2] - this.xd[2]],
        TDPA.driftGain,
        surplus,
        TDPA.driftBudget,
        dt,
      );
      vRef = [vRef[0] + drift[0], vRef[1] + drift[1], vRef[2] + drift[2]];
      if (this.mode === 'tdpa') {
        const r = slavePc(fc, vRef, c.eIn, this.energy.out, dt);
        vd = r.vd;
        this.eDiss += r.dissipated;
        this.pcPower = r.dissipated / dt;
        this.observer = r.observer;
      } else {
        vd = vRef;
        this.observer = c.eIn - this.energy.out - Math.max(0, dot3(fc, vd)) * dt;
      }
    }
    for (let i = 0; i < 3; i++) this.xd[i] += vd[i] * dt;
    this.vd = vd;
    this.fc = fc;
    this.energy.add(-dot3(fc, vd), dt);

    // 3. environment and gaze-adaptive damping
    const contact = contactForce(this.xs, this.vs, this.env);
    this.fe = contact.force;
    this.contactDepth = contact.depth;
    const gazeFresh = t - this.gazeStamp < 0.5 ? this.gazeConfidence : 0;
    this.gazeHistory.prune(t);
    this.b = this.damping.step(this.gazeHistory, this.xs, this.env, t, gazeFresh, dt);

    // 4. tip dynamics (semi-implicit Euler); b(t) acts here only when targeted at the slave
    const p = this.damping.params;
    const bTot = SLAVE.baseB + (p.enabled && p.target === 'slave' ? this.b : 0);
    const prev: Vec3 = [...this.xs];
    for (let i = 0; i < 3; i++) {
      const a = (fc[i] + this.fe[i] - bTot * this.vs[i]) / SLAVE.mass;
      this.vs[i] += a * dt;
      this.xs[i] += this.vs[i] * dt;
    }

    // 5. joints for rendering / limit checks: one DLS iteration per step
    this.atJointLimit = ikStep(this.q, this.xs, ENV.tcpOffset).atLimit;

    this.t = t + dt;
    this.detectEvents(prev, contact.flags);
  }

  private detectEvents(prev: Vec3, flags: number): void {
    const was = this.contact;
    this.contact = flags;
    for (const [bit, name] of SURFACE_NAMES) {
      if (flags & bit && !(was & bit)) {
        this.events.push({ kind: 'contact_start', data: { surface: name, t: this.t } });
      } else if (!(flags & bit) && was & bit) {
        this.events.push({ kind: 'contact_end', data: { surface: name, t: this.t } });
      }
    }
    for (const ring of this.env.rings) {
      if (!this.ringsPassed.has(ring.id) && ringCrossed(prev, this.xs, ring)) {
        this.ringsPassed.add(ring.id);
        this.events.push({ kind: 'ring', data: { id: ring.id, t: this.t } });
      }
    }
    if (!this.targetDone && targetReached(this.xs, this.env)) {
      this.targetDone = true;
      this.events.push({ kind: 'target', data: { t: this.t } });
    }
    const fmag = Math.hypot(this.fe[0], this.fe[1], this.fe[2]);
    const v = this.oscillation.push(fmag, flags !== 0);
    if (v) {
      if (v.oscillating && !this.oscillating) {
        this.events.push({ kind: 'oscillation', data: { freqHz: v.freqHz, amp: v.amp, t: this.t } });
      }
      this.oscillating = v.oscillating;
    }
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** Damping the master should apply (b(t) when the damper is targeted at the master, else 0). */
  get bMaster(): number {
    const p = this.damping.params;
    return p.enabled && p.target === 'master' ? this.b : 0;
  }

  /** Channel-generated energy as seen from the slave (CONTROL.md §3). */
  get eGen(): number {
    return this.energy.out - this.cmd.eIn + (this.cmd.eOut - this.energy.in);
  }

  /** Stored energy H_s (kinetic + coupling spring + contact spring). */
  get stored(): number {
    const d: Vec3 = [this.xd[0] - this.xs[0], this.xd[1] - this.xs[1], this.xd[2] - this.xs[2]];
    return (
      0.5 * SLAVE.mass * dot3(this.vs, this.vs) +
      0.5 * SLAVE.couplingK * dot3(d, d) +
      0.5 * ENV.wallK * this.contactDepth * this.contactDepth
    );
  }
}
