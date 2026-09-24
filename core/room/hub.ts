// Room hub: the "server" side of GLP/1 as pure TypeScript. It runs unchanged in Node (behind
// WebSocket / SSE links) and in a browser Worker (single-player fallback). The host supplies
// links and calls `tick()` often; the hub does the rest (docs/PROTOCOL.md).
import { COMM, NET_DEFAULTS, PHYSICS } from '../config.ts';
import { defaultGazeParams } from '../gaze/damping.ts';
import { Degrader } from '../net/degrader.ts';
import { StreamMeter } from '../net/stream.ts';
import { decode, encode, type Frame } from '../protocol/codec.ts';
import {
  LATEST_ONLY_TYPES,
  LOSSY_TYPES,
  PROTO_VERSION,
  STATUS_GAZE_LOW_CONF,
  STATUS_JOINT_LIMIT,
  STATUS_OSCILLATION,
  type CtrlConfig,
  type Draft,
  type ErrorCode,
  type Msg,
  type MsgName,
  type NetConfig,
  type Role,
  type StatsMsg,
  type StreamStats,
  type TransportKind,
} from '../protocol/messages.ts';
import { SlaveSim } from '../sim/slave.ts';

export interface Link {
  send(frame: Frame): void;
  close(): void;
}

export interface HubOptions {
  /** monotonic clock in ms */
  now: () => number;
  mode: 'network' | 'local';
  /** keep a room this long after its operator left / it became empty [ms] */
  roomLingerMs?: number;
  maxSpectators?: number;
  log?: (msg: string) => void;
}

export const defaultNetConfig = (): NetConfig => ({
  up: { ...NET_DEFAULTS },
  down: { ...NET_DEFAULTS },
  seed: 12345,
});

export const defaultCtrlConfig = (): CtrlConfig => ({
  mode: 'none',
  waveImpedance: 40,
  gaze: defaultGazeParams(),
});

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class Peer {
  readonly id: number;
  readonly transport: TransportKind;
  role: Role | null = null;
  room: Room | null = null;
  lastHeard: number;
  closed = false;
  readonly up: Degrader<Msg>;
  readonly down: Degrader<Frame>;
  readonly meters = new Map<MsgName, StreamMeter>();
  private seqs = new Map<MsgName, number>();
  private readonly link: Link;
  lastPing = 0;
  badMessages = 0;

  constructor(id: number, link: Link, transport: TransportKind, now: number, netcfg: NetConfig) {
    this.id = id;
    this.link = link;
    this.transport = transport;
    this.lastHeard = now;
    this.up = new Degrader<Msg>(netcfg.up, netcfg.seed ^ (id * 2654435761));
    this.down = new Degrader<Frame>(netcfg.down, netcfg.seed ^ (id * 40503) ^ 0x5bd1e995);
  }

  nextSeq(t: MsgName): number {
    const n = (this.seqs.get(t) ?? 0) + 1;
    this.seqs.set(t, n);
    return n;
  }

  meter(t: MsgName): StreamMeter {
    let m = this.meters.get(t);
    if (!m) {
      m = new StreamMeter();
      this.meters.set(t, m);
    }
    return m;
  }

  applyNet(cfg: NetConfig): void {
    this.up.setParams(cfg.up, cfg.seed ^ (this.id * 2654435761));
    this.down.setParams(cfg.down, cfg.seed ^ (this.id * 40503) ^ 0x5bd1e995);
  }

  /** Put a frame on this peer's downlink (degraded). */
  enqueue(frame: Frame, t: MsgName, now: number): void {
    if (this.closed) return;
    this.down.submit(frame, now, t, LOSSY_TYPES.has(t));
  }

  /** Deliver due downlink frames to the transport. */
  flush(now: number): void {
    for (const f of this.down.poll(now)) {
      try {
        this.link.send(f);
      } catch {
        // transport already gone; the close handler will clean up
      }
    }
  }

  /** Send immediately, bypassing the degrader (only before joining a room). */
  sendNow(frame: Frame): void {
    try {
      this.link.send(frame);
    } catch {
      /* ignore */
    }
  }

  closeLink(): void {
    this.closed = true;
    try {
      this.link.close();
    } catch {
      /* ignore */
    }
  }
}

