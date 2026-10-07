/**
 * Typed errors (B006): `AppError` carries a CT-ERR registry code and what its problem body needs,
 * and the helpers build the common ones. Code throws these, never strings or bare Errors; the API
 * error handler and the relay turn them into problem bodies with `toProblem`.
 *
 * Owns: the AppError shape and its helpers. Must not: take a code outside the registry (the type
 * forbids it; `toProblem` maps a stray one at run time), hold user-facing text other than the
 * caller's `detail`, or throw while it is being built.
 */
import type { Problem } from '@centcom/contracts';
import { errorEntry, isErrorCode, isErrorStatus, type ErrorCode } from './registry.js';

/** One entry of a problem's `errors[]`: a JSON Pointer into the request, a code and English detail. */
export type FieldError = NonNullable<Problem['errors']>[number];

/** Options for `new AppError(code, options)`. */
export interface AppErrorOptions {
  /**
   * Human-readable English that is safe to show (CT-ERR rule 2): never secrets, other users' data,
   * internal paths, SQL or values copied from the request. Take it from your message table.
   */
  detail?: string;
  /** Per-field validation problems (CT-ERR rule 5). */
  errors?: readonly FieldError[];
  /**
   * Seconds until a retry makes sense. Sent as `retry_after_s` and `Retry-After` only where CT-ERR
   * rule 6 asks for them (429, 503 and retryable codes); ignored otherwise.
   */
  retryAfterS?: number;
  /**
   * The HTTP status, for a status the registry has no code of its own for (405, 414, ...), sent
   * with that class's generic code (see `codeForStatus`). Honoured only within the class of the
   * code's own status, so a 4xx code never goes out as a 5xx or the other way round.
   */
  status?: number;
  /** The underlying error. Logged (redacted), never sent. */
  cause?: unknown;
}

/** Helper options: everything but the detail and the status, which the helper decides. */
export type AppErrorHelperOptions = Pick<AppErrorOptions, 'cause'>;

/** The status an AppError is sent with: the code's own, or an allowed override (see AppErrorOptions.status). */
function statusFor(code: string, requested: number | undefined): number {
  if (!isErrorCode(code)) return isErrorStatus(requested) ? requested : 500;
  const own = errorEntry(code).status;
  const sameClass =
    isErrorStatus(requested) && Math.floor(requested / 100) === Math.floor(own / 100);
  return sameClass ? requested : own;
}

/** A frozen copy of the well-formed entries: `pointer` and `code` strings, an optional string `detail`. */
function copyFieldErrors(errors: unknown): readonly FieldError[] | undefined {
  if (!Array.isArray(errors)) return undefined;
  const out: FieldError[] = [];
  for (const item of errors as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { pointer, code, detail } = item as Record<string, unknown>;
    if (typeof pointer !== 'string' || typeof code !== 'string') continue;
    out.push(
      Object.freeze(typeof detail === 'string' ? { pointer, code, detail } : { pointer, code }),
    );
  }
  return Object.freeze(out);
}

/** An error with a CT-ERR registry code. Throw these instead of strings or bare Errors. */
export class AppError extends Error {
  /** The registry code; clients switch on it. */
  readonly code: ErrorCode;
  /** The HTTP status (for a WebSocket error, the equivalent status). */
  readonly status: number;
  /** Safe, human-readable English (see AppErrorOptions.detail). */
  declare readonly detail?: string;
  /** Per-field validation problems. */
  declare readonly errors?: readonly FieldError[];
  /** Seconds until a retry makes sense (see AppErrorOptions.retryAfterS). */
  declare readonly retryAfterS?: number;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const detail = typeof options.detail === 'string' ? options.detail : undefined;
    super(
      detail === undefined ? String(code) : `${code}: ${detail}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = code;
    this.status = statusFor(code, options.status);
    if (detail !== undefined) this.detail = detail;
    const errors = copyFieldErrors(options.errors);
    if (errors !== undefined) this.errors = errors;
    if (typeof options.retryAfterS === 'number') this.retryAfterS = options.retryAfterS;
  }
}

// On the prototype, not as an instance field, so a logged AppError does not repeat its name as a property.
Object.defineProperty(AppError.prototype, 'name', {
  value: 'AppError',
  writable: true,
  configurable: true,
});

/** True if `value` is an AppError. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** 400 `invalid_request`: the request is malformed. */
export function badRequest(detail?: string, options: AppErrorHelperOptions = {}): AppError {
  return new AppError('invalid_request', { ...options, detail });
}

/**
 * 401 `unauthorized`: authentication is missing or failed. Give every authentication failure the
 * same detail (or none) so the body does not tell whether the user exists.
 */
export function unauthorized(detail?: string, options: AppErrorHelperOptions = {}): AppError {
  return new AppError('unauthorized', { ...options, detail });
}

/** 403 `forbidden`: authenticated, but not allowed. */
export function forbidden(detail?: string, options: AppErrorHelperOptions = {}): AppError {
  return new AppError('forbidden', { ...options, detail });
}

/** 404 `not_found`. */
export function notFound(detail?: string, options: AppErrorHelperOptions = {}): AppError {
  return new AppError('not_found', { ...options, detail });
}

/** 409 `conflict`: the request conflicts with the current state. */
export function conflict(detail?: string, options: AppErrorHelperOptions = {}): AppError {
  return new AppError('conflict', { ...options, detail });
}

/** 422 `validation_failed` without field errors: well-formed, but not acceptable. */
export function unprocessable(detail?: string, options: AppErrorHelperOptions = {}): AppError {
  return new AppError('validation_failed', { ...options, detail });
}

/** 429 `rate_limited`, with the seconds until the client may try again. */
export function tooManyRequests(
  retryAfterS: number,
  detail?: string,
  options: AppErrorHelperOptions = {},
): AppError {
  return new AppError('rate_limited', { ...options, detail, retryAfterS });
}

/** 503 `service_unavailable`, optionally with the seconds until a retry makes sense. */
export function unavailable(
  retryAfterS?: number,
  detail?: string,
  options: AppErrorHelperOptions = {},
): AppError {
  return new AppError('service_unavailable', { ...options, detail, retryAfterS });
}

/**
 * 422 `validation_failed` with per-field errors, such as the issues a `@centcom/contracts`
 * validator returned (`{pointer, code, detail}`, pointers relative to the request body).
 */
export function validationFailed(
  errors: readonly FieldError[],
  detail?: string,
  options: AppErrorHelperOptions = {},
): AppError {
  return new AppError('validation_failed', { ...options, detail, errors });
}
