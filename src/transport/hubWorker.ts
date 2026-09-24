// Single-player fallback: the whole server-side hub runs in this Worker (docs/PROTOCOL.md §2).
import { Hub } from '../../core/room/hub.ts';
import type { Frame } from '../../core/protocol/codec.ts';

const hub = new Hub({ now: () => performance.timeOrigin + performance.now(), mode: 'local' });
const scope = self as unknown as {
  postMessage: (m: unknown, transfer?: Transferable[]) => void;
  onmessage: ((e: MessageEvent) => void) | null;
};

const conn = hub.connect(
  {
    send: (frame: Frame) => scope.postMessage({ frame }),
    close: () => scope.postMessage({ closed: true }),
  },
  'worker',
);

scope.onmessage = (e: MessageEvent) => {
  const d = e.data as { frame?: Frame; close?: boolean };
  if (d.close) conn.close();
  else if (d.frame !== undefined) conn.receive(d.frame);
};

// Worker timers are not throttled like background tabs; 1 ms requests are honored at ~1-4 ms.
setInterval(() => hub.tick(), 1);
scope.postMessage({ ready: true });
