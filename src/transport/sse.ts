// SSE downlink + batched HTTP POST uplink (docs/PROTOCOL.md §2). At most one POST is in flight,
// so the uplink stays ordered; messages queued meanwhile go in the next batch.
import { COMM } from '../../core/config.ts';
import { unwrapText, wrapText, type Frame } from '../../core/protocol/codec.ts';
import { noop, type Transport } from './types.ts';

export class SseTransport implements Transport {
  readonly kind = 'sse' as const;
  onFrame: (frame: Frame) => void = noop;
  onClose: (reason: string) => void = noop;
  private es: EventSource | null = null;
  private cid = '';
  private queue: string[] = [];
  private inFlight = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  open(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof EventSource === 'undefined') {
        reject(new Error('EventSource unavailable'));
        return;
      }
      const es = new EventSource('/api/sse');
      this.es = es;
      let opened = false;
      const timer = setTimeout(() => {
        if (!opened) {
          es.close();
          reject(new Error('SSE timeout'));
        }
      }, timeoutMs);
      es.addEventListener('open', (e) => {
        // our named "open" event carries the connection id (the native onopen has no data)
        const data = (e as MessageEvent).data;
        if (typeof data !== 'string') return;
        try {
          this.cid = JSON.parse(data).cid;
        } catch {
          return;
        }
        opened = true;
        clearTimeout(timer);
        this.timer = setInterval(() => this.flush(), COMM.sseBatchMs);
        resolve();
      });
      es.onmessage = (e) => {
        try {
          this.onFrame(unwrapText(e.data));
        } catch {
          /* ignore malformed */
        }
      };
      es.onerror = () => {
        if (!opened) {
          clearTimeout(timer);
          es.close();
          reject(new Error('SSE error'));
        } else if (es.readyState === EventSource.CLOSED) {
          this.shutdown('SSE closed');
        }
        // CONNECTING: the browser retries automatically, but the server-side connection id is gone
        else this.shutdown('SSE connection lost');
      };
    });
  }

  send(frame: Frame): void {
    if (!this.closed) this.queue.push(wrapText(frame));
  }

  private flush(): void {
    if (this.inFlight || this.queue.length === 0 || this.closed) return;
    const batch = this.queue;
    this.queue = [];
    this.inFlight = true;
    fetch(`/api/sse/send?cid=${encodeURIComponent(this.cid)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(batch),
      keepalive: false,
    })
      .then((r) => {
        if (r.status === 404) this.shutdown('SSE connection unknown to server');
      })
      .catch(() => this.shutdown('POST failed'))
      .finally(() => {
        this.inFlight = false;
      });
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.es?.close();
    this.onClose(reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    if (this.timer) clearInterval(this.timer);
    this.es?.close();
  }
}
