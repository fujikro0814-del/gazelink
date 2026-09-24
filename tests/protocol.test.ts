import { describe, expect, it } from 'vitest';
import { DecodeError, decode, encode, unwrapText, wrapText } from '../core/protocol/codec.ts';
import { BINARY_SIZE, type Msg } from '../core/protocol/messages.ts';
import { defaultCtrlConfig, defaultNetConfig } from '../core/room/hub.ts';

const f32 = (x: number) => Math.fround(x);
const v = (a: number, b: number, c: number): [number, number, number] => [f32(a), f32(b), f32(c)];

const samples: Msg[] = [
  { t: 'HELLO', seq: 1, ts: 12.5, role: 'operator', room: null, transport: 'ws', proto: 1 },
  {
    t: 'WELCOME', seq: 1, ts: 99.25, room: 'K7Q2', clientId: 3, role: 'spectator',
    server: { dt: 0.001, controlRateHz: 100, gazeRateHz: 30, mode: 'network' },
    netcfg: defaultNetConfig(), ctrlcfg: defaultCtrlConfig(), peers: [{ clientId: 1, role: 'operator' }],
  },
  { t: 'SYNC_REQ', seq: 7, ts: 1790242162013.125 },
  { t: 'SYNC_RESP', seq: 7, ts: 1790242162020.5, t0: 1790242162013.125, t1: 1790242162019.75 },
  {
    t: 'CMD', seq: 123456, ts: 5000.5, epoch: 3, xm: v(0.4, -0.1, 0.3), vm: v(0.01, -0.2, 0.003),
    eIn: 1.234567890123, eOut: 0.000123456789, offset: -12.345, xh: v(0.41, -0.11, 0.29), um: v(1, -2, 3),
  },
  {
    t: 'STATE', seq: 99, ts: 6000.25, epoch: 3, simTime: 12.345, xs: v(0.5, 0.1, 0.2), vs: v(-0.1, 0, 0.1),
    fe: v(-12.5, 0, 0), fc: v(-11, 0.5, 0.25), xd: v(0.51, 0.1, 0.2), q: [0, -0.785, 0, -2.356, 0, 1.571, 0.785].map(f32),
    b: f32(33.5), pcPower: f32(1.25), eIn: 2.5, eOut: 3.75, eDiss: 0.125, eGen: -0.0625, cmdSeq: 123456,
    cmdRecv: 1790242162019.75, mode: 'tdpa', contact: 5, attention: f32(0.75), obstacle: f32(0.02), us: v(0.1, 0.2, 0.3),
    hs: f32(0.5), status: 3,
  },
  { t: 'GAZE', seq: 5, ts: 7000, uv: [f32(0.25), f32(0.75)], p: v(0.6, 0.2, 0.0), conf: f32(0.9), hit: 3, src: 1 },
  { t: 'NETCFG', seq: 2, ts: 1, ...defaultNetConfig() },
  { t: 'CTRLCFG', seq: 2, ts: 1, ...defaultCtrlConfig() },
  { t: 'RESET', seq: 4, ts: 2 },
  { t: 'EVENT', seq: 8, ts: 3, kind: 'contact_start', data: { surface: 'wall', force: 12.3 } },
  {
    t: 'STATS', seq: 3, ts: 4,
    up: { CMD: { received: 95, lost: 5, late: 1, duplicate: 0, rateHz: 99, jitterMs: 1.5, owdHist: [0, 3, 90] } },
    degrader: { appliedDelayHist: [0, 0, 100], dropped: 5, passed: 95, burstHist: [0, 3, 1] },
    sim: { stepHz: 1000, periodJitterMs: 0.8, maxBacklogSteps: 12, meanWakeMs: 1.2 },
  },
  { t: 'PING', seq: 11, ts: 4.5 },
  { t: 'PONG', seq: 12, ts: 5.5, echoSeq: 11, echoTs: 4.5 },
  { t: 'ERROR', seq: 1, ts: 0, code: 'no_such_room', message: '部屋 ABCD は存在しません' },
  { t: 'BYE', seq: 9, ts: 10, reason: 'user' },
];

describe('GLP/1 codec', () => {
  for (const m of samples) {
    it(`round-trips ${m.t}`, () => {
      const frame = encode(m);
      const size = BINARY_SIZE[m.t];
      if (size !== undefined) {
        expect(frame).toBeInstanceOf(Uint8Array);
        expect((frame as Uint8Array).byteLength).toBe(size);
        expect((frame as Uint8Array)[1]).toBe(1); // version
      } else {
        expect(typeof frame).toBe('string');
      }
      expect(decode(frame)).toEqual(m);
      // text wrapping used by SSE / POST
      expect(decode(unwrapText(wrapText(frame)))).toEqual(m);
    });
  }

  it('puts the trial epoch into the header flags of CMD', () => {
    const frame = encode(samples[4]) as Uint8Array;
    expect(new DataView(frame.buffer).getUint16(2, true)).toBe(3);
  });

  it('rejects malformed frames', () => {
    expect(() => decode(new Uint8Array([0x10, 1, 0, 0]))).toThrow(DecodeError);
    const bad = encode(samples[4]) as Uint8Array;
    expect(() => decode(bad.slice(0, 80))).toThrow(DecodeError);
    const wrongVer = bad.slice();
    wrongVer[1] = 2;
    expect(() => decode(wrongVer)).toThrow(DecodeError);
    expect(() => decode('{"t":"NOPE","seq":1,"ts":0}')).toThrow(DecodeError);
    expect(() => decode('not json')).toThrow(DecodeError);
    expect(() => decode('{"t":"CMD","seq":1,"ts":0}')).toThrow(DecodeError); // CMD must be binary
  });
});
