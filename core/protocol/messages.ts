// GLP/1 message definitions. See docs/PROTOCOL.md for the normative description.
import type { Vec3 } from '../math/vec.ts';

export const PROTO_VERSION = 1;

export const TYPE = {
  HELLO: 0x01,
  WELCOME: 0x02,
  SYNC_REQ: 0x03,
  SYNC_RESP: 0x04,
  CMD: 0x10,
  STATE: 0x11,
  GAZE: 0x12,
  NETCFG: 0x20,
  CTRLCFG: 0x21,
  RESET: 0x22,
  EVENT: 0x30,
  STATS: 0x31,
  PING: 0x40,
  PONG: 0x41,
  ERROR: 0x7e,
  BYE: 0x7f,
} as const;

export type MsgName = keyof typeof TYPE;
export const MSG_NAMES = Object.keys(TYPE) as MsgName[];
export const NAME_OF_CODE: Record<number, MsgName> = Object.fromEntries(
  MSG_NAMES.map((n) => [TYPE[n], n]),
) as Record<number, MsgName>;

/** Types encoded as fixed-size binary frames. */
export const BINARY_TYPES: ReadonlySet<MsgName> = new Set<MsgName>(['SYNC_REQ', 'SYNC_RESP', 'CMD', 'STATE', 'GAZE', 'PING', 'PONG']);
/** Types subject to artificial loss (the rest are only delayed). */
export const LOSSY_TYPES: ReadonlySet<MsgName> = BINARY_TYPES;
/** Types with latest-value semantics: stale or duplicate sequence numbers are discarded. */
export const LATEST_ONLY_TYPES: ReadonlySet<MsgName> = new Set<MsgName>(['CMD', 'STATE', 'GAZE']);

export const BINARY_SIZE: Partial<Record<MsgName, number>> = {
  SYNC_REQ: 16,
  SYNC_RESP: 32,
  CMD: 88,
  STATE: 192,
  GAZE: 42,
  PING: 16,
  PONG: 28,
};

export type Role = 'operator' | 'spectator';
export type TransportKind = 'ws' | 'sse' | 'worker';
export type ControlMode = 'none' | 'tdpa' | 'wave';
export const MODE_CODE: Record<ControlMode, number> = { none: 0, tdpa: 1, wave: 2 };
export const MODE_OF_CODE: ControlMode[] = ['none', 'tdpa', 'wave'];

export interface NetParams {
  delayMs: number;
  jitterMs: number;
  allowReorder: boolean;
  loss: number;
  burst: boolean;
  burstLength: number;
}

export interface NetConfig {
  up: NetParams;
  down: NetParams;
  seed: number;
}

/** Where the gaze-adaptive damper acts: on the local master mass or on the remote slave tip. */
export type DampingTarget = 'master' | 'slave';

export interface GazeParams {
  enabled: boolean;
  target: DampingTarget;
  forgetTau: number;
  bMin: number;
  bMax: number;
  slewRate: number;
  sigma: number;
}

export interface CtrlConfig {
  mode: ControlMode;
  waveImpedance: number;
  gaze: GazeParams;
}

interface Base {
  seq: number;
  ts: number;
}

export interface HelloMsg extends Base {
  t: 'HELLO';
  role: Role;
  room: string | null;
  transport: TransportKind;
  proto: number;
}

export interface PeerInfo {
  clientId: number;
  role: Role;
}

export interface WelcomeMsg extends Base {
  t: 'WELCOME';
  room: string;
  clientId: number;
  role: Role;
  server: { dt: number; controlRateHz: number; gazeRateHz: number; mode: 'network' | 'local' };
  netcfg: NetConfig;
  ctrlcfg: CtrlConfig;
  peers: PeerInfo[];
}

export interface SyncReqMsg extends Base {
  t: 'SYNC_REQ';
}

export interface SyncRespMsg extends Base {
  t: 'SYNC_RESP';
  t0: number;
  t1: number;
}

export interface CmdMsg extends Base {
  t: 'CMD';
  /** trial epoch (header flags); messages from another epoch are ignored */
  epoch: number;
  xm: Vec3;
  vm: Vec3;
  eIn: number;
  eOut: number;
  offset: number;
  xh: Vec3;
  um: Vec3;
}

