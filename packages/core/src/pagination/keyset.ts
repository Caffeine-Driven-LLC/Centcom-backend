/**
 * Keyset pagination (B025, CT-PAGE): pages a Kysely query by `(sort column, id)`, fetching
 * `limit + 1` rows to know whether more follow, and continuing strictly after the last row's
 * keyset values, so rows inserted or deleted between fetches never repeat or skip one. The same
 * rules for lists held in memory, and the CT-PAGE response shape.
 *
 * The keyset values travel as Postgres prints them (`::text`): a timestamptz keeps its
 * microseconds, which a JavaScript Date would round away.
 *
 * Owns: the keyset WHERE, ORDER BY and LIMIT, and the next cursor. Must not: offset, count rows,
 * put a cursor value into SQL text (values are parameters), or order without the id.
 */
import { sql, type SelectQueryBuilder } from 'kysely';
import { decodeCursor, encodeCursor, type KeysetValue, type SigningKeys } from './cursor.js';
import { cursorInvalid, MAX_LIMIT } from './query.js';

/** The column a sort orders by, and which way. The column must be NOT NULL. */
export interface SortSpec {
  readonly column: string;
  readonly direction: 'asc' | 'desc';
}

/** How a query pages: its sorts by name, and the unique column that breaks ties. */
export interface KeysetSpec {
  /** Sort name (as `parsePageQuery` returns it) to column; columns come from code, never requests. */
  readonly sorts: Readonly<Record<string, SortSpec>>;
  /** The unique, NOT NULL id column; default `id`. */
  readonly idColumn?: string;
}

/** One page request. */
export interface PageParams {
  readonly limit: number;
  readonly cursor?: string;
  readonly sort: string;
  /** The hash of the request's filters (`Filters.hash`); cursors are bound to it. */
  readonly filterHash: string;
  readonly keys: SigningKeys;
  /** Milliseconds: cursors are checked against it and expire 24 h after it. */
  readonly now: number;
}

/** A CT-PAGE page. */
export interface Page<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

/** The CT-PAGE response for `data`; `has_more` is whether a next cursor exists. */
export function page<T>(data: readonly T[], nextCursor: string | null): Page<T> {
  return { data: [...data], next_cursor: nextCursor, has_more: nextCursor !== null };
}

const SORT_KEY = '__keyset_sort';
const ID_KEY = '__keyset_id';

