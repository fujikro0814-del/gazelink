import { describe, expect, it } from 'vitest';
import { Degrader, geTransitions } from '../core/net/degrader.ts';
import { ClockSync } from '../core/net/clocksync.ts';
import { StreamMeter } from '../core/net/stream.ts';
import { Rng } from '../core/math/rng.ts';
import { NET_DEFAULTS } from '../core/config.ts';
import type { NetParams } from '../core/protocol/messages.ts';
import { Hub } from '../core/room/hub.ts';
import { decode, encode, type Frame } from '../core/protocol/codec.ts';
import type { Msg } from '../core/protocol/messages.ts';

const net = (p: Partial<NetParams>): NetParams => ({ ...NET_DEFAULTS, ...p });

/** Push n packets at 10 ms spacing through a degrader; return delivered (seq, delay) pairs. */
function run(p: NetParams, n: number, seed = 7) {
  const d = new Degrader<{ seq: number; sent: number }>(p, seed);
  const out: Array<{ seq: number; delay: number; at: number }> = [];
  let t = 0;
  for (let i = 1; i <= n; i++, t += 10) {
    d.submit({ seq: i, sent: t }, t, 'CMD', true);
    for (const x of d.poll(t)) out.push({ seq: x.seq, delay: t - x.sent, at: t });
  }
  for (let k = 0; k < 10000; k++, t += 1) for (const x of d.poll(t)) out.push({ seq: x.seq, delay: t - x.sent, at: t });
  return { out, d };
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
};

