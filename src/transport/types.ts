import type { Frame } from '../../core/protocol/codec.ts';
import type { TransportKind } from '../../core/protocol/messages.ts';

/** Message-oriented, reliable, ordered link to a GLP/1 hub (docs/PROTOCOL.md §2). */
export interface Transport {
  readonly kind: TransportKind;
  /** Resolves when the link is usable; rejects on failure or timeout. */
  open(timeoutMs: number): Promise<void>;
  send(frame: Frame): void;
  close(): void;
  onFrame: (frame: Frame) => void;
  onClose: (reason: string) => void;
}

export const noop = () => {};
