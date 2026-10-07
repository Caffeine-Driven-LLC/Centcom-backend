/**
 * List query parameters (B025, CT-PAGE): `limit` (1 to 200, default 50), an opaque `cursor`, and
 * a `sort` from the endpoint's allow-list. Offsets, page numbers and `skip` are refused, never
 * honoured. Problems are a 422 `validation_failed` with `errors[]` pointing at the parameter
 * (`/limit`, `/sort`, ...); a cursor that is not even shaped like one is a 400 `cursor_invalid`.
 *
 * Owns: reading the paging parameters. Must not: accept a limit over 200, whatever the endpoint
 * asks for, or let a sort outside the allow-list through.
 */
import { AppError, validationFailed, type FieldError } from '../errors/app-error.js';

/** The page size when the request gives none. */
export const DEFAULT_LIMIT = 50;
/** The largest page, whatever an endpoint's spec says (CT-PAGE). */
export const MAX_LIMIT = 200;
/** The longest cursor accepted. */
export const MAX_CURSOR_LENGTH = 1024;
/** Paging styles CT-PAGE forbids; asking for them is an error, not a silent no-op. */
export const FORBIDDEN_PARAMS: readonly string[] = Object.freeze(['offset', 'page', 'skip']);

/** The user-facing details of paging problems (GUIDELINES §3.4: one message table). */
export const PAGINATION_DETAILS = Object.freeze({
  invalidQuery: 'Some list parameters are not valid.',
  cursorInvalid: 'The cursor is invalid or expired. Start again from the first page.',
} as const);

/** What an endpoint allows. */
export interface PageQuerySpec {
  /** The sort names the endpoint accepts. */
  readonly sorts: readonly string[];
  /** The sort used when the request names none; one of `sorts`. */
  readonly defaultSort: string;
  /** A smaller page limit than MAX_LIMIT; anything larger is clamped to MAX_LIMIT. */
  readonly maxLimit?: number;
}

/** The paging part of a list request. */
export interface PageQuery {
  limit: number;
  cursor?: string;
  sort: string;
}

const DIGITS = /^\d{1,6}$/;
const CURSOR_CHARS = /^[A-Za-z0-9_.-]+$/;

/** A 400 `cursor_invalid` pointing at `/cursor`; `code` says why (invalid, expired, mismatch). */
export function cursorInvalid(code: 'invalid' | 'expired' | 'mismatch' = 'invalid'): AppError {
  return new AppError('cursor_invalid', {
    detail: PAGINATION_DETAILS.cursorInvalid,
    errors: [{ pointer: '/cursor', code }],
  });
}

/**
 * The paging parameters of `q` (a parsed query string: values are strings, repeated ones arrays;
 * anything else counts as no parameters). Throws a 422 listing every bad parameter, or a 400
 * `cursor_invalid` for a cursor that cannot be one. Throws a TypeError for a spec whose default
 * sort is not one of its sorts.
 */
export function parsePageQuery(q: unknown, spec: PageQuerySpec): PageQuery {
  if (!spec.sorts.includes(spec.defaultSort)) {
    throw new TypeError('parsePageQuery: defaultSort must be one of sorts');
  }
  const maxLimit = Math.min(spec.maxLimit ?? MAX_LIMIT, MAX_LIMIT);
  const query = typeof q === 'object' && q !== null ? (q as Record<string, unknown>) : {};
  const issues: FieldError[] = [];

  let limit = Math.min(DEFAULT_LIMIT, maxLimit);
  const rawLimit = query['limit'];
  if (rawLimit !== undefined) {
    const value = typeof rawLimit === 'string' && DIGITS.test(rawLimit) ? Number(rawLimit) : NaN;
    if (Number.isNaN(value)) {
      issues.push({ pointer: '/limit', code: 'invalid_type', detail: 'must be a whole number' });
    } else if (value < 1 || value > maxLimit) {
      issues.push({ pointer: '/limit', code: 'out_of_range', detail: `must be 1 to ${maxLimit}` });
    } else {
      limit = value;
    }
  }

  let sort = spec.defaultSort;
  const rawSort = query['sort'];
  if (rawSort !== undefined) {
    if (typeof rawSort === 'string' && spec.sorts.includes(rawSort)) sort = rawSort;
    else {
      issues.push({
        pointer: '/sort',
        code: 'invalid_value',
        detail: `must be one of: ${spec.sorts.join(', ')}`,
      });
    }
  }

  for (const name of FORBIDDEN_PARAMS) {
    if (query[name] !== undefined) {
      issues.push({
        pointer: `/${name}`,
        code: 'not_supported',
        detail: 'lists page with cursors only; use next_cursor',
      });
    }
  }
  if (issues.length > 0) throw validationFailed(issues, PAGINATION_DETAILS.invalidQuery);

  const cursor = query['cursor'];
  if (cursor === undefined) return { limit, sort };
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    !CURSOR_CHARS.test(cursor)
  ) {
    throw cursorInvalid();
  }
  return { limit, cursor, sort };
}