export const STATUS_JOINT_LIMIT = 1;
export const STATUS_OSCILLATION = 2;
export const STATUS_GAZE_LOW_CONF = 4;

export interface StateMsg extends Base {
  t: 'STATE';
  /** trial epoch (header flags) */
  epoch: number;
  simTime: number;
  xs: Vec3;
  vs: Vec3;
  fe: Vec3;
  fc: Vec3;
  xd: Vec3;
  q: number[];
  b: number;
  pcPower: number;
  eIn: number;
  eOut: number;
  eDiss: number;
  eGen: number;
  cmdSeq: number;
  cmdRecv: number;
  mode: ControlMode;
  contact: number;
  attention: number;
  obstacle: number;
  us: Vec3;
  hs: number;
  status: number;
}

export const HIT_NONE = 0;
export const HIT_FLOOR = 1;
export const HIT_WALL = 2;
export const HIT_TARGET = 3;
export const HIT_RING = 4;

export interface GazeMsg extends Base {
  t: 'GAZE';
  uv: [number, number];
  p: Vec3;
  conf: number;
  hit: number;
  /** 0 = camera, 1 = mouse fallback */
  src: number;
}

export interface NetCfgMsg extends Base, NetConfig {
  t: 'NETCFG';
}

export interface CtrlCfgMsg extends Base, CtrlConfig {
  t: 'CTRLCFG';
}

export interface ResetMsg extends Base {
  t: 'RESET';
}

export type EventKind =
  | 'contact_start'
  | 'contact_end'
  | 'ring'
  | 'target'
  | 'oscillation'
  | 'peer_join'
  | 'peer_leave'
  | 'reset'
  | 'operator_lost';

export interface EventMsg extends Base {
  t: 'EVENT';
  kind: EventKind;
  data: Record<string, unknown>;
}

export interface StreamStats {
  received: number;
  lost: number;
  late: number;
  duplicate: number;
  rateHz: number;
  jitterMs: number;
  owdHist: number[];
}

export interface StatsMsg extends Base {
  t: 'STATS';
  /** Uplink measurements per message type, as observed by the server. */
  up: Partial<Record<MsgName, StreamStats>>;
  /** What the degrader actually did on this client's uplink. */
  degrader: { appliedDelayHist: number[]; dropped: number; passed: number; burstHist: number[] };
  sim: { stepHz: number; periodJitterMs: number; maxBacklogSteps: number; meanWakeMs: number };
}

export interface PingMsg extends Base {
  t: 'PING';
}

export interface PongMsg extends Base {
  t: 'PONG';
  echoSeq: number;
  echoTs: number;
}

export type ErrorCode = 'no_such_room' | 'operator_exists' | 'forbidden' | 'bad_message' | 'version' | 'room_full';

export interface ErrorMsg extends Base {
  t: 'ERROR';
  code: ErrorCode;
  message: string;
}

export interface ByeMsg extends Base {
  t: 'BYE';
  reason: string;
}

export type Msg =
  | HelloMsg
  | WelcomeMsg
  | SyncReqMsg
  | SyncRespMsg
  | CmdMsg
  | StateMsg
  | GazeMsg
  | NetCfgMsg
  | CtrlCfgMsg
  | ResetMsg
  | EventMsg
  | StatsMsg
  | PingMsg
  | PongMsg
  | ErrorMsg
  | ByeMsg;

export type MsgOf<N extends MsgName> = Extract<Msg, { t: N }>;

/** A message body before the sender stamps seq and ts. */
export type Draft<M extends Msg = Msg> = M extends Msg ? Omit<M, 'seq' | 'ts'> : never;

/** Histogram bins for one-way delay: 10 ms wide, 0..1000 ms + overflow. */
export const OWD_BIN_MS = 10;
export const OWD_BINS = 101;
export function owdBin(ms: number): number {
  return Math.max(0, Math.min(OWD_BINS - 1, Math.floor(ms / OWD_BIN_MS)));
}
