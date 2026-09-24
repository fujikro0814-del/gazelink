// Master (local) side: the operator's hand drives a virtual mass through a spring-damper; the
// channel's feedback force acts on that mass (docs/CONTROL.md §2.1, §4).
import { COMM, MASTER, PHYSICS } from '../config.ts';
import type { Vec3 } from '../math/vec.ts';
import { PortEnergy, dot3 } from '../passivity/energy.ts';
import { masterPc } from '../passivity/tdpa.ts';
import { waveMaster } from '../passivity/wave.ts';
import type { ControlMode } from '../protocol/messages.ts';

/** What the master needs from the latest STATE. */
export interface MasterFeedback {
  fc: Vec3;
  /** gaze-adaptive damping to apply on the master mass [N s/m] (0 when it acts on the slave) */
  bMaster: number;
  /** E_S^in as reported by the slave */
  eIn: number;
  /** E_S^out as reported by the slave (display only) */
  eOut: number;
  /** returning wave v_s */
  us: Vec3;
}

export interface MasterCommand {
  xm: Vec3;
  vm: Vec3;
  eIn: number;
  eOut: number;
  xh: Vec3;
  um: Vec3;
}

const HAND_FILTER_TAU = 0.02;

/** Physics steps per communication interval (10 at 1 kHz / 100 Hz). */
export const stepsPerPacket = (): number => Math.round(1 / (COMM.controlRateHz * PHYSICS.dt));

export class MasterSim {
  mode: ControlMode = 'none';
  waveB = 40;

  /** raw hand target (e.g., mouse), filtered into xh */
  handTarget: Vec3;
  xh: Vec3;
  vh: Vec3 = [0, 0, 0];
  xm: Vec3;
  vm: Vec3 = [0, 0, 0];
  /** force applied by the channel on the master (last step) */
  fm: Vec3 = [0, 0, 0];
  um: Vec3 = [0, 0, 0];
  readonly energy = new PortEnergy();
  eDiss = 0;
  /** master-side observer W_L (last step) */
  observer = 0;
  pcAlpha = 0;
  feedback: MasterFeedback = { fc: [0, 0, 0], bMaster: 0, eIn: 0, eOut: 0, us: [0, 0, 0] };
  // wave transmission: interval-averaged outgoing wave; each incoming sample used for at most one interval
  private umSum: Vec3 = [0, 0, 0];
  private umCount = 0;
  private usBudget = 0;

  readonly home: Vec3;

  constructor(home: Vec3) {
    this.home = [...home];
    this.handTarget = [...home];
    this.xh = [...home];
    this.xm = [...home];
  }

  reset(): void {
    this.handTarget = [...this.home];
    this.xh = [...this.home];
    this.vh = [0, 0, 0];
    this.xm = [...this.home];
    this.vm = [0, 0, 0];
    this.fm = [0, 0, 0];
    this.um = [0, 0, 0];
    this.energy.reset();
    this.eDiss = 0;
    this.observer = 0;
    this.pcAlpha = 0;
    this.feedback = { fc: [0, 0, 0], bMaster: 0, eIn: 0, eOut: 0, us: [0, 0, 0] };
    this.umSum = [0, 0, 0];
    this.umCount = 0;
    this.usBudget = 0;
  }

  setMode(mode: ControlMode): void {
    this.mode = mode;
  }

  /**
   * New epoch after a mode switch (see SlaveSim.rebaseEnergy): the port counters restart from
   * zero, and so do the slave's counters as they will be reported in new-epoch STATEs.
   */
  rebaseEnergy(): void {
    this.energy.reset();
    this.feedback = { ...this.feedback, eIn: 0, eOut: 0, us: [0, 0, 0] };
    this.usBudget = 0;
  }

  /** E_S^in received from the slave (current epoch). */
  private get eInRel(): number {
    return this.feedback.eIn;
  }

  /** E_M^out (current epoch). */
  private get eOutRel(): number {
    return this.energy.out;
  }

  /** Apply the content of a newer STATE. */
  receiveFeedback(fb: MasterFeedback): void {
    this.feedback = { fc: [...fb.fc], bMaster: fb.bMaster, eIn: fb.eIn, eOut: fb.eOut, us: [...fb.us] };
    this.usBudget = stepsPerPacket();
  }

  step(dt: number): void {
    // hand: first-order filter of the raw target gives a smooth position and velocity
    const kf = Math.min(1, dt / HAND_FILTER_TAU);
    for (let i = 0; i < 3; i++) {
      const nx = this.xh[i] + (this.handTarget[i] - this.xh[i]) * kf;
      this.vh[i] = (nx - this.xh[i]) / dt;
      this.xh[i] = nx;
    }

    const fb = this.feedback;
    let fm: Vec3;
    this.pcAlpha = 0;
    if (this.mode === 'wave') {
      // a returning wave sample carries energy for one interval only; afterwards use zero
      const vIn: Vec3 = this.usBudget > 0 ? fb.us : [0, 0, 0];
      if (this.usBudget > 0) this.usBudget--;
      const { Fm, um } = waveMaster(this.vm, vIn, this.waveB);
      fm = [-Fm[0], -Fm[1], -Fm[2]];
      this.um = um;
      for (let i = 0; i < 3; i++) this.umSum[i] += um[i];
      this.umCount++;
      this.observer = this.eInRel - this.eOutRel;
    } else if (this.mode === 'tdpa') {
      const r = masterPc([-fb.fc[0], -fb.fc[1], -fb.fc[2]], this.vm, this.eInRel, this.eOutRel, dt);
      fm = r.fm;
      this.eDiss += r.dissipated;
      this.observer = r.observer;
      this.pcAlpha = r.alpha;
    } else {
      fm = [-fb.fc[0], -fb.fc[1], -fb.fc[2]];
      this.observer = this.eInRel - this.eOutRel;
    }
    this.fm = fm;
    this.energy.add(-dot3(fm, this.vm), dt);

    const { mass, handK, handB } = MASTER;
    // gaze-adaptive damper to ground (passive: b >= 0), outside the channel's energy balance
    const bg = Math.max(0, fb.bMaster);
    for (let i = 0; i < 3; i++) {
      const a = (handK * (this.xh[i] - this.xm[i]) + handB * (this.vh[i] - this.vm[i]) + fm[i] - bg * this.vm[i]) / mass;
      this.vm[i] += a * dt;
      this.xm[i] += this.vm[i] * dt;
    }
  }

  /**
   * Snapshot for one CMD. The wave u_m is averaged over the interval since the previous CMD:
   * by Jensen, holding the mean for one interval never carries more energy (u^2/2) than was put in.
   */
  command(): MasterCommand {
    const n = this.umCount;
    const um: Vec3 = n > 0 ? [this.umSum[0] / n, this.umSum[1] / n, this.umSum[2] / n] : [0, 0, 0];
    this.umSum = [0, 0, 0];
    this.umCount = 0;
    return {
      xm: [...this.xm],
      vm: [...this.vm],
      eIn: this.energy.in,
      eOut: this.energy.out,
      xh: [...this.xh],
      um,
    };
  }

  /** Stored energy H_m (kinetic + hand spring). */
  get stored(): number {
    const d: Vec3 = [this.xh[0] - this.xm[0], this.xh[1] - this.xm[1], this.xh[2] - this.xm[2]];
    return 0.5 * MASTER.mass * dot3(this.vm, this.vm) + 0.5 * MASTER.handK * dot3(d, d);
  }
}
