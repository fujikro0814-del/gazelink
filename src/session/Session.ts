// Client-side GLP/1 engine: handshake, clock sync, liveness, the 1 kHz master loop, CMD/GAZE
// sending, STATE handling, measurements and the traffic log.
import { COMM, PHYSICS } from '../../core/config.ts';
import type { Vec3 } from '../../core/math/vec.ts';
import { GazeHistory } from '../../core/gaze/attention.ts';
import { ClockSync } from '../../core/net/clocksync.ts';
import { StreamMeter } from '../../core/net/stream.ts';
import { decode, encode, frameSize, type Frame } from '../../core/protocol/codec.ts';
import {
  BINARY_TYPES,
  LATEST_ONLY_TYPES,
  PROTO_VERSION,
  type CtrlConfig,
  type Draft,
  type EventMsg,
  type GazeMsg,
  type Msg,
  type MsgName,
  type NetConfig,
  type Role,
  type StateMsg,
  type StatsMsg,
  type TransportKind,
} from '../../core/protocol/messages.ts';
import { defaultCtrlConfig, defaultNetConfig } from '../../core/room/hub.ts';
import { MasterSim } from '../../core/sim/master.ts';
import { Q_INIT, tcpPosition } from '../../core/sim/kinematics.ts';
import { connectFirst, transportOrder, type AttemptLog } from '../transport/auto.ts';
import type { Transport } from '../transport/types.ts';
import { Series } from './series.ts';

export type Phase = 'idle' | 'connecting' | 'joined' | 'reconnecting' | 'closed' | 'error';

export interface LogEntry {
  /** client clock [ms] */
  t: number;
  dir: 'send' | 'recv';
  type: MsgName | '?';
  seq: number;
  size: number;
  enc: 'binary' | 'json';
  /** one-way delay estimate [ms] (recv only, when synchronized) */
  owd?: number;
  /** sender timestamp converted to the client clock [ms] */
  sentAt?: number;
  /** verdict of the sequence check */
  verdict?: 'fresh' | 'late' | 'duplicate';
}

export interface InspectorEntry extends LogEntry {
  frame: Frame;
  msg: Msg | null;
}

export interface GazeInput {
  uv: [number, number];
  p: Vec3;
  conf: number;
  hit: number;
  src: number;
}

const now = () => performance.timeOrigin + performance.now();
const LOG_CAP = 200_000;
const INSPECTOR_CAP = 400;

type Listener = () => void;

export class Session {
  // --- public state (read by the UI)
  phase: Phase = 'idle';
  role: Role = 'operator';
  room = '';
  clientId = 0;
  transportKind: TransportKind | null = null;
  serverMode: 'network' | 'local' = 'network';
  attempts: AttemptLog[] = [];
  errorText = '';
  netcfg: NetConfig = defaultNetConfig();
  ctrlcfg: CtrlConfig = defaultCtrlConfig();
  epoch = 1;
  peers = 0;

  readonly clock = new ClockSync();
  readonly master = new MasterSim(tcpPosition(Q_INIT));
  state: StateMsg | null = null;
  stateRecvAt = 0;
  remoteGaze: GazeMsg | null = null;
  stats: StatsMsg | null = null;
  events: Array<{ t: number; kind: string; data: Record<string, unknown> }> = [];
  readonly meters = new Map<MsgName, StreamMeter>();
  pingRtt = NaN;
  readonly rttSeries = new Series(2000, ['syncRtt', 'pingRtt', 'owdDown', 'owdUp']);
  readonly energySeries = new Series(2000, ['eGen', 'hm', 'hs', 'wl']);
  readonly dampingSeries = new Series(2000, ['b', 'attention']);
  readonly forceSeries = new Series(2000, ['fe', 'fc']);
  /** client physics loop measurements */
  loopStats = { wakeMeanMs: 0, wakeJitterMs: 0, stepsPerSec: 0, dropped: 0 };
  /** CMDs sent but possibly not yet applied (for the prediction arm) */
  readonly sentCmds: Array<{ seq: number; at: number; xm: Vec3; vm: Vec3 }> = [];
  readonly log: LogEntry[] = [];
  readonly inspector: InspectorEntry[] = [];
  /** local copy of the gaze history (own samples for the operator, relayed ones for spectators) */
  readonly gazeHistory = new GazeHistory();
  readonly ringsPassed = new Set<string>();

  // --- private
  private transport: Transport | null = null;
  private seqs = new Map<MsgName, number>();
  private listeners = new Set<Listener>();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private lastHeard = 0;
  private gazeInput: GazeInput | null = null;
  private acc = 0;
  private lastWake = 0;
  private stepCounter = 0;
  private wakeSamples: number[] = [];
  private stepsWindow: Array<{ t: number; n: number }> = [];
  private forcedTransport: string | null = null;
  private wantRoom: string | null = null;
  private reconnecting = false;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  meter(t: MsgName): StreamMeter {
    let m = this.meters.get(t);
    if (!m) {
      m = new StreamMeter();
      this.meters.set(t, m);
    }
    return m;
  }