export class Room {
  readonly code: string;
  operator: Peer | null = null;
  readonly spectators = new Set<Peer>();
  readonly slave = new SlaveSim();
  netcfg: NetConfig = defaultNetConfig();
  ctrlcfg: CtrlConfig = defaultCtrlConfig();
  epoch = 1;
  emptySince: number | null = null;
  operatorLostAt: number | null = null;
  // physics clock
  acc = 0;
  lastAdvance: number;
  stepCount = 0;
  lastCmdRecv = 0;
  // step timing statistics
  readonly wakeIntervals: number[] = [];
  maxBacklog = 0;
  /** (wake time, steps run) over the last second */
  readonly recentSteps: Array<{ t: number; n: number }> = [];

  constructor(code: string, now: number) {
    this.code = code;
    this.lastAdvance = now;
    this.applyCtrl(this.ctrlcfg);
  }

  get peers(): Peer[] {
    return this.operator ? [this.operator, ...this.spectators] : [...this.spectators];
  }

  applyCtrl(c: CtrlConfig): void {
    this.ctrlcfg = structuredClone(c);
    this.slave.waveB = c.waveImpedance;
    this.slave.gazeHistory.forgetTau = c.gaze.forgetTau;
    this.slave.damping.setParams(c.gaze);
    // setMode resets the slew state on a mode change; parameter changes also start a new condition
    this.slave.setMode(c.mode);
    this.slave.damping.reset();
  }
}

export class Hub {
  private readonly opts: Required<HubOptions>;
  private readonly peers = new Map<number, Peer>();
  readonly rooms = new Map<string, Room>();
  private nextPeerId = 1;

  constructor(opts: HubOptions) {
    this.opts = {
      roomLingerMs: 60_000,
      maxSpectators: 16,
      log: () => {},
      ...opts,
    };
  }

  get now(): number {
    return this.opts.now();
  }

  /** Register a new transport-level connection. The host forwards frames and close events. */
  connect(link: Link, transport: TransportKind): { receive: (frame: Frame) => void; close: () => void; peer: Peer } {
    const peer = new Peer(this.nextPeerId++, link, transport, this.now, defaultNetConfig());
    this.peers.set(peer.id, peer);
    return {
      peer,
      receive: (frame) => this.onFrame(peer, frame),
      close: () => this.onClose(peer, 'transport closed'),
    };
  }

  private makeCode(): string {
    for (;;) {
      let s = '';
      for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      if (!this.rooms.has(s)) return s;
    }
  }

  // ---------------------------------------------------------------- sending

  private stamp<M extends Msg>(peer: Peer, d: Draft<M>): M {
    return { ...d, seq: peer.nextSeq(d.t), ts: this.now } as unknown as M;
  }

  private send(peer: Peer, d: Draft, degrade = true): void {
    const m = this.stamp(peer, d);
    const frame = encode(m);
    if (degrade && peer.room) peer.enqueue(frame, m.t, this.now);
    else peer.sendNow(frame);
  }

  private broadcast(room: Room, d: Draft, except?: Peer): void {
    for (const p of room.peers) if (p !== except) this.send(p, d);
  }

  private error(peer: Peer, code: ErrorCode, message: string): void {
    this.send(peer, { t: 'ERROR', code, message }, false);
  }

  // ---------------------------------------------------------------- receiving

