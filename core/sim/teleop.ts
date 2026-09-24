// In-process teleoperation loop: master + degraded channel + slave, stepped at 1 kHz with
// 100 Hz CMD/STATE exchange. Used by the automated experiment (Worker) and the tests; it runs
// as fast as the CPU allows.
import { COMM, PHYSICS } from '../config.ts';
import type { Vec3 } from '../math/vec.ts';
import { Degrader } from '../net/degrader.ts';
import type { ControlMode, NetParams } from '../protocol/messages.ts';
import { MasterSim, type MasterFeedback } from './master.ts';
import { SlaveSim, type SlaveCommand } from './slave.ts';

export interface TeleopOptions {
  mode: ControlMode;
  net: NetParams;
  gazeEnabled: boolean;
  waveB?: number;
  seed?: number;
}

type CmdPacket = Omit<SlaveCommand, 'recvTime'>;
interface StatePacket extends MasterFeedback {
  seq: number;
}

export class OfflineTeleop {
  readonly master: MasterSim;
  readonly slave: SlaveSim;
  private readonly up: Degrader<CmdPacket>;
  private readonly down: Degrader<StatePacket>;
  private k = 0;
  private cmdSeq = 0;
  private stateSeq = 0;
  private lastStateSeq = 0;
  private readonly commEvery = Math.round(1 / (COMM.controlRateHz * PHYSICS.dt));

  constructor(opts: TeleopOptions) {
    this.slave = new SlaveSim();
    this.master = new MasterSim(this.slave.home);
    this.slave.setMode(opts.mode);
    this.master.setMode(opts.mode);
    this.slave.waveB = this.master.waveB = opts.waveB ?? 40;
    this.slave.damping.setParams({ ...this.slave.damping.params, enabled: opts.gazeEnabled });
    this.slave.damping.reset();
    this.up = new Degrader<CmdPacket>(opts.net, opts.seed ?? 1);
    this.down = new Degrader<StatePacket>(opts.net, (opts.seed ?? 1) + 7919);
  }

  /** simulation time [s] */
  get t(): number {
    return this.k * PHYSICS.dt;
  }

  setHand(x: Vec3): void {
    this.master.handTarget = [x[0], x[1], x[2]];
  }

  gaze(p: Vec3, conf: number): void {
    this.slave.receiveGaze(p, conf, this.t);
  }

  step(): void {
    const dt = PHYSICS.dt;
    const nowMs = this.k * dt * 1000;
    for (const c of this.up.poll(nowMs)) this.slave.receiveCommand(c, this.t);
    for (const s of this.down.poll(nowMs)) {
      if (s.seq > this.lastStateSeq) {
        this.lastStateSeq = s.seq;
        this.master.receiveFeedback(s);
      }
    }
    this.master.step(dt);
    this.slave.step(dt);
    this.k++;
    if (this.k % this.commEvery === 0) {
      const m = this.master.command();
      this.up.submit({ seq: ++this.cmdSeq, xm: m.xm, vm: m.vm, eIn: m.eIn, eOut: m.eOut, um: m.um }, nowMs, 'CMD', true);
      const s = this.slave;
      this.down.submit(
        { seq: ++this.stateSeq, fc: [...s.fc], bMaster: s.bMaster, eIn: s.energy.in, eOut: s.energy.out, us: s.takeWaveOut() },
        nowMs,
        'STATE',
        true,
      );
    }
  }
}
