/**
 * Closing a connection (B040, CT-WS-ENVELOPE "Close codes"): the one path every close takes, so
 * each close code is preceded by the frame the contract asks for and nothing is closed twice.
 *
 * - `CLOSE_FRAMES`: what must precede each code. 4400, 4401, 4403, 4404, 4408, 4426, 4429, 4503 and
 *   1011 need a `sys.error` (a CT-ERR problem); 4409 (superseded) and 1001 (going away) need a
 *   `sys.bye` with its reason; 1000 may carry a `sys.bye`.
 * - `ERROR_CLOSE`: which code a connection-ending error closes with (`closeCodeFor`).
 * - `closeConnection(conn, spec)`: sends the frame, starts the closing handshake with the code
 *   and the reason, and cuts the socket if it has not closed 1 s later (a peer that never answers
 *   the close, or a write that failed). A second call does nothing. The connection leaves the
 *   registry when its socket closes (B037's close handler), at most 1 s after.
 *
 * Owns: the frame-then-close order and the tables. Must not: log a frame's payload.
 */
import { newId } from '@centcom/contracts';
import { AppError, toProblem, type ErrorCode, type FieldError } from '@centcom/core';
import { CloseCode, type CloseCodeValue } from '../close-codes.js';
import type { RelayConnection } from '../pipeline.js';

/** A close that does not finish its handshake is cut after this long. */
export const CLOSE_TERMINATE_MS = 1_000;

/** What must precede a close code: a `sys.error`, a `sys.bye`, or nothing (a bye is optional). */
export type CloseFrame = 'error' | 'bye' | 'none';

/** The frame each close code requires. */
export const CLOSE_FRAMES: Readonly<Record<CloseCodeValue, CloseFrame>> = Object.freeze({
  [CloseCode.Normal]: 'none',
  [CloseCode.GoingAway]: 'bye',
  [CloseCode.InternalError]: 'error',
  [CloseCode.ProtocolViolation]: 'error',
  [CloseCode.Unauthenticated]: 'error',
  [CloseCode.Forbidden]: 'error',
  [CloseCode.NotFound]: 'error',
  [CloseCode.HandshakeTimeout]: 'error',
  [CloseCode.Superseded]: 'bye',
  [CloseCode.ClientTooOld]: 'error',
  [CloseCode.RateLimited]: 'error',
  [CloseCode.Overloaded]: 'error',
});

/** The close code each connection-ending error leads to (CT-ERR code to CT-WS-ENVELOPE code). */
export const ERROR_CLOSE: Readonly<Partial<Record<ErrorCode, CloseCodeValue>>> = Object.freeze({
  invalid_frame: CloseCode.ProtocolViolation,
  frame_too_large: CloseCode.ProtocolViolation,
  protocol_violation: CloseCode.ProtocolViolation,
  unauthorized: CloseCode.Unauthenticated,
  token_expired: CloseCode.Unauthenticated,
  token_invalid: CloseCode.Unauthenticated,
  token_revoked: CloseCode.Unauthenticated,
  ticket_invalid: CloseCode.Unauthenticated,
  ticket_replayed: CloseCode.Unauthenticated,
  device_revoked: CloseCode.Unauthenticated,
  forbidden: CloseCode.Forbidden,
  not_a_member: CloseCode.Forbidden,
  entitlement_required: CloseCode.Forbidden,
  access_denied: CloseCode.Forbidden,
  session_full: CloseCode.Forbidden,
  session_not_found: CloseCode.NotFound,
  session_ended: CloseCode.NotFound,
  client_too_old: CloseCode.ClientTooOld,
  rate_limited: CloseCode.RateLimited,
  frame_rate_exceeded: CloseCode.RateLimited,
  slow_consumer: CloseCode.RateLimited,
  service_unavailable: CloseCode.Overloaded,
  internal_error: CloseCode.InternalError,
});

/** The close code for `code`, or undefined when that error does not end a connection. */
export const closeCodeFor = (code: ErrorCode): CloseCodeValue | undefined => ERROR_CLOSE[code];

/** How to close. */
export interface CloseSpec {
  code: CloseCodeValue;
  /** The `sys.error` to send first (CT-ERR code); required where CLOSE_FRAMES says `error`. */
  errorCode?: ErrorCode;
  /** The `sys.bye` reason to send first; required where CLOSE_FRAMES says `bye`. */
  bye?: string;
  /** `retry_after_s` of the `sys.error` (4503). */
  retryAfterS?: number;
  /** The problem's `detail`; the error's title when absent. */
  detail?: string;
  /** The problem's field errors (for example the JSON pointer of an invalid frame). */
  errors?: readonly FieldError[];
  /** Extra problem members (for example `upgrade` of a 4426). */
  extra?: Readonly<Record<string, unknown>>;
}

/** A spec that does not follow CLOSE_FRAMES; a bug in the caller. */
export class CloseSpecError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'CloseSpecError';
  }
}

/** Runs `fn` after `ms`; returns a canceller. */
export type CloseTimer = (fn: () => void, ms: number) => () => void;

const defaultTimer: CloseTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return () => clearTimeout(handle);
};

/** Throws CloseSpecError when `spec` lacks the frame its code needs, or carries the wrong one. */
export function checkCloseSpec(spec: CloseSpec): void {
  const frame = CLOSE_FRAMES[spec.code];
  if (frame === undefined) throw new CloseSpecError(`${spec.code} is not a close code`);
  if (spec.errorCode !== undefined && spec.bye !== undefined) {
    throw new CloseSpecError('a close sends a sys.error or a sys.bye, not both');
  }
  if (frame === 'error' && spec.errorCode === undefined) {
    throw new CloseSpecError(`close ${spec.code} must be preceded by a sys.error`);
  }
  if (frame === 'bye' && (spec.bye === undefined || spec.bye === '')) {
    throw new CloseSpecError(`close ${spec.code} must be preceded by a sys.bye with a reason`);
  }
  if (frame !== 'error' && spec.errorCode !== undefined) {
    throw new CloseSpecError(`close ${spec.code} is not preceded by a sys.error`);
  }
}

/** The frame sent before a close of `spec`, or undefined for a bare close. */
export function closeFrame(spec: CloseSpec): object | undefined {
  if (spec.errorCode !== undefined) {
    const error = new AppError(spec.errorCode, {
      ...(spec.detail === undefined ? {} : { detail: spec.detail }),
      ...(spec.retryAfterS === undefined ? {} : { retryAfterS: spec.retryAfterS }),
      ...(spec.errors === undefined ? {} : { errors: spec.errors }),
    });
    const problem = { ...toProblem(error, { requestId: newId('req') }), ...spec.extra };
    return { v: 1, t: 'sys.error', p: problem };
  }
  if (spec.bye !== undefined) return { v: 1, t: 'sys.bye', p: { reason: spec.bye } };
  return undefined;
}

/**
 * Closes `conn` as `spec` says (see the module comment); false when it was already closing.
 * Throws CloseSpecError for a spec that breaks CLOSE_FRAMES.
 */
export function closeConnection(
  conn: RelayConnection,
  spec: CloseSpec,
  options: { setTimer?: CloseTimer } = {},
): boolean {
  checkCloseSpec(spec);
  if (conn.entry.state === 'closing') return false;
  const frame = closeFrame(spec);
  if (frame !== undefined) conn.send(frame);
  conn.close(spec.code, spec.bye ?? spec.errorCode ?? '');
  const cancel = (options.setTimer ?? defaultTimer)(() => conn.terminate(), CLOSE_TERMINATE_MS);
  conn.onClose(cancel);
  return true;
}
