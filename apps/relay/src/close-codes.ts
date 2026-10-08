/**
 * WebSocket close codes (B037, CT-WS-ENVELOPE "Close codes"): every code the relay closes a
 * connection with, by name, so no code is a magic number. 1011 is RFC 6455's "internal error",
 * for a connection whose handler threw (the client reconnects with backoff, as for any code but
 * 4401, 4403, 4404, 4409 and 4426).
 *
 * Owns: the table. Must not: gain a code the contract does not list (1011 aside).
 */
export const CloseCode = Object.freeze({
  Normal: 1000,
  GoingAway: 1001,
  InternalError: 1011,
  ProtocolViolation: 4400,
  Unauthenticated: 4401,
  Forbidden: 4403,
  NotFound: 4404,
  HandshakeTimeout: 4408,
  Superseded: 4409,
  ClientTooOld: 4426,
  RateLimited: 4429,
  Overloaded: 4503,
} as const);

/** A close code from the table. */
export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode];

const CODES: ReadonlySet<number> = new Set(Object.values(CloseCode));

/** True for a code in the table. */
export const isCloseCode = (code: number): code is CloseCodeValue => CODES.has(code);