  private onFrame(peer: Peer, frame: Frame): void {
    if (peer.closed) return;
    let msg: Msg;
    try {
      msg = decode(frame);
    } catch {
      peer.badMessages++;
      return;
    }
    peer.lastHeard = this.now;
    if (!peer.room) {
      if (msg.t === 'HELLO') this.onHello(peer, msg);
      else if (msg.t === 'PING') this.send(peer, { t: 'PONG', echoSeq: msg.seq, echoTs: msg.ts }, false);
      else this.error(peer, 'bad_message', 'HELLO が必要です');
      return;
    }
    // uplink degradation: the message is processed when the degrader releases it
    peer.up.submit(msg, this.now, msg.t, LOSSY_TYPES.has(msg.t));
  }

  private onHello(peer: Peer, m: Extract<Msg, { t: 'HELLO' }>): void {
    if (m.proto !== PROTO_VERSION) {
      this.error(peer, 'version', `プロトコルの版が違います（サーバ: ${PROTO_VERSION}）`);
      return;
    }
    const now = this.now;
    let room: Room | undefined;
    if (m.role === 'operator') {
      if (m.room) {
        room = this.rooms.get(m.room.toUpperCase());
        if (!room) return this.error(peer, 'no_such_room', `部屋 ${m.room} は存在しません`);
        if (room.operator && !room.operator.closed) return this.error(peer, 'operator_exists', 'この部屋にはすでに操作者がいます');
      } else {
        room = new Room(this.makeCode(), now);
        this.rooms.set(room.code, room);
        this.opts.log(`room ${room.code} created`);
      }
      room.operator = peer;
      room.operatorLostAt = null;
    } else {
      room = m.room ? this.rooms.get(m.room.toUpperCase()) : undefined;
      if (!room) return this.error(peer, 'no_such_room', `部屋 ${m.room ?? ''} は存在しません`);
      if (room.spectators.size >= this.opts.maxSpectators) return this.error(peer, 'room_full', '観戦者が満員です');
      room.spectators.add(peer);
    }
    room.emptySince = null;
    peer.role = m.role;
    peer.room = room;
    peer.applyNet(room.netcfg);
    this.send(peer, {
      t: 'WELCOME',
      room: room.code,
      clientId: peer.id,
      role: m.role,
      server: { dt: PHYSICS.dt, controlRateHz: COMM.controlRateHz, gazeRateHz: COMM.gazeRateHz, mode: this.opts.mode },
      netcfg: room.netcfg,
      ctrlcfg: room.ctrlcfg,
      peers: room.peers.filter((p) => p !== peer).map((p) => ({ clientId: p.id, role: p.role! })),
    });
    // tell the newcomer which trial epoch is current
    this.send(peer, { t: 'EVENT', kind: 'reset', data: { epoch: room.epoch, join: true } });
    this.broadcast(room, { t: 'EVENT', kind: 'peer_join', data: { clientId: peer.id, role: m.role } }, peer);
  }

