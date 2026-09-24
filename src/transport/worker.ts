import type { Frame } from '../../core/protocol/codec.ts';
import { noop, type Transport } from './types.ts';

export class WorkerTransport implements Transport {
  readonly kind = 'worker' as const;
  onFrame: (frame: Frame) => void = noop;
  onClose: (reason: string) => void = noop;
  private worker: Worker | null = null;

  open(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let w: Worker;
      try {
        w = new Worker(new URL('./hubWorker.ts', import.meta.url), { type: 'module' });
      } catch (e) {
        reject(e);
        return;
      }
      this.worker = w;
      const timer = setTimeout(() => reject(new Error('Worker timeout')), timeoutMs);
      w.onmessage = (e: MessageEvent) => {
        const d = e.data as { ready?: boolean; frame?: Frame; closed?: boolean };
        if (d.ready) {
          clearTimeout(timer);
          resolve();
        } else if (d.frame !== undefined) {
          this.onFrame(d.frame);
        } else if (d.closed) {
          this.onClose('worker hub closed the link');
        }
      };
      w.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(`Worker error: ${e.message}`));
      };
    });
  }

  send(frame: Frame): void {
    this.worker?.postMessage({ frame });
  }

  close(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
