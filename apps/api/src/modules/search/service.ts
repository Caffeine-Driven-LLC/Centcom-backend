/**
 * Metadata search (B089): sessions, workspaces, users and workspace members, by their cleartext
 * names and ids only (never a session's content, which is ciphertext or never stored).
 *
 * - **Matching:** `q` normalised (query.ts); a full id (`ses_`, `wsp_`, `usr_`, `mem_` + 26) is an
 *   exact lookup and ranks first; otherwise a case-insensitive substring of the name (trigram GIN
 *   indexes, migration 20260102005100_search_indexes.sql), and for users in staff scope a prefix
 *   of the email (pattern index). LIKE's `%` and `_` in `q` match themselves; every value is a
 *   bound parameter.
 * - **Ranking:** trigram similarity to `q` (rounded to 4 places), then the newest first, then the
 *   type and id: a total order, so pages never repeat or skip a hit, even while rows are inserted.
 * - **Scope:** `staff` sees every workspace (and emails); `member` sees only entities in workspaces
 *   the user belongs to (in SQL: never filtered afterwards), and never an email.
 * - **Bounds:** at most 50 per page; every search runs with a 2 s `statement_timeout`, and a
 *   cancelled or failed statement is 503 with `retry_after_s`.
 * - **Cursors:** CT-PAGE (B025), bound to the normalised query, types, workspace and scope: another
 *   query with the same cursor is 400 `cursor_invalid`. The keyset's time is Postgres's own text
 *   to the microsecond (a JS Date would cut it to milliseconds and skip tied rows).
 * - Ended or expired sessions, deleted workspaces and deleted users stay searchable (staff, within
 *   retention), flagged in their label.
 *
 * Logs carry the query's length and the types only, never `q`.
 *
 * Owns: the search SQL. Must not: read a column outside SEARCHABLE_COLUMNS to match, or log `q`.
 */
import { createHash } from 'node:crypto';
import {
  decodeCursor,
  encodeCursor,
  isAppError,
  unavailable,
  type Logger,
  type SigningKeys,
} from '@centcom/core';
import { isConnectionError, type CoreDatabase } from '@centcom/db';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  normaliseQuery,
  SEARCH_TYPES,
  type NormalisedQuery,
  type SearchType,
} from './query.js';

/** One hit. */
export interface SearchHit {
  type: SearchType;
  id: string;
  label: string;
  workspace_id: string | null;
  created_at: string;
  score: number;
}

/** Who is searching. */
export type SearchScope = { kind: 'staff' } | { kind: 'member'; userId: string };

/** A search. */
export interface SearchInput {
  q: string;
  types?: readonly SearchType[];
  workspaceId?: string;
  scope: SearchScope;
  limit?: number;
  cursor?: string;
}

/** A page of hits (CT-PAGE). */
export interface SearchPage {
  data: SearchHit[];
  next_cursor: string | null;
  has_more: boolean;
}

/** What the service needs. */
export interface SearchDeps {
  db: Kysely<CoreDatabase>;
  cursorKeys: SigningKeys;
  clock?: () => number;
  logger?: Logger;
}

/** The statement timeout of a search. */
export const SEARCH_TIMEOUT = '2s';
/** `retry_after_s` of a search that timed out or could not run. */
const RETRY_AFTER_S = 2;
/** The cursor's sort. */
const SORT = 'relevance';
/** Postgres `query_canceled` (statement_timeout). */
const QUERY_CANCELED = '57014';

interface Row {
  type: SearchType;
  id: string;
  label: string;
  workspace_id: string | null;
  created_at: Date;
  /** `created_at` as Postgres prints it in UTC, to the microsecond (the keyset's time). */
  key_at: string;
  score: string;
  key: string;
}

/** The keyset after which a page starts. */
export interface After {
  score: string;
  createdAt: string;
  key: string;
}

const ended = (state: RawBuilder<unknown>) =>
  sql`case when ${state} in ('ended', 'expired') then ' (ended)' else '' end`;

/** The workspaces a member may search in (in SQL). */
const memberWorkspaces = (userId: string) => sql`(
  select mm.workspace_id from memberships mm
  join workspaces ww on ww.id = mm.workspace_id
  where mm.user_id = ${userId} and ww.deleted_at is null
)`;