  private process(peer: Peer, m: Msg, now: number): void {
    const room = peer.room!;
    const isOp = room.operator === peer;
    if (LATEST_ONLY_TYPES.has(m.t) || m.t === 'SYNC_REQ' || m.t === 'PING') {
      const owd = m.t === 'CMD' ? now - (m.ts + m.offset) : undefined;
      const verdict = peer.meter(m.t).observe(m.seq, m.ts, now, owd);
      if (verdict !== 'fresh' && LATEST_ONLY_TYPES.has(m.t)) return;
    }
    switch (m.t) {
      case 'SYNC_REQ':
        // t1 = now (arrival after uplink degradation); t2 is stamped as ts when sent
        this.send(peer, { t: 'SYNC_RESP', t0: m.ts, t1: now });
        return;
      case 'PING':
        this.send(peer, { t: 'PONG', echoSeq: m.seq, echoTs: m.ts });
        return;
      case 'PONG':
        return;
      case 'CMD':
        if (!isOp || m.epoch !== room.epoch) return;
        if (room.slave.receiveCommand({ seq: m.seq, xm: m.xm, vm: m.vm, eIn: m.eIn, eOut: m.eOut, um: m.um }, room.slave.t)) {
          room.lastCmdRecv = now;
        }
        return;
      case 'GAZE':
        if (!isOp) return;
        room.slave.receiveGaze(m.p, m.conf, room.slave.t);
        for (const s of room.spectators) this.send(s, { t: 'GAZE', uv: m.uv, p: m.p, conf: m.conf, hit: m.hit, src: m.src });
        return;
      case 'NETCFG':
        if (!isOp) return this.error(peer, 'forbidden', '観戦者は設定を変更できません');
        room.netcfg = { up: { ...m.up }, down: { ...m.down }, seed: m.seed };
        for (const p of room.peers) {
          p.applyNet(room.netcfg);
          // a new setting starts a new measurement, so histograms compare like with like
          p.up.resetStats();
          p.down.resetStats();
          p.meters.clear();
        }
        this.broadcast(room, { t: 'NETCFG', up: room.netcfg.up, down: room.netcfg.down, seed: room.netcfg.seed });
        return;
      case 'CTRLCFG':
        if (!isOp) return this.error(peer, 'forbidden', '観戦者は設定を変更できません');
        {
          const modeChanged = m.mode !== room.ctrlcfg.mode;
          room.applyCtrl({ mode: m.mode, waveImpedance: m.waveImpedance, gaze: m.gaze });
          this.broadcast(room, { t: 'CTRLCFG', ...room.ctrlcfg });
          if (modeChanged) {
            // a new control mode is a new epoch: both ends restart their energy counters
            room.epoch = (room.epoch + 1) & 0xffff || 1;
            this.broadcast(room, { t: 'EVENT', kind: 'reset', data: { epoch: room.epoch, rebase: true } });
          }
        }
        return;
      case 'RESET':
        if (!isOp) return this.error(peer, 'forbidden', '観戦者は初期化できません');
        room.slave.reset();
        room.epoch = (room.epoch + 1) & 0xffff || 1;
        this.broadcast(room, { t: 'EVENT', kind: 'reset', data: { epoch: room.epoch } });
        return;
      case 'BYE':
        this.onClose(peer, 'bye');
        return;
      default:
        return;
    }
  }

  private onClose(peer: Peer, reason: string): void {
    if (!this.peers.has(peer.id)) return;
    this.peers.delete(peer.id);
    peer.closed = true;
    const room = peer.room;
    if (!room) return;
    const now = this.now;
    if (room.operator === peer) {
      room.operator = null;
      room.operatorLostAt = now;
      this.broadcast(room, { t: 'EVENT', kind: 'operator_lost', data: { clientId: peer.id, reason } });
    } else {
      room.spectators.delete(peer);
    }
    this.broadcast(room, { t: 'EVENT', kind: 'peer_leave', data: { clientId: peer.id, role: peer.role, reason } });
    if (room.peers.length === 0) room.emptySince = now;
  }

  // ---------------------------------------------------------------- periodic work

  /** Advance everything to the current time. Call as often as possible (>= 250 Hz). */
  tick(): void {
    const now = this.now;
    for (const peer of this.peers.values()) {
      if (!peer.room) continue;
      for (const m of peer.up.poll(now)) this.process(peer, m, now);
    }
    for (const room of this.rooms.values()) this.advanceRoom(room, now);
    for (const peer of [...this.peers.values()]) {
      if (peer.room) peer.flush(now);
      if (now - peer.lastHeard > COMM.pingTimeoutMs) {
        this.onClose(peer, 'timeout');
        peer.closeLink();
        continue;
      }
      if (peer.room && now - peer.lastPing > COMM.pingIntervalMs) {
        peer.lastPing = now;
        this.send(peer, { t: 'PING' });
        this.sendStats(peer, now);
      }
    }
    for (const [code, room] of this.rooms) {
      if (room.emptySince !== null && now - room.emptySince > this.opts.roomLingerMs) {
        this.rooms.delete(code);
        this.opts.log(`room ${code} removed`);
      }
    }
  }

