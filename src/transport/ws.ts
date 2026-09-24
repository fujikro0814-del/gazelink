import type { Frame } from '../../core/protocol/codec.ts';
import { noop, type Transport } from './types.ts';

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

export class WsTransport implements Transport {
  readonly kind = 'ws' as const;
  onFrame: (frame: Frame) => void = noop;
  onClose: (reason: string) => void = noop;
  private ws: WebSocket | null = null;
  private opened = false;

  open(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl('/ws'));
      } catch (e) {
        reject(e);
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const timer = setTimeout(() => {
        if (!this.opened) {
          ws.close();
          reject(new Error('WebSocket timeout'));
        }
      }, timeoutMs);
      ws.onopen = () => {
        this.opened = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        if (!this.opened) {
          clearTimeout(timer);
          reject(new Error('WebSocket error'));
        }
      };
      ws.onclose = (e) => {
        if (this.opened) this.onClose(`WebSocket closed (${e.code})`);
      };
      ws.onmessage = (e) => {
        this.onFrame(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
      };
    });
  }

  send(frame: Frame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(frame as string | Uint8Array<ArrayBuffer>);
  }

  close(): void {
    this.opened = false;
    this.ws?.close();
  }
}