/** One type's query: its hits after `after`, best first, at most `n`. */
function typeQuery(
  type: SearchType,
  q: NormalisedQuery,
  input: { scope: SearchScope; workspaceId?: string },
  after: After | null,
  n: number,
): RawBuilder<Row> | null {
  const staff = input.scope.kind === 'staff';
  const allowed = input.scope.kind === 'member' ? memberWorkspaces(input.scope.userId) : null;
  const wid = input.workspaceId;
  const idOf = (prefix: string) => (q.id !== null && q.id.type === prefix ? q.id.value : null);
  let inner: RawBuilder<unknown>;
  switch (type) {
    case 'session': {
      const id = idOf('ses');
      inner = sql`
        select 'session' as type, s.id, s.name || ${ended(sql`s.state`)} as label,
          s.workspace_id, s.created_at,
          case when s.id = ${id} then 2::numeric
            else round(similarity(lower(s.name), ${q.text})::numeric, 4) end as score
        from sessions s
        where (lower(s.name) like ${q.contains} escape '\\' or s.id = ${id})
          ${allowed === null ? sql`` : sql`and s.workspace_id in ${allowed}`}
          ${wid === undefined ? sql`` : sql`and s.workspace_id = ${wid}`}`;
      break;
    }
    case 'workspace': {
      const id = idOf('wsp');
      inner = sql`
        select 'workspace' as type, w.id,
          w.name || ' (' || w.slug || ')' ||
            case when w.deleted_at is null then '' else ' (deleted)' end as label,
          w.id as workspace_id, w.created_at,
          case when w.id = ${id} then 2::numeric
            else round(greatest(similarity(lower(w.name), ${q.text}),
                                similarity(w.slug, ${q.text}))::numeric, 4) end as score
        from workspaces w
        where (lower(w.name) like ${q.contains} escape '\\' or w.slug like ${q.contains} escape '\\'
               or w.id = ${id})
          ${allowed === null ? sql`` : sql`and w.id in ${allowed}`}
          ${wid === undefined ? sql`` : sql`and w.id = ${wid}`}`;
      break;
    }
    case 'user': {
      const id = idOf('usr');
      // Emails: staff only, matched by prefix (or exactly) and shown in the label.
      inner = staff
        ? sql`
        select 'user' as type, u.id,
          u.display_name || ' <' || u.email::text || '>' ||
            case when u.status = 'deleted' then ' (deleted)' else '' end as label,
          null::text as workspace_id, u.created_at,
          case when u.id = ${id} then 2::numeric
            else round(greatest(similarity(lower(u.display_name), ${q.text}),
                                similarity(lower(u.email::text), ${q.text}))::numeric, 4) end as score
        from users u
        where (lower(u.display_name) like ${q.contains} escape '\\'
               or lower(u.email::text) like ${q.prefix} escape '\\' or u.id = ${id})
          ${wid === undefined ? sql`` : sql`and u.id in (select user_id from memberships where workspace_id = ${wid})`}`
        : sql`
        select 'user' as type, u.id, u.display_name as label,
          null::text as workspace_id, u.created_at,
          case when u.id = ${id} then 2::numeric
            else round(similarity(lower(u.display_name), ${q.text})::numeric, 4) end as score
        from users u
        where (lower(u.display_name) like ${q.contains} escape '\\' or u.id = ${id})
          and u.id in (select user_id from memberships where workspace_id in ${allowed ?? sql`(null)`})
          ${wid === undefined ? sql`` : sql`and u.id in (select user_id from memberships where workspace_id = ${wid})`}`;
      break;
    }
    case 'member': {
      const id = idOf('mem');
      inner = sql`
        select 'member' as type, m.id, u.display_name as label,
          m.workspace_id, m.created_at,
          case when m.id = ${id} then 2::numeric
            else round(similarity(lower(u.display_name), ${q.text})::numeric, 4) end as score
        from memberships m join users u on u.id = m.user_id
        where (lower(u.display_name) like ${q.contains} escape '\\' or m.id = ${id})
          ${allowed === null ? sql`` : sql`and m.workspace_id in ${allowed}`}
          ${wid === undefined ? sql`` : sql`and m.workspace_id = ${wid}`}`;
      break;
    }
  }
  const keyset =
    after === null
      ? sql``
      : sql`where (t.score, t.created_at, t.key) < (${after.score}::numeric, ${after.createdAt}::timestamptz, ${after.key})`;
  return sql<Row>`(
    select t.* from (
      select x.*, x.type || ':' || x.id as key,
        to_char(x.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as key_at
      from (${inner}) x
    ) t
    ${keyset}
    order by t.score desc, t.created_at desc, t.key desc
    limit ${n}
  )`;
}