  private advanceRoom(room: Room, now: number): void {
    const dtMs = PHYSICS.dt * 1000;
    const wake = now - room.lastAdvance;
    room.lastAdvance = now;
    room.acc += wake;
    room.wakeIntervals.push(wake);
    if (room.wakeIntervals.length > 1000) room.wakeIntervals.shift();
    let n = Math.floor(room.acc / dtMs);
    room.maxBacklog = Math.max(room.maxBacklog, n);
    if (n > PHYSICS.maxCatchUpSteps) {
      room.acc -= (n - PHYSICS.maxCatchUpSteps) * dtMs;
      n = PHYSICS.maxCatchUpSteps;
    }
    const every = Math.round(1 / (COMM.controlRateHz * PHYSICS.dt));
    for (let i = 0; i < n; i++) {
      room.slave.step(PHYSICS.dt);
      room.acc -= dtMs;
      room.stepCount++;
      for (const e of room.slave.drainEvents()) this.broadcast(room, { t: 'EVENT', kind: e.kind, data: e.data });
      if (room.stepCount % every === 0) this.broadcastState(room);
    }
    room.recentSteps.push({ t: now, n });
    while (room.recentSteps.length > 1 && room.recentSteps[0].t < now - 1000) room.recentSteps.shift();
  }

  private broadcastState(room: Room): void {
    const s = room.slave;
    let status = 0;
    if (s.atJointLimit) status |= STATUS_JOINT_LIMIT;
    if (s.oscillating) status |= STATUS_OSCILLATION;
    if (s.damping.lowConfidence) status |= STATUS_GAZE_LOW_CONF;
    const us = s.takeWaveOut();
    const body = {
      t: 'STATE' as const,
      epoch: room.epoch,
      simTime: s.t,
      xs: s.xs,
      vs: s.vs,
      fe: s.fe,
      fc: s.fc,
      xd: s.xd,
      q: s.q,
      b: s.b,
      pcPower: s.pcPower,
      eIn: s.energy.in,
      eOut: s.energy.out,
      eDiss: s.eDiss,
      eGen: s.eGen,
      cmdSeq: s.cmd.seq,
      cmdRecv: room.lastCmdRecv,
      mode: s.mode,
      contact: s.contact,
      attention: s.damping.last.attention,
      obstacle: Math.min(s.damping.last.obstacle, 1e6),
      us,
      hs: s.stored,
      status,
    };
    for (const p of room.peers) this.send(p, body);
  }

  private sendStats(peer: Peer, now: number): void {
    const room = peer.room!;
    const up: Partial<Record<MsgName, StreamStats>> = {};
    for (const [t, m] of peer.meters) up[t] = m.snapshot(now);
    const iv = room.wakeIntervals;
    const mean = iv.reduce((a, b) => a + b, 0) / Math.max(1, iv.length);
    const sd = Math.sqrt(iv.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, iv.length));
    const steps = room.recentSteps.reduce((a, r) => a + r.n, 0);
    const stats: Draft<StatsMsg> = {
      t: 'STATS',
      up,
      degrader: {
        appliedDelayHist: [...peer.up.appliedDelayHist],
        dropped: peer.up.dropped,
        passed: peer.up.passed,
        burstHist: [...peer.up.burstHist],
      },
      sim: { stepHz: steps, periodJitterMs: sd, maxBacklogSteps: room.maxBacklog, meanWakeMs: mean },
    };
    room.maxBacklog = 0;
    this.send(peer, stats);
  }

  /** Close every connection (server shutdown). */
  shutdown(): void {
    for (const p of this.peers.values()) {
      this.send(p, { t: 'BYE', reason: 'shutdown' }, false);
      p.closeLink();
    }
    this.peers.clear();
  }
}
