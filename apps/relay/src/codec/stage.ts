/**
 * The decode stage (B039, pipeline order 10): every inbound message passes here first.
 *
 * - A binary message: `sys.error` `invalid_frame`, close 4400 (binary frames are reserved).
 * - Over 256 KiB: `sys.error` `frame_too_large`; the frame is dropped and counts as invalid.
 * - Before the handshake (B038) has authenticated the connection, nothing else is checked: the
 *   handshake owns `sys.hello` (its own ticket and schema answers, 4401 and 4400).
 * - After it, `decodeFrame` with the connection's session: a frame that fails is answered with
 *   `sys.error` (`invalid_frame` or `frame_too_large`, the JSON pointer in `errors[]`) and
 *   dropped; one that passes is set on `fc.frame` for the later stages.
 * - Invalid frames are budgeted per connection: the 11th within 60 s closes it with 4400.
 * - An exception inside decoding drops the frame, counts `relay_codec_errors_total`, and keeps
 *   the connection.
 *
 * Owns: the stage and the budget. Must not: route a frame that did not decode, or log `p` or `ct`.
 */
import { newId } from '@centcom/contracts';
import { AppError, noopMetrics, toProblem, type Logger, type Metrics } from '@centcom/core';
import { CloseCode } from '../close-codes.js';
import type { ConnectionEntry } from '../connection-registry.js';
import type { InboundStage, RelayConnection } from '../pipeline.js';
import { decodeFrame, FRAME_LIMITS, type DecodeFailure } from './codec.js';

/** The invalid-frame budget's window. */
export const INVALID_WINDOW_MS = 60_000;

/** Dependencies of the stage. */
export interface CodecStageDeps {
  logger?: Logger;
  metrics?: Metrics;
  /** Milliseconds since the epoch; default Date.now. */
  clock?: () => number;
  /** The decoder; replaceable in tests. */
  decode?: typeof decodeFrame;
}

/** The details of the stage's refusals (GUIDELINES §3.4). */
export const CODEC_DETAILS = Object.freeze({
  binary: 'Binary frames are not used; send JSON text.',
  invalid_frame: 'The frame does not match the envelope schema.',
  frame_too_large: 'The frame is larger than the relay accepts.',
  budget: 'Too many invalid frames.',
} as const);

/** Times of a connection's recent invalid frames, oldest first. */
class InvalidBudget {
  readonly #times = new WeakMap<ConnectionEntry, number[]>();

  /** Records one at `now`; true when this one is over the budget. */
  spend(entry: ConnectionEntry, now: number): boolean {
    const recent = (this.#times.get(entry) ?? []).filter((t) => now - t < INVALID_WINDOW_MS);
    recent.push(now);
    this.#times.set(entry, recent);
    return recent.length > FRAME_LIMITS.invalidPerMinute;
  }
}

/** The decode stage. */
export function createCodecStage(deps: CodecStageDeps = {}): InboundStage {
  const clock = deps.clock ?? Date.now;
  const metrics = deps.metrics ?? noopMetrics;
  const decode = deps.decode ?? decodeFrame;
  const budget = new InvalidBudget();

  const sysError = (connection: RelayConnection, error: AppError): void => {
    connection.send({ v: 1, t: 'sys.error', p: toProblem(error, { requestId: newId('req') }) });
  };

  function refuse(connection: RelayConnection, failure: DecodeFailure): void {
    metrics.counter('relay_frames_invalid_total', { code: failure.code }).inc();
    const pointer = failure.pointer ?? '';
    sysError(
      connection,
      new AppError(failure.code, {
        detail: CODEC_DETAILS[failure.code],
        errors: [{ pointer, code: 'invalid', detail: 'is not valid here' }],
      }),
    );
    if (budget.spend(connection.entry, clock())) {
      deps.logger?.info(
        { close: CloseCode.ProtocolViolation, reason: 'invalid_frames' },
        'relay.codec_closed',
      );
      connection.close(CloseCode.ProtocolViolation, 'invalid frames');
    }
  }

  return async (fc, next) => {
    const { connection } = fc;
    if (fc.raw === null) {
      metrics.counter('relay_frames_invalid_total', { code: 'binary' }).inc();
      sysError(connection, new AppError('invalid_frame', { detail: CODEC_DETAILS.binary }));
      connection.close(CloseCode.ProtocolViolation, 'binary frame');
      return;
    }
    if (Buffer.byteLength(fc.raw, 'utf8') > FRAME_LIMITS.maxFrameBytes) {
      refuse(connection, { ok: false, code: 'frame_too_large', pointer: '' });
      return;
    }
    if (connection.entry.state !== 'authenticated') {
      await next();
      return;
    }
    let result: ReturnType<typeof decodeFrame>;
    try {
      result = decode(fc.raw, false, connection.entry.sessionId);
    } catch (err) {
      metrics.counter('relay_codec_errors_total').inc();
      deps.logger?.error(
        { error: err instanceof Error ? err.name : typeof err },
        'relay.codec_error',
      );
      return;
    }
    if (!result.ok) {
      refuse(connection, result);
      return;
    }
    fc.frame = result.frame;
    await next();
  };
}