/**
 * The search's statement: every type's best hits after `after`, merged, best first, at most
 * `limit + 1` (one more tells there is a next page). Exported for the EXPLAIN tests.
 */
export function buildSearchQuery(
  q: NormalisedQuery,
  types: readonly SearchType[],
  input: { scope: SearchScope; workspaceId?: string },
  after: After | null,
  limit: number,
): RawBuilder<Row> {
  const parts = types
    .map((type) => typeQuery(type, q, input, after, limit + 1))
    .filter((p): p is RawBuilder<Row> => p !== null);
  return sql<Row>`
    select * from (${sql.join(parts, sql` union all `)}) hits
    order by score desc, created_at desc, key desc
    limit ${limit + 1}`;
}

/** The filter hash a cursor is bound to. */
function filterHash(q: NormalisedQuery, types: readonly SearchType[], input: SearchInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        q: q.text,
        t: [...types].sort(),
        w: input.workspaceId ?? null,
        s: input.scope.kind === 'staff' ? 'staff' : `member:${input.scope.userId}`,
      }),
    )
    .digest('base64url');
}

/** Searches metadata. */
export async function searchMetadata(deps: SearchDeps, input: SearchInput): Promise<SearchPage> {
  const clock = deps.clock ?? Date.now;
  const q = normaliseQuery(input.q);
  const types =
    input.types === undefined || input.types.length === 0
      ? [...SEARCH_TYPES]
      : [...new Set(input.types)];
  const limit =
    input.limit !== undefined && Number.isInteger(input.limit)
      ? Math.max(1, Math.min(input.limit, MAX_SEARCH_LIMIT))
      : DEFAULT_SEARCH_LIMIT;
  const hash = filterHash(q, types, input);
  let after: After | null = null;
  if (input.cursor !== undefined) {
    const c = decodeCursor(input.cursor, deps.cursorKeys, clock(), {
      filterHash: hash,
      sort: SORT,
    });
    const [first, key] = c.k;
    const [score, createdAt] = String(first).split('|');
    if (typeof key !== 'string' || score === undefined || createdAt === undefined) {
      throw new TypeError('search: a verified cursor without its keyset');
    }
    after = { score, createdAt, key };
  }
  deps.logger?.info({ q_length: [...q.text].length, types: types.join(',') }, 'search.query');
  const query = buildSearchQuery(q, types, input, after, limit);
  let rows: Row[];
  try {
    rows = await deps.db.transaction().execute(async (trx) => {
      await sql`set local statement_timeout = ${sql.lit(SEARCH_TIMEOUT)}`.execute(trx);
      return (await query.execute(trx)).rows;
    });
  } catch (err) {
    if (isAppError(err)) throw err;
    if (isConnectionError(err) || (err as { code?: unknown } | null)?.code === QUERY_CANCELED) {
      throw unavailable(RETRY_AFTER_S, 'Search is unavailable right now; try again shortly.', {
        cause: new Error('search failed'),
      });
    }
    throw err;
  }
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const hasMore = rows.length > limit;
  return {
    data: page.map((r) => ({
      type: r.type,
      id: r.id,
      label: r.label,
      workspace_id: r.workspace_id,
      created_at: r.created_at.toISOString(),
      score: Number(r.score),
    })),
    next_cursor:
      hasMore && last !== undefined
        ? encodeCursor(
            { k: [`${last.score}|${last.key_at}`, last.key], f: hash, s: SORT },
            deps.cursorKeys,
            clock(),
          )
        : null,
    has_more: hasMore,
  };
}

/** Refuses to start search without `pg_trgm` (the migration installs it). */
export async function assertSearchReady(db: Kysely<CoreDatabase>): Promise<void> {
  const row = await sql<{ n: number }>`
    select count(*)::int as n from pg_extension where extname = 'pg_trgm'`.execute(db);
  if ((row.rows[0]?.n ?? 0) === 0) {
    throw new Error(
      'search: the pg_trgm extension is missing; run the migrations (20260102005100_search_indexes.sql)',
    );
  }
}
