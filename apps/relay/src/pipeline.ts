/**
 * The inbound frame pipeline (B037): every message a connection receives runs through the stages
 * relay modules add, in `order`, each calling `next()` to pass the frame on (or not, to stop it).
 * The orders are reserved by lane, so stages from separate folders compose without knowing each
 * other: decode 10 (B039), handshake 15 (B038), authorise 20, privacy 30 (B050), sequence 40
 * (B041), fan-out 50 (B044). With no stage, a frame goes nowhere.
 *
 * Owns: ordering and running stages, and the connection as stages see it. Must not: parse or
 * route frames itself.
 */
import type { CloseCodeValue } from './close-codes.js';
import type { ConnectionEntry } from './connection-registry.js';

/** Stage orders by purpose. */
export const STAGE_ORDER = Object.freeze({
  decode: 10,
  handshake: 15,
  authorise: 20,
  privacy: 30,
  sequence: 40,
  fanOut: 50,
} as const);

/** A connection as modules and stages see it. */
export interface RelayConnection {
  readonly entry: ConnectionEntry;
  /** Sends `frame` as one JSON text message; false when the socket is not open. */
  send(frame: object): boolean;
  /** Starts the closing handshake with `code`. */
  close(code: CloseCodeValue, reason?: string): void;
  /** Cuts the connection at once. */
  terminate(): void;
}

/** One received message on its way through the stages. */
export interface FrameContext {
  readonly connection: RelayConnection;
  /** The message as received: text, or null for a binary message (reserved, CT-WS-ENVELOPE). */
  readonly raw: string | null;
  /** The decoded frame, once the decode stage set it. */
  frame?: unknown;
  /** Per-frame state stages hand to later ones. */
  readonly state: Record<string, unknown>;
}

/** A stage: does its part, then `await next()` to run the rest. */
export type InboundStage = (fc: FrameContext, next: () => Promise<void>) => Promise<void>;

/** Stages in order. */
export class FramePipeline {
  #stages: { order: number; seq: number; stage: InboundStage }[] = [];
  #seq = 0;

  /** Adds `stage` at `order` (an integer, 0-1000); stages of one order run in the order added. */
  use(order: number, stage: InboundStage): void {
    if (!Number.isInteger(order) || order < 0 || order > 1000) {
      throw new TypeError('FramePipeline.use: order must be an integer from 0 to 1000');
    }
    this.#stages = [...this.#stages, { order, seq: this.#seq++, stage }].sort(
      (a, b) => a.order - b.order || a.seq - b.seq,
    );
  }

  /** The orders of the stages, as they run. */
  orders(): number[] {
    return this.#stages.map((s) => s.order);
  }

  /** Runs the stages on `fc`; rejects with what a stage threw. */
  run(fc: FrameContext): Promise<void> {
    const stages = this.#stages;
    const at = async (i: number): Promise<void> => {
      const current = stages[i];
      if (current === undefined) return;
      let called = false;
      await current.stage(fc, () => {
        if (called) return Promise.reject(new Error('FramePipeline: next() called twice'));
        called = true;
        return at(i + 1);
      });
    };
    return at(0);
  }
}
