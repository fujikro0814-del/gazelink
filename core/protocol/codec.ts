// GLP/1 encoder / decoder. Binary frames use a 16-byte header (type, ver, flags, seq, ts),
// little-endian, fixed layouts as documented in docs/PROTOCOL.md §4.
import type { Vec3 } from '../math/vec.ts';
import {
  BINARY_SIZE,
  BINARY_TYPES,
  MODE_CODE,
  MODE_OF_CODE,
  NAME_OF_CODE,
  PROTO_VERSION,
  TYPE,
  type Msg,
  type MsgName,
} from './messages.ts';

export type Frame = Uint8Array | string;

const LE = true;

class Writer {
  readonly buf: Uint8Array;
  readonly dv: DataView;
  off = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(size);
    this.dv = new DataView(this.buf.buffer);
  }
  u8(v: number) {
    this.dv.setUint8(this.off, v);
    this.off += 1;
  }
  u16(v: number) {
    this.dv.setUint16(this.off, v, LE);
    this.off += 2;
  }
  u32(v: number) {
    this.dv.setUint32(this.off, v >>> 0, LE);
    this.off += 4;
  }
  f32(v: number) {
    this.dv.setFloat32(this.off, v, LE);
    this.off += 4;
  }
  f64(v: number) {
    this.dv.setFloat64(this.off, v, LE);
    this.off += 8;
  }
  vec(v: ArrayLike<number>, n = 3) {
    for (let i = 0; i < n; i++) this.f32(v[i]);
  }
}

class Reader {
  readonly dv: DataView;
  off = 0;
  constructor(bytes: Uint8Array) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8() {
    return this.dv.getUint8(this.off++);
  }
  u16() {
    const v = this.dv.getUint16(this.off, LE);
    this.off += 2;
    return v;
  }
  u32() {
    const v = this.dv.getUint32(this.off, LE);
    this.off += 4;
    return v;
  }
  f32() {
    const v = this.dv.getFloat32(this.off, LE);
    this.off += 4;
    return v;
  }
  f64() {
    const v = this.dv.getFloat64(this.off, LE);
    this.off += 8;
    return v;
  }
  vec3(): Vec3 {
    return [this.f32(), this.f32(), this.f32()];
  }
}

function header(w: Writer, name: MsgName, flags: number, seq: number, ts: number) {
  w.u8(TYPE[name]);
  w.u8(PROTO_VERSION);
  w.u16(flags & 0xffff);
  w.u32(seq);
  w.f64(ts);
}

export function encode(m: Msg): Frame {
  if (!BINARY_TYPES.has(m.t)) return JSON.stringify(m);
  const w = new Writer(BINARY_SIZE[m.t]!);
  const flags = m.t === 'CMD' || m.t === 'STATE' ? m.epoch : 0;
  header(w, m.t, flags, m.seq, m.ts);
  switch (m.t) {
    case 'SYNC_REQ':
    case 'PING':
      break;
    case 'SYNC_RESP':
      w.f64(m.t0);
      w.f64(m.t1);
      break;
    case 'PONG':
      w.u32(m.echoSeq);
      w.f64(m.echoTs);
      break;
    case 'CMD':
      w.vec(m.xm);
      w.vec(m.vm);
      w.f64(m.eIn);
      w.f64(m.eOut);
      w.f64(m.offset);
      w.vec(m.xh);
      w.vec(m.um);
      break;
    case 'STATE':
      w.f64(m.simTime);
      w.vec(m.xs);
      w.vec(m.vs);
      w.vec(m.fe);
      w.vec(m.fc);
      w.vec(m.xd);
      w.vec(m.q, 7);
      w.f32(m.b);
      w.f32(m.pcPower);
      w.f64(m.eIn);
      w.f64(m.eOut);
      w.f64(m.eDiss);
      w.f64(m.eGen);
      w.u32(m.cmdSeq);
      w.f64(m.cmdRecv);
      w.u8(MODE_CODE[m.mode]);
      w.u8(m.contact);
      w.f32(m.attention);
      w.f32(m.obstacle);
      w.vec(m.us);
      w.f32(m.hs);
      w.u16(m.status);
      break;
    case 'GAZE':
      w.f32(m.uv[0]);
      w.f32(m.uv[1]);
      w.vec(m.p);
      w.f32(m.conf);
      w.u8(m.hit);
      w.u8(m.src);
      break;
  }
  if (w.off !== w.buf.length) throw new Error(`encode ${m.t}: wrote ${w.off} of ${w.buf.length} bytes`);
  return w.buf;
}

export class DecodeError extends Error {}

