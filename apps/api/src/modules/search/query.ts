/**
 * Search input (B089): normalising `q`, spotting full ids, escaping LIKE patterns, and the
 * allow-list of what may be searched.
 *
 * Owns: input rules. Must not: touch the database.
 */
import { validationFailed } from '@centcom/core';

/** The entity types search covers. */
export const SEARCH_TYPES = Object.freeze(['session', 'workspace', 'user', 'member'] as const);
export type SearchType = (typeof SEARCH_TYPES)[number];

/**
 * The only columns search reads to match (guardrail: adding one needs review). Cleartext metadata
 * only: never anything from a session's content.
 */
export const SEARCHABLE_COLUMNS: Readonly<Record<SearchType, readonly string[]>> = Object.freeze({
  session: ['sessions.id', 'sessions.name'],
  workspace: ['workspaces.id', 'workspaces.name', 'workspaces.slug'],
  // `users.email` in staff scope only.
  user: ['users.id', 'users.display_name', 'users.email'],
  member: ['memberships.id', 'users.display_name'],
});

/** The shortest query, in characters. */
export const MIN_QUERY_LENGTH = 2;
/**
 * The longest query, in characters: the longest searchable value, an email (254, CT-IDS and
 * `users.email`'s check in 20260101000000_core_schema.sql).
 */
export const MAX_QUERY_LENGTH = 254;
/** Results per page: default and most. */
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;

/** CT-IDS ids search finds by exact lookup. */
const FULL_ID = /^(ses|wsp|usr|mem)_[0-9a-hjkmnp-tv-z]{26}$/;

/** A normalised query. */
export interface NormalisedQuery {
  /** NFC, trimmed, lower-cased. */
  text: string;
  /** The id (as stored: prefix lower, body upper) when `q` is a full id. */
  id: { type: 'ses' | 'wsp' | 'usr' | 'mem'; value: string } | null;
  /** `%text%` with LIKE's metacharacters escaped (escape character `\`). */
  contains: string;
  /** `text%`, escaped. */
  prefix: string;
}

/** `\`, `%` and `_` escaped for a LIKE pattern with `escape '\'`. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Normalises `q`; 422 (pointer `/q`) when it is missing, shorter than 2, longer than 254 or holds a
 * control character.
 */
export function normaliseQuery(q: unknown): NormalisedQuery {
  if (typeof q !== 'string') {
    throw validationFailed([{ pointer: '/q', code: 'required', detail: 'q is required' }]);
  }
  const text = q.normalize('NFC').trim().toLowerCase();
  // Control characters are in no searchable value (and Postgres text cannot hold NUL).
  const control = [...text].some((c) => {
    const n = c.codePointAt(0) ?? 0;
    return n < 0x20 || n === 0x7f;
  });
  if (control) {
    throw validationFailed([
      { pointer: '/q', code: 'invalid', detail: 'must not contain control characters' },
    ]);
  }
  const length = [...text].length;
  if (length < MIN_QUERY_LENGTH) {
    throw validationFailed([
      { pointer: '/q', code: 'too_short', detail: `at least ${MIN_QUERY_LENGTH} characters` },
    ]);
  }
  if (length > MAX_QUERY_LENGTH) {
    throw validationFailed([
      { pointer: '/q', code: 'too_long', detail: `at most ${MAX_QUERY_LENGTH} characters` },
    ]);
  }
  const full = FULL_ID.exec(text);
  const id =
    full === null
      ? null
      : {
          type: full[1] as 'ses' | 'wsp' | 'usr' | 'mem',
          value: `${full[1]}_${text.slice(4).toUpperCase()}`,
        };
  const escaped = escapeLike(text);
  return { text, id, contains: `%${escaped}%`, prefix: `${escaped}%` };
}

/** `types` from a query string (`session,user` or repeated); all when absent. */
export function parseTypes(raw: unknown): SearchType[] {
  if (raw === undefined) return [...SEARCH_TYPES];
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((v) =>
    typeof v === 'string' ? v.split(',') : [v],
  );
  const types: SearchType[] = [];
  for (const part of parts) {
    if (typeof part !== 'string' || !(SEARCH_TYPES as readonly string[]).includes(part)) {
      throw validationFailed([
        { pointer: '/type', code: 'invalid', detail: `one of ${SEARCH_TYPES.join(', ')}` },
      ]);
    }
    if (!types.includes(part as SearchType)) types.push(part as SearchType);
  }
  return types;
}

/** `limit` 1..50, default 20. */
export function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_SEARCH_LIMIT;
  const n =
    typeof raw === 'string' && /^\d{1,3}$/.test(raw)
      ? Number(raw)
      : typeof raw === 'number'
        ? raw
        : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_SEARCH_LIMIT) {
    throw validationFailed([
      { pointer: '/limit', code: 'out_of_range', detail: `must be 1 to ${MAX_SEARCH_LIMIT}` },
    ]);
  }
  return n;
}