/** Throws a RangeError for a limit outside 1..MAX_LIMIT (callers validate requests first). */
function checkLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError(`paginate: limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }
}

/** The cursor after `params.cursor`, verified, or undefined on the first page. */
function after(params: PageParams, size: number): readonly KeysetValue[] | undefined {
  if (params.cursor === undefined) return undefined;
  const cursor = decodeCursor(params.cursor, params.keys, params.now, {
    filterHash: params.filterHash,
    sort: params.sort,
  });
  // Bound to this sort and signed by us, but not shaped for it: refused like any bad cursor.
  if (cursor.k.length !== size) throw cursorInvalid();
  return cursor.k;
}

/** The cursor that continues after `values`, or null when nothing follows. */
const nextCursor = (
  hasMore: boolean,
  values: readonly KeysetValue[],
  params: PageParams,
): string | null =>
  hasMore
    ? encodeCursor({ k: values, f: params.filterHash, s: params.sort }, params.keys, params.now)
    : null;

/**
 * One page of `qb` (which must not order, limit or offset: those are cleared and set here),
 * ordered by the sort's column then the id column, both in the sort's direction. Throws a 400
 * `cursor_invalid` for a cursor that does not verify, a TypeError for a sort the spec lacks or a
 * row with a NULL keyset value, and a RangeError for a limit outside 1..200.
 */
export async function paginate<DB, TB extends keyof DB, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
  spec: KeysetSpec,
  params: PageParams,
): Promise<Page<O>> {
  checkLimit(params.limit);
  const sort = spec.sorts[params.sort];
  if (sort === undefined) throw new TypeError(`paginate: no sort named ${params.sort}`);
  const idColumn = spec.idColumn ?? 'id';
  const byId = sort.column === idColumn;
  const values = after(params, byId ? 1 : 2);
  const op = sql.raw(sort.direction === 'asc' ? '>' : '<');

  let query = qb
    .clearOrderBy()
    .clearLimit()
    .clearOffset()
    .select(sql<string>`${sql.ref(sort.column)}::text`.as(SORT_KEY))
    .select(sql<string>`${sql.ref(idColumn)}::text`.as(ID_KEY));
  if (values !== undefined) {
    const [first, second] = values;
    query = byId
      ? query.where(sql<boolean>`${sql.ref(idColumn)} ${op} ${first}`)
      : query.where(
          sql<boolean>`(${sql.ref(sort.column)}, ${sql.ref(idColumn)}) ${op} (${first}, ${second})`,
        );
  }
  if (!byId) query = query.orderBy(sql.ref(sort.column), sort.direction);
  // The rows are O plus the two keyset columns, which are read here and dropped.
  const rows = (await query
    .orderBy(sql.ref(idColumn), sort.direction)
    .limit(params.limit + 1)
    .execute()) as unknown as Record<string, unknown>[];

  const hasMore = rows.length > params.limit;
  const kept = rows.slice(0, params.limit);
  const last = kept.at(-1);
  let keyset: KeysetValue[] = [];
  if (hasMore && last !== undefined) {
    const sortValue = last[SORT_KEY];
    const id = last[ID_KEY];
    if (typeof sortValue !== 'string' || typeof id !== 'string') {
      throw new TypeError('paginate: keyset columns must be NOT NULL');
    }
    keyset = byId ? [id] : [sortValue, id];
  }
  const data = kept.map((row) => {
    const columns = Object.entries(row).filter(([key]) => key !== SORT_KEY && key !== ID_KEY);
    return Object.fromEntries(columns) as O;
  });
  return page(data, nextCursor(hasMore, keyset, params));
}

/** How a list held in memory pages: each sort's value and direction, and each item's id. */
export interface ArrayKeysetSpec<T> {
  readonly sorts: Readonly<
    Record<string, { readonly value: (item: T) => KeysetValue; readonly direction: 'asc' | 'desc' }>
  >;
  readonly id: (item: T) => string;
}

/** -1, 0 or 1: numbers by value, strings by code unit, numbers before strings. */
function compareValues(a: KeysetValue, b: KeysetValue): number {
  if (typeof a !== typeof b) return typeof a === 'number' ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One page of `items` (for lists that do not come from SQL), with the same ordering, cursors and
 * guarantees as `paginate`.
 */
export function paginateArray<T>(
  items: readonly T[],
  spec: ArrayKeysetSpec<T>,
  params: PageParams,
): Page<T> {
  checkLimit(params.limit);
  const sort = spec.sorts[params.sort];
  if (sort === undefined) throw new TypeError(`paginateArray: no sort named ${params.sort}`);
  const sign = sort.direction === 'asc' ? 1 : -1;
  const keyOf = (item: T): [KeysetValue, string] => [sort.value(item), spec.id(item)];
  const compare = (a: readonly KeysetValue[], b: readonly KeysetValue[]): number =>
    sign * (compareValues(a[0] ?? '', b[0] ?? '') || compareValues(a[1] ?? '', b[1] ?? ''));
  const values = after(params, 2);
  const ordered = items
    .map((item) => ({ item, key: keyOf(item) }))
    .filter(({ key }) => values === undefined || compare(key, values) > 0)
    .sort((a, b) => compare(a.key, b.key));
  const hasMore = ordered.length > params.limit;
  const kept = ordered.slice(0, params.limit);
  const last = kept.at(-1);
  return page(
    kept.map(({ item }) => item),
    nextCursor(hasMore, hasMore && last !== undefined ? last.key : [], params),
  );
}