  // ------------------------------------------------------------ lifecycle

  async start(role: Role, room: string | null, forcedTransport: string | null): Promise<void> {
    this.role = role;
    this.wantRoom = room;
    this.forcedTransport = forcedTransport;
    this.phase = 'connecting';
    this.notify();
    await this.connect();
  }

  private async connect(): Promise<void> {
    this.attempts = [];
    let t: Transport;
    try {
      const order = transportOrder(this.forcedTransport);
      // a spectator cannot watch a single-player Worker room
      const usable = this.role === 'spectator' ? order.filter((k) => k !== 'worker') : order;
      t = await connectFirst(usable, 3000, (a) => {
        this.attempts.push(a);
        this.notify();
      });
    } catch (e) {
      this.phase = 'error';
      this.errorText = `サーバに接続できませんでした（${e instanceof Error ? e.message : String(e)}）`;
      this.notify();
      return;
    }
    this.transport = t;
    this.transportKind = t.kind;
    t.onFrame = (f) => this.onFrame(f);
    t.onClose = (reason) => this.onTransportClosed(reason);
    this.lastHeard = now();
    this.clock.reset();
    const room = t.kind === 'worker' ? null : this.wantRoom;
    this.send({ t: 'HELLO', role: this.role, room, transport: t.kind, proto: PROTO_VERSION });
    this.notify();
  }

  private onTransportClosed(reason: string): void {
    if (this.phase === 'closed') return;
    this.stopTimers();
    this.transport = null;
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.phase = 'reconnecting';
    this.errorText = reason;
    this.notify();
    // rejoin the same room if the server is reachable; otherwise the chain falls back
    setTimeout(async () => {
      this.reconnecting = false;
      if (this.phase === 'closed') return;
      this.wantRoom = this.room || this.wantRoom;
      await this.connect();
    }, 800);
  }

  stop(): void {
    if (this.transport) this.send({ t: 'BYE', reason: 'user' });
    this.phase = 'closed';
    this.stopTimers();
    setTimeout(() => this.transport?.close(), 50);
    this.notify();
  }

