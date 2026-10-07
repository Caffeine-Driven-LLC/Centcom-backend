/**
 * Error registry (B006): the CT-ERR codes of contracts/errors.json, as B003 generates them, with
 * their HTTP status, default title and retryability; the code a bare HTTP status maps to (CT-ERR
 * rule 7); and the CT-ERR retry table.
 *
 * Owns: lookups over the generated registry and the retry decision. Must not: define a code of
 * its own (codes come only from contracts/errors.json) or hold mutable state.
 */
import { ERRORS, ERROR_TYPE_BASE, type ErrorCode } from '@centcom/contracts';

export { ERROR_TYPE_BASE, type ErrorCode };

/** What the registry says about one code. */
export interface ErrorEntry {
  /** The HTTP status the code is sent with. */
  readonly status: number;
  /** The registry area (`generic`, `auth`, `billing`, ...). */
  readonly area: string;
  /** True if CT-ERR rule 6 asks for `retry_after_s` with this code. */
  readonly retryable: boolean;
  /** The default problem `title`. */
  readonly title: string;
  /** The problem `type`: `https://centcom.dev/errors/<code>`. */
  readonly type: string;
}

/** Every registry code, in registry order. */
export const ERROR_CODES: readonly ErrorCode[] = Object.freeze(Object.keys(ERRORS) as ErrorCode[]);

/** True if `value` is a code in the registry. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERRORS, value);
}

/** The registry entry of `code`. */
export function errorEntry(code: ErrorCode): ErrorEntry {
  return ERRORS[code];
}

/** True for an integer HTTP error status (400-599). */
export function isErrorStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599;
}

/**
 * The code a bare HTTP status is sent with: the registry's own code for that status where there
 * is one. Every entry's status matches the registry (a test checks it).
 */
const STATUS_CODES: ReadonlyMap<number, ErrorCode> = new Map<number, ErrorCode>([
  [400, 'invalid_request'],
  [401, 'unauthorized'],
  [402, 'payment_required'],
  [403, 'forbidden'],
  [404, 'not_found'],
  [409, 'conflict'],
  [410, 'gone'],
  [412, 'precondition_failed'],
  [413, 'payload_too_large'],
  [415, 'unsupported_media_type'],
  [422, 'validation_failed'],
  [426, 'client_too_old'],
  [429, 'rate_limited'],
  [500, 'internal_error'],
  [502, 'bad_gateway'],
  [503, 'service_unavailable'],
  [504, 'timeout'],
]);

/**
 * The registry code for an HTTP status. A status the registry has no code for (405, 414, 501, ...)
 * gets its class's generic code, as CT-ERR rule 7 says: `invalid_request` for 4xx and
 * `internal_error` for 5xx. Anything that is not an error status is treated as a 500.
 */
export function codeForStatus(status: number): ErrorCode {
  const exact = STATUS_CODES.get(status);
  if (exact !== undefined) return exact;
  return isErrorStatus(status) && status < 500 ? 'invalid_request' : 'internal_error';
}

/** Statuses retried for any request, honouring `Retry-After` (CT-ERR retry table, row 2). */
const RETRY_ALWAYS: ReadonlySet<number> = new Set([408, 425, 429]);
/** Statuses retried for idempotent requests only (CT-ERR retry table, row 3). */
const RETRY_IF_IDEMPOTENT: ReadonlySet<number> = new Set([500, 502, 503, 504]);
/** Methods RFC 9110 §9.2.2 defines as idempotent. */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'PUT',
  'DELETE',
]);

/**
 * The CT-ERR retry table, which clients and the server both obey: may a request that failed with
 * `status` be sent again?
 *
 * - 408, 425, 429: yes.
 * - 500, 502, 503, 504: only if the request is idempotent: an idempotent method, or a POST with an
 *   `Idempotency-Key` (CT-PAGE defines the key for POST only, so a PATCH is never idempotent).
 * - Everything else (400, 401, 403, 404, 409, 410, 422, ...): no, fix the request. A 401 means
 *   "refresh the token once, then re-authenticate", which is not a retry.
 * - A POST without an `Idempotency-Key` is never retried, whatever the status.
 *
 * `method` is compared case-insensitively.
 */
export function isRetryable(status: number, method: string, hasIdempotencyKey: boolean): boolean {
  const verb = method.toUpperCase();
  if (verb === 'POST' && !hasIdempotencyKey) return false;
  if (RETRY_ALWAYS.has(status)) return true;
  if (RETRY_IF_IDEMPOTENT.has(status)) return verb === 'POST' || IDEMPOTENT_METHODS.has(verb);
  return false;
}