describe('degrader', () => {
  it('applies a fixed delay', () => {
    const { out } = run(net({ delayMs: 200 }), 500);
    expect(out.length).toBe(500);
    // delivery is polled at 10 ms granularity during sending, so delays are 200..209
    for (const o of out) expect(o.delay).toBeGreaterThanOrEqual(200);
    expect(mean(out.map((o) => o.delay))).toBeLessThan(210);
  });

  it('applies Gaussian jitter with the requested spread when reordering is allowed', () => {
    const d = new Degrader<number>(net({ delayMs: 300, jitterMs: 40, allowReorder: true }), 3);
    for (let i = 0; i < 20000; i++) d.submit(i, i * 10, 'CMD', true);
    // read the applied delays from the histogram (10 ms bins)
    const h = d.appliedDelayHist;
    const xs: number[] = [];
    h.forEach((c, i) => {
      for (let k = 0; k < c; k++) xs.push(i * 10 + 5);
    });
    expect(mean(xs)).toBeGreaterThan(295);
    expect(mean(xs)).toBeLessThan(310);
    expect(sd(xs)).toBeGreaterThan(36);
    expect(sd(xs)).toBeLessThan(45);
  });

  it('keeps FIFO order unless reordering is allowed', () => {
    const fifo = run(net({ delayMs: 100, jitterMs: 50, allowReorder: false }), 2000).out;
    const seqs = fifo.map((o) => o.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const reord = run(net({ delayMs: 100, jitterMs: 50, allowReorder: true }), 2000).out.map((o) => o.seq);
    let inversions = 0;
    for (let i = 1; i < reord.length; i++) if (reord[i] < reord[i - 1]) inversions++;
    expect(inversions).toBeGreaterThan(50);
  });

  it('Bernoulli loss matches the requested ratio', () => {
    const { out, d } = run(net({ loss: 0.2 }), 20000);
    const ratio = 1 - out.length / 20000;
    expect(ratio).toBeGreaterThan(0.185);
    expect(ratio).toBeLessThan(0.215);
    expect(d.dropped).toBe(20000 - out.length);
  });

  it('Gilbert-Elliott loss matches the long-run ratio and mean burst length', () => {
    const { pGB, pBG } = geTransitions(0.1, 5);
    expect(pBG).toBeCloseTo(0.2, 9);
    expect(pGB / (pGB + pBG)).toBeCloseTo(0.1, 9); // stationary probability of the bad state
    const { out, d } = run(net({ loss: 0.1, burst: true, burstLength: 5 }), 50000);
    const ratio = 1 - out.length / 50000;
    expect(ratio).toBeGreaterThan(0.085);
    expect(ratio).toBeLessThan(0.115);
    // mean burst length from the recorded run-length histogram
    let runs = 0;
    let lost = 0;
    d.burstHist.forEach((c, len) => {
      runs += c;
      lost += c * len;
    });
    expect(lost / runs).toBeGreaterThan(4.3);
    expect(lost / runs).toBeLessThan(5.7);
  });

  it('streams are independent per message type', () => {
    const d = new Degrader<string>(net({ loss: 0.5 }), 11);
    const a: boolean[] = [];
    const b: boolean[] = [];
    for (let i = 0; i < 200; i++) {
      a.push(d.submit('a', i, 'CMD', true));
      b.push(d.submit('b', i, 'GAZE', true));
    }
    expect(a).not.toEqual(b);
  });

  it('never drops control messages', () => {
    const d = new Degrader<number>(net({ loss: 0.9 }), 1);
    for (let i = 0; i < 100; i++) expect(d.submit(i, i, 'NETCFG', false)).toBe(true);
  });
});

describe('stream meter', () => {
  it('counts loss, late and duplicate packets and estimates RFC 3550 jitter', () => {
    const m = new StreamMeter();
    const order = [1, 2, 3, 5, 4, 4, 7, 8, 10];
    for (const s of order) m.observe(s, s * 10, s * 10 + 50);
    expect(m.received).toBe(8); // 4 counted once, the second 4 is a duplicate
    expect(m.duplicate).toBe(1);
    expect(m.late).toBe(1); // 4 after 5
    expect(m.lost).toBe(2); // 6 and 9
    expect(m.jitterMs).toBe(0); // constant transit time -> zero jitter
    const j = new StreamMeter();
    const rng = new Rng(5);
    for (let s = 1; s <= 5000; s++) j.observe(s, s * 10, s * 10 + 50 + 10 * rng.gauss());
    // for i.i.d. Gaussian transit with sigma, E|D| = 2 sigma / sqrt(pi) ~ 11.3 ms
    expect(j.jitterMs).toBeGreaterThan(9);
    expect(j.jitterMs).toBeLessThan(13.5);
  });
});

describe('clock synchronization', () => {
  it('recovers a deliberately shifted client clock under symmetric jittered delay', () => {
    const OFFSET = 123456.789; // server - client [ms]
    const rng = new Rng(9);
    const cs = new ClockSync(8);
    let client = 1000;
    for (let i = 0; i < 40; i++, client += 500) {
      const t0 = client;
      const up = 40 + Math.abs(8 * rng.gauss());
      const down = 40 + Math.abs(8 * rng.gauss());
      const t1 = t0 + OFFSET + up;
      const t2 = t1 + 0.2;
      const t3 = t2 - OFFSET + down;
      cs.add(t0, t1, t2, t3);
    }
    // min-delay filter picks a sample where both legs were close to 40 ms
    expect(Math.abs(cs.offset - OFFSET)).toBeLessThan(3);
    expect(cs.rtt).toBeGreaterThan(80);
    expect(cs.rtt).toBeLessThan(90);
  });

  it('has the textbook bias (up - down) / 2 under asymmetric delay', () => {
    const cs = new ClockSync(1);
    const OFFSET = -5000;
    const t0 = 0;
    const t1 = t0 + OFFSET + 30; // uplink 30 ms
    const t2 = t1;
    const t3 = t2 - OFFSET + 90; // downlink 90 ms
    cs.add(t0, t1, t2, t3);
    expect(cs.offset - OFFSET).toBeCloseTo((30 - 90) / 2, 9);
  });

  it('end to end through the hub: estimates the offset of a client with a skewed clock', () => {
    let serverNow = 50_000;
    const SKEW = -987.5; // client clock = server clock + 987.5 ms  =>  offset (S - C) = -987.5
    const hub = new Hub({ now: () => serverNow, mode: 'network' });
    const inbox: Msg[] = [];
    const conn = hub.connect({ send: (f: Frame) => inbox.push(decode(f)), close: () => {} }, 'ws');
    const clientNow = () => serverNow - SKEW;
    let seq = 1;
    const send = (m: Record<string, unknown>) => conn.receive(encode({ seq: seq++, ts: clientNow(), ...m } as Msg));
    send({ t: 'HELLO', role: 'operator', room: null, transport: 'ws', proto: 1 });
    // 60 ms artificial one-way delay in each direction
    send({ t: 'NETCFG', up: net({ delayMs: 60 }), down: net({ delayMs: 60 }), seed: 1 });
    const cs = new ClockSync();
    for (let k = 0; k < 3000; k++) {
      if (k % 200 === 100) send({ t: 'SYNC_REQ' });
      serverNow += 1;
      hub.tick();
      while (inbox.length) {
        const m = inbox.shift()!;
        if (m.t === 'SYNC_RESP') cs.add(m.t0, m.t1, m.ts, clientNow());
      }
    }
    expect(cs.synced).toBe(true);
    expect(cs.offset).toBeCloseTo(SKEW, 0);
    expect(cs.rtt).toBeGreaterThanOrEqual(119);
    expect(cs.rtt).toBeLessThanOrEqual(123);
  });
});