  private stopTimers(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private startTimers(): void {
    this.stopTimers();
    this.timers.push(setInterval(() => this.sync(), COMM.syncIntervalMs));
    this.timers.push(setInterval(() => this.liveness(), COMM.pingIntervalMs));
    if (this.role === 'operator') {
      this.lastWake = now();
      this.acc = 0;
      this.timers.push(setInterval(() => this.physicsWake(), 2));
      this.timers.push(setInterval(() => this.sendGaze(), 1000 / COMM.gazeRateHz));
    }
    this.sync();
  }

  // ------------------------------------------------------------ sending

  private send(d: Draft): void {
    const t = this.transport;
    if (!t) return;
    const seq = (this.seqs.get(d.t) ?? 0) + 1;
    this.seqs.set(d.t, seq);
    const m = { ...d, seq, ts: now() } as Msg;
    const frame = encode(m);
    t.send(frame);
    this.record({ t: m.ts, dir: 'send', type: m.t, seq, size: frameSize(frame), enc: BINARY_TYPES.has(m.t) ? 'binary' : 'json' }, frame, m);
    if (m.t === 'CMD') {
      this.sentCmds.push({ seq, at: m.ts, xm: m.xm, vm: m.vm });
      if (this.sentCmds.length > 400) this.sentCmds.shift();
    }
  }

  private record(e: LogEntry, frame: Frame, msg: Msg | null): void {
    this.log.push(e);
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
    this.inspector.push({ ...e, frame, msg });
    if (this.inspector.length > INSPECTOR_CAP) this.inspector.splice(0, this.inspector.length - INSPECTOR_CAP);
  }

  private sync(): void {
    this.send({ t: 'SYNC_REQ' });
  }

  private liveness(): void {
    const t = now();
    if (t - this.lastHeard > COMM.pingTimeoutMs && this.phase === 'joined') {
      this.transport?.close();
      this.onTransportClosed('応答がありません（5 秒）');
      return;
    }
    this.send({ t: 'PING' });
  }

  setNetConfig(cfg: NetConfig): void {
    this.send({ t: 'NETCFG', ...cfg });
  }

  setCtrlConfig(cfg: CtrlConfig): void {
    this.send({ t: 'CTRLCFG', ...cfg });
  }

  reset(): void {
    this.send({ t: 'RESET' });
  }

  setHand(x: Vec3): void {
    this.master.handTarget = [x[0], x[1], x[2]];
  }

  setGaze(g: GazeInput | null): void {
    this.gazeInput = g;
  }

  /** Current gaze input of this operator. */
  get gaze(): GazeInput | null {
    return this.gazeInput;
  }

  /** Time base of the local gaze history [s]. */
  gazeTime(): number {
    return performance.now() / 1000;
  }

  private sendGaze(): void {
    const g = this.gazeInput;
    if (!g || this.phase !== 'joined') return;
    this.send({ t: 'GAZE', uv: g.uv, p: g.p, conf: g.conf, hit: g.hit, src: g.src });
    this.addGazeSample(g.p, g.conf);
  }

  private addGazeSample(p: Vec3, conf: number): void {
    const t = this.gazeTime();
    this.gazeHistory.forgetTau = this.ctrlcfg.gaze.forgetTau;
    this.gazeHistory.add({ t, p: [...p], conf });
    this.gazeHistory.prune(t);
  }

  // ------------------------------------------------------------ master loop

  private physicsWake(): void {
    const t = now();
    const wake = t - this.lastWake;
    this.lastWake = t;
    this.wakeSamples.push(wake);
    if (this.wakeSamples.length > 500) this.wakeSamples.shift();
    this.acc += wake;
    const dtMs = PHYSICS.dt * 1000;
    let n = Math.floor(this.acc / dtMs);
    if (n > PHYSICS.maxCatchUpSteps) {
      // tab was throttled: drop the backlog instead of fast-forwarding the operator
      this.loopStats.dropped += n - PHYSICS.maxCatchUpSteps;
      this.acc -= (n - PHYSICS.maxCatchUpSteps) * dtMs;
      n = PHYSICS.maxCatchUpSteps;
    }
    const every = Math.round(1 / (COMM.controlRateHz * PHYSICS.dt));
    for (let i = 0; i < n; i++) {
      this.master.step(PHYSICS.dt);
      this.acc -= dtMs;
      if (++this.stepCounter % every === 0 && this.phase === 'joined') {
        const c = this.master.command();
        this.send({ t: 'CMD', epoch: this.epoch, ...c, offset: this.clock.offset });
      }
    }
    this.stepsWindow.push({ t, n });
    while (this.stepsWindow.length > 1 && this.stepsWindow[0].t < t - 1000) this.stepsWindow.shift();
  }

  updateLoopStats(): void {
    const s = this.wakeSamples;
    const mean = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, s.length));
    this.loopStats.wakeMeanMs = mean;
    this.loopStats.wakeJitterMs = sd;
    this.loopStats.stepsPerSec = this.stepsWindow.reduce((a, r) => a + r.n, 0);
  }

  // ------------------------------------------------------------ receiving

  private onFrame(frame: Frame): void {
    const t = now();
    this.lastHeard = t;
    let m: Msg | null = null;
    try {
      m = decode(frame);
    } catch {
      this.record({ t, dir: 'recv', type: '?', seq: 0, size: frameSize(frame), enc: typeof frame === 'string' ? 'json' : 'binary' }, frame, null);
      return;
    }
    const synced = this.clock.synced;
    const sentAt = synced ? this.clock.toClient(m.ts) : undefined;
    const owd = synced ? t + this.clock.offset - m.ts : undefined;
    let verdict: LogEntry['verdict'];
    if (LATEST_ONLY_TYPES.has(m.t) || m.t === 'SYNC_RESP' || m.t === 'PONG' || m.t === 'PING') {
      verdict = this.meter(m.t).observe(m.seq, m.ts, t, owd);
    }
    this.record({ t, dir: 'recv', type: m.t, seq: m.seq, size: frameSize(frame), enc: BINARY_TYPES.has(m.t) ? 'binary' : 'json', owd, sentAt, verdict }, frame, m);
    if (verdict && verdict !== 'fresh' && LATEST_ONLY_TYPES.has(m.t)) return;
    this.handle(m, t, owd);
  }

  private handle(m: Msg, t: number, owd: number | undefined): void {
    switch (m.t) {
      case 'WELCOME':
        this.phase = 'joined';
        this.room = m.room;
        this.clientId = m.clientId;
        this.serverMode = m.server.mode;
        this.netcfg = m.netcfg;
        this.ctrlcfg = m.ctrlcfg;
        this.peers = m.peers.length;
        this.errorText = '';
        this.master.setMode(m.ctrlcfg.mode);
        this.master.waveB = m.ctrlcfg.waveImpedance;
        this.startTimers();
        this.pushUrl();
        this.notify();
        return;
      case 'ERROR':
        this.errorText = m.message;
        if (this.phase !== 'joined') {
          this.phase = 'error';
          this.stopTimers();
          this.transport?.close();
        }
        this.notify();
        return;
      case 'SYNC_RESP': {
        const s = this.clock.add(m.t0, m.t1, m.ts, t);
        this.rttSeries.push(t, [s.delay, NaN, NaN, NaN]);
        return;
      }
      case 'PING':
        this.send({ t: 'PONG', echoSeq: m.seq, echoTs: m.ts });
        return;
      case 'PONG':
        this.pingRtt = t - m.echoTs;
        this.rttSeries.push(t, [NaN, this.pingRtt, NaN, NaN]);
        return;
      case 'STATE':
        this.onState(m, t, owd);
        return;
      case 'GAZE':
        this.remoteGaze = m;
        this.addGazeSample(m.p, m.conf);
        return;
      case 'NETCFG':
        this.netcfg = { up: m.up, down: m.down, seed: m.seed };
        // the hub restarted its measurements too; start ours over so both compare the new setting
        this.meters.clear();
        this.stats = null;
        this.notify();
        return;
      case 'CTRLCFG':
        this.ctrlcfg = { mode: m.mode, waveImpedance: m.waveImpedance, gaze: m.gaze };
        this.master.setMode(m.mode);
        this.master.waveB = m.waveImpedance;
        this.notify();
        return;
      case 'EVENT':
        this.onEvent(m, t);
        return;
      case 'STATS':
        this.stats = m;
        return;
      case 'BYE':
        this.onTransportClosed(`サーバが切断しました（${m.reason}）`);
        return;
      default:
        return;
    }
  }

  private onState(m: StateMsg, t: number, owd: number | undefined): void {
    if (m.epoch !== this.epoch) return;
    this.state = m;
    this.stateRecvAt = t;
    const g = this.ctrlcfg.gaze;
    this.master.receiveFeedback({
      fc: m.fc,
      bMaster: g.enabled && g.target === 'master' ? m.b : 0,
      eIn: m.eIn,
      eOut: m.eOut,
      us: m.us,
    });
    // uplink one-way delay of the last applied CMD: server receive time minus our send time
    const applied = this.sentCmds.find((c) => c.seq === m.cmdSeq);
    if (applied && this.clock.synced) this.lastUpOwd = m.cmdRecv - (applied.at + this.clock.offset);
    const owdUp = this.lastUpOwd;
    // drop CMDs the slave has already applied
    while (this.sentCmds.length && this.sentCmds[0].seq <= m.cmdSeq) this.sentCmds.shift();
    this.rttSeries.push(t, [NaN, NaN, owd ?? NaN, owdUp]);
    const fe = Math.hypot(m.fe[0], m.fe[1], m.fe[2]);
    const fc = Math.hypot(m.fc[0], m.fc[1], m.fc[2]);
    this.forceSeries.push(t, [fe, fc]);
    this.dampingSeries.push(t, [m.b, m.attention]);
    const wl = this.master.observer;
    this.energySeries.push(t, [m.eGen, this.master.stored, m.hs, wl]);
  }

  lastUpOwd = NaN;

  private onEvent(m: EventMsg, t: number): void {
    if (m.kind === 'reset') {
      const epoch = Number(m.data.epoch) || 1;
      this.epoch = epoch;
      if (m.data.rebase) {
        // control-mode switch: keep the arm where it is, restart the energy counters
        this.master.rebaseEnergy();
        this.energySeries.clear();
        this.events.push({ t, kind: 'mode', data: { mode: this.ctrlcfg.mode } });
        this.notify();
        return;
      }
      if (!m.data.join) {
        this.master.reset();
        this.sentCmds.length = 0;
        this.energySeries.clear();
      }
      this.state = null;
      this.ringsPassed.clear();
    }
    if (m.kind === 'ring') this.ringsPassed.add(String(m.data.id));
    if (m.kind === 'peer_join') this.peers++;
    if (m.kind === 'peer_leave') this.peers = Math.max(0, this.peers - 1);
    if (m.data.join) return;
    this.events.push({ t, kind: m.kind, data: m.data });
    if (this.events.length > 200) this.events.shift();
    this.notify();
  }

  private pushUrl(): void {
    try {
      const u = new URL(location.href);
      if (this.transportKind === 'worker') u.searchParams.delete('room');
      else u.searchParams.set('room', this.room);
      history.replaceState(null, '', u.toString());
    } catch {
      /* iframe sandbox may forbid history access */
    }
  }

  // ------------------------------------------------------------ export

  exportJsonl(): string {
    return this.log.map((e) => JSON.stringify(e)).join('\n') + '\n';
  }

  exportCsv(): string {
    const head = 't_ms,dir,type,seq,size,enc,owd_ms,sent_at_ms,verdict';
    const rows = this.log.map((e) =>
      [e.t.toFixed(3), e.dir, e.type, e.seq, e.size, e.enc, e.owd?.toFixed(3) ?? '', e.sentAt?.toFixed(3) ?? '', e.verdict ?? ''].join(','),
    );
    return [head, ...rows].join('\n') + '\n';
  }
}