function decodeBinary(bytes: Uint8Array): Msg {
  if (bytes.byteLength < 16) throw new DecodeError('short frame');
  const r = new Reader(bytes);
  const code = r.u8();
  const ver = r.u8();
  const epoch = r.u16();
  const seq = r.u32();
  const ts = r.f64();
  const t = NAME_OF_CODE[code];
  if (!t || !BINARY_TYPES.has(t)) throw new DecodeError(`unknown binary type 0x${code.toString(16)}`);
  if (ver !== PROTO_VERSION) throw new DecodeError(`version ${ver}`);
  if (bytes.byteLength !== BINARY_SIZE[t]) throw new DecodeError(`${t}: size ${bytes.byteLength} != ${BINARY_SIZE[t]}`);
  switch (t) {
    case 'SYNC_REQ':
    case 'PING':
      return { t, seq, ts };
    case 'SYNC_RESP':
      return { t, seq, ts, t0: r.f64(), t1: r.f64() };
    case 'PONG':
      return { t, seq, ts, echoSeq: r.u32(), echoTs: r.f64() };
    case 'CMD':
      return {
        t, seq, ts, epoch, xm: r.vec3(), vm: r.vec3(), eIn: r.f64(), eOut: r.f64(), offset: r.f64(), xh: r.vec3(), um: r.vec3(),
      };
    case 'STATE': {
      const simTime = r.f64();
      const xs = r.vec3();
      const vs = r.vec3();
      const fe = r.vec3();
      const fc = r.vec3();
      const xd = r.vec3();
      const q: number[] = [];
      for (let i = 0; i < 7; i++) q.push(r.f32());
      const b = r.f32();
      const pcPower = r.f32();
      const eIn = r.f64();
      const eOut = r.f64();
      const eDiss = r.f64();
      const eGen = r.f64();
      const cmdSeq = r.u32();
      const cmdRecv = r.f64();
      const mode = MODE_OF_CODE[r.u8()] ?? 'none';
      const contact = r.u8();
      const attention = r.f32();
      const obstacle = r.f32();
      const us = r.vec3();
      const hs = r.f32();
      const status = r.u16();
      return {
        t, seq, ts, epoch, simTime, xs, vs, fe, fc, xd, q, b, pcPower, eIn, eOut, eDiss, eGen,
        cmdSeq, cmdRecv, mode, contact, attention, obstacle, us, hs, status,
      };
    }
    case 'GAZE':
      return { t, seq, ts, uv: [r.f32(), r.f32()], p: r.vec3(), conf: r.f32(), hit: r.u8(), src: r.u8() };
  }
  throw new DecodeError(`unhandled ${t}`);
}

function decodeJson(text: string): Msg {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new DecodeError('invalid JSON');
  }
  if (!obj || typeof obj !== 'object') throw new DecodeError('not an object');
  const m = obj as { t?: unknown; seq?: unknown; ts?: unknown };
  if (typeof m.t !== 'string' || !(m.t in TYPE) || BINARY_TYPES.has(m.t as MsgName)) {
    throw new DecodeError(`unknown JSON type ${String(m.t)}`);
  }
  if (typeof m.seq !== 'number' || typeof m.ts !== 'number') throw new DecodeError('missing seq/ts');
  return obj as Msg;
}

export function decode(frame: Frame | ArrayBuffer): Msg {
  if (typeof frame === 'string') return decodeJson(frame);
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  return decodeBinary(bytes);
}

/** Message type name of a raw frame without fully decoding it (for logging). */
export function peekType(frame: Frame): MsgName | undefined {
  if (typeof frame === 'string') {
    const m = /"t"\s*:\s*"([A-Z_]+)"/.exec(frame);
    return m ? (m[1] as MsgName) : undefined;
  }
  return NAME_OF_CODE[frame[0]];
}

export function frameSize(frame: Frame): number {
  return typeof frame === 'string' ? new TextEncoder().encode(frame).length : frame.byteLength;
}

// --- text-safe wrapping for SSE / POST batching (docs/PROTOCOL.md §2) ---

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function wrapText(frame: Frame): string {
  return typeof frame === 'string' ? `j:${frame}` : `b:${toBase64(frame)}`;
}

export function unwrapText(s: string): Frame {
  if (s.startsWith('j:')) return s.slice(2);
  if (s.startsWith('b:')) return fromBase64(s.slice(2));
  throw new DecodeError('bad text wrapping');
}

/** Hex dump "10 01 00 00 ..." for the protocol inspector. */
export function hex(bytes: Uint8Array, max = 256): string {
  const n = Math.min(bytes.length, max);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(bytes[i].toString(16).padStart(2, '0'));
  return parts.join(' ') + (bytes.length > max ? ' …' : '');
}
