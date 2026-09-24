// Fallback chain WebSocket -> SSE + POST -> in-browser Worker (task spec §2).
import type { TransportKind } from '../../core/protocol/messages.ts';
import { SseTransport } from './sse.ts';
import type { Transport } from './types.ts';
import { WorkerTransport } from './worker.ts';
import { WsTransport } from './ws.ts';

export const TRANSPORT_LABEL: Record<TransportKind, string> = {
  ws: 'WebSocket',
  sse: 'SSE + POST',
  worker: '一人用モード（Worker）',
};

const factories: Record<TransportKind, () => Transport> = {
  ws: () => new WsTransport(),
  sse: () => new SseTransport(),
  worker: () => new WorkerTransport(),
};

/** Order to try, honoring ?transport=ws|sse|worker (a forced kind is tried first). */
export function transportOrder(forced?: string | null): TransportKind[] {
  const all: TransportKind[] = ['ws', 'sse', 'worker'];
  if (forced === 'sse') return ['sse', 'worker'];
  if (forced === 'worker') return ['worker'];
  return all;
}

export interface AttemptLog {
  kind: TransportKind;
  ok: boolean;
  error?: string;
}

export async function connectFirst(
  order: TransportKind[],
  timeoutMs: number,
  log: (a: AttemptLog) => void,
): Promise<Transport> {
  let lastErr: unknown = null;
  for (const kind of order) {
    const t = factories[kind]();
    try {
      await t.open(kind === 'worker' ? 10000 : timeoutMs);
      log({ kind, ok: true });
      return t;
    } catch (e) {
      lastErr = e;
      log({ kind, ok: false, error: e instanceof Error ? e.message : String(e) });
      try {
        t.close();
      } catch {
        /* ignore */
      }
    }
  }
  throw lastErr ?? new Error('no transport');
}
