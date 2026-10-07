/**
 * Problem bodies (B006): `toProblem(err, ctx)` turns anything thrown into the RFC 9457 body CT-ERR
 * defines: the API's `application/problem+json` responses and the relay's `sys.error` frame
 * bodies share it. Also the error layer's message table.
 *
 * Owns: which fields a problem carries and when, and the user-facing details of the error layer.
 * Must not: let an unknown error's message, stack or properties into a problem, emit a code
 * outside the registry, or throw for an AppError built by its constructor.
 */
import type { Problem as ContractProblem } from '@centcom/contracts';
import { redactText } from '../log/redact.js';
import { AppError, type FieldError } from './app-error.js';
import {
  codeForStatus,
  errorEntry,
  isErrorCode,
  isErrorStatus,
  type ErrorCode,
} from './registry.js';

/** An RFC 9457 problem body (CT-ERR); the type is generated from contracts/schemas/problem.schema.json. */
export type Problem = ContractProblem;

/** Where a problem happened. */
export interface ProblemContext {
  /** The request's CT-IDS `req_` id, also sent as `X-Request-Id` (CT-ERR rule 4). */
  requestId: string;
  /** The route path (template) that failed, such as `/v1/sessions/:id`; omitted when unknown. */
  instance?: string;
}

/** The media type of every HTTP problem response (RFC 9457). */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
/** `retry_after_s` when CT-ERR rule 6 asks for one and the error did not give it. */
export const DEFAULT_RETRY_AFTER_S = 1;
/** The largest `retry_after_s` sent (366 days); larger values are cut to it. */
export const MAX_RETRY_AFTER_S = 366 * 24 * 60 * 60;
/** At most this many `errors[]` entries are sent; the rest are dropped. */
export const MAX_FIELD_ERRORS = 100;

/**
 * The error layer's user-facing details (GUIDELINES §3.4: user-facing text lives in one table).
 * None of them repeats anything from the request.
 */
export const ERROR_DETAILS = Object.freeze({
  internal:
    'Something went wrong on our side. If it keeps happening, report it with the request id.',
  notFound: 'Nothing exists at this URL.',
  methodNotAllowed:
    'This URL does not accept this method. The Allow header lists the methods it accepts.',
  malformedJson: 'The request body is not valid JSON.',
  emptyJsonBody: 'The request body is empty, but its Content-Type says JSON.',
  contentLengthMismatch: 'The request body does not match its Content-Length.',
  payloadTooLarge: 'The request body is larger than this endpoint accepts.',
  unsupportedMediaType: "This endpoint does not accept the request's Content-Type.",
  badUrl: 'The URL is not valid.',
  uriTooLong: 'A segment of the URL is too long.',
  schemaMismatch: 'The request does not match the schema.',
  badRequest: 'The request could not be processed.',
} as const);

/** Text that is safe to send: secrets that slipped in are replaced and the length is capped. */
const safeText = (value: string): string => redactText(value);

/** A whole number of seconds in [0, MAX_RETRY_AFTER_S]; the default for anything unusable. */
function retryAfterSeconds(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_RETRY_AFTER_S;
  }
  return Math.min(Math.ceil(value), MAX_RETRY_AFTER_S);
}

/** At most MAX_FIELD_ERRORS well-formed entries, copied with their text made safe. */
function fieldErrors(errors: readonly FieldError[] | undefined): FieldError[] {
  if (!Array.isArray(errors)) return [];
  const out: FieldError[] = [];
  for (const item of errors as readonly unknown[]) {
    if (out.length >= MAX_FIELD_ERRORS) break;
    if (typeof item !== 'object' || item === null) continue;
    const { pointer, code, detail } = item as Record<string, unknown>;
    if (typeof pointer !== 'string' || typeof code !== 'string') continue;
    const entry: FieldError = { pointer: safeText(pointer), code: safeText(code) };
    if (typeof detail === 'string') entry.detail = safeText(detail);
    out.push(entry);
  }
  return out;
}

/** True if CT-ERR rule 6 asks for `retry_after_s`: 429, 503 and every retryable code. */
const wantsRetryAfter = (status: number, code: ErrorCode): boolean =>
  status === 429 || status === 503 || errorEntry(code).retryable;

/** The problem for anything that is not an AppError: a generic 500 that says nothing about it. */
function internalProblem(ctx: ProblemContext): Problem {
  const entry = errorEntry('internal_error');
  return {
    type: entry.type,
    title: entry.title,
    status: entry.status,
    code: 'internal_error',
    detail: ERROR_DETAILS.internal,
    ...(ctx.instance === undefined ? {} : { instance: ctx.instance }),
    request_id: ctx.requestId,
    retry_after_s: DEFAULT_RETRY_AFTER_S,
  };
}

/**
 * The CT-ERR problem body for `err`.
 *
 * - An AppError gives its code, status, detail and field errors. A code missing from the registry
 *   becomes the generic code of its status class (CT-ERR rule 7); callers should log that case.
 * - Anything else (a TypeError, a string, a library error) becomes a 500 `internal_error` with a
 *   generic detail: its message, stack and properties never reach the body. Log it instead.
 * - `retry_after_s` is present exactly for 429, 503 and retryable codes (CT-ERR rule 6), as a
 *   whole number of seconds: the error's `retryAfterS` or DEFAULT_RETRY_AFTER_S.
 * - Details are passed through the log redaction patterns (API keys, JWTs, Bearer credentials)
 *   and capped in length, in case a caller let a secret slip into one.
 *
 * Pure: the same input gives the same output, and nothing is logged or mutated.
 */
export function toProblem(err: unknown, ctx: ProblemContext): Problem {
  if (!(err instanceof AppError)) return internalProblem(ctx);
  const code = isErrorCode(err.code) ? err.code : codeForStatus(err.status);
  const entry = errorEntry(code);
  const status = isErrorStatus(err.status) ? err.status : entry.status;
  const detail = typeof err.detail === 'string' ? safeText(err.detail) : undefined;
  const errors = fieldErrors(err.errors);
  return {
    type: entry.type,
    title: entry.title,
    status,
    code,
    ...(detail === undefined ? {} : { detail }),
    ...(ctx.instance === undefined ? {} : { instance: ctx.instance }),
    request_id: ctx.requestId,
    ...(wantsRetryAfter(status, code) ? { retry_after_s: retryAfterSeconds(err.retryAfterS) } : {}),
    ...(errors.length === 0 ? {} : { errors }),
  };
}

/**
 * The static, minimal 500 body to send when building or serialising the real problem failed. It
 * holds only constants and the request id, so producing it cannot fail.
 */
export function fallbackProblemBody(requestId: string): string {
  const entry = errorEntry('internal_error');
  return JSON.stringify({
    type: entry.type,
    title: entry.title,
    status: entry.status,
    code: 'internal_error',
    request_id: String(requestId),
    retry_after_s: DEFAULT_RETRY_AFTER_S,
  });
}
