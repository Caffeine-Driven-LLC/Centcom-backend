/**
 * Keyset pagination (B025, card test keyset.test.ts): the SQL `paginate` builds (keyset WHERE in
 * both directions, id tie-breaker, limit + 1, values only as parameters: acceptance 8's query
 * log), how it assembles pages, and `paginateArray` (acceptance 1, 3 and 7 for in-memory lists).
 * The same guarantees against a real Postgres are in apps/api/test/pagination.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  AppError,
  decodeCursor,
  encodeCursor,
  page,
  paginate,
  paginateArray,
  type ArrayKeysetSpec,
  type KeysetSpec,
  type Page,
  type PageParams,
} from '../../src/index.js';
import { BINDING, NOW, scriptedDb, signingKey } from './helpers.js';

const KEYS = [signingKey('k1')];
const SPEC: KeysetSpec = {
  sorts: {
    created_at: { column: 'created_at', direction: 'asc' },
    '-created_at': { column: 'created_at', direction: 'desc' },
    id: { column: 'id', direction: 'asc' },
  },
};
const params = (overrides: Partial<PageParams> = {}): PageParams => ({
  limit: 2,
  sort: 'created_at',
  filterHash: BINDING.filterHash,
  keys: KEYS,
  now: NOW,
  ...overrides,
});
const cursorFor = (k: (string | number)[], sort = 'created_at'): string =>
  encodeCursor({ k, f: BINDING.filterHash, s: sort }, KEYS, NOW);

/** A row as the scripted driver returns it: the item plus the two keyset columns. */
const row = (id: string, at: string) => ({
  id,
  kind: 'a',
  __keyset_sort: at,
  __keyset_id: id,
});

describe('page', () => {
  it('builds the CT-PAGE shape', () => {
    expect(page([1, 2], 'next')).toEqual({ data: [1, 2], next_cursor: 'next', has_more: true });
    expect(page([], null)).toEqual({ data: [], next_cursor: null, has_more: false });
  });
});

describe('paginate', () => {
  it('asks for limit + 1 rows in (sort, id) order, with no WHERE on the first page', async () => {
    const { db, queries } = scriptedDb();
    const result = await paginate(db.selectFrom('items').select(['id', 'kind']), SPEC, params());
    expect(result).toEqual({ data: [], next_cursor: null, has_more: false });
    expect(queries[0]?.sql).toBe(
      'select "id", "kind", "created_at"::text as "__keyset_sort", "id"::text as "__keyset_id" from "items" order by "created_at" asc, "id" asc limit $1',
    );
    expect(queries[0]?.parameters).toEqual([3]);
  });

  it('continues after the cursor with values only as parameters (acceptance 8)', async () => {
    const { db, queries } = scriptedDb();
    const at = '2026-10-07 12:00:00.123456+00';
    await paginate(
      db.selectFrom('items').selectAll(),
      SPEC,
      params({ cursor: cursorFor([at, 'itm_2']) }),
    );
    const [query] = queries;
    expect(query?.sql).toContain(
      'where ("created_at", "id") > ($1, $2) order by "created_at" asc, "id" asc limit $3',
    );
    expect(query?.parameters).toEqual([at, 'itm_2', 3]);
    expect(query?.sql).not.toContain(at);
    expect(query?.sql).not.toContain('itm_2');
  });

  it('pages backwards with < and descending order, and by id alone with one value', async () => {
    const { db, queries } = scriptedDb();
    await paginate(
      db.selectFrom('items').selectAll(),
      SPEC,
      params({ sort: '-created_at', cursor: cursorFor(['t', 'itm_2'], '-created_at') }),
    );
    expect(queries[0]?.sql).toContain(
      'where ("created_at", "id") < ($1, $2) order by "created_at" desc, "id" desc',
    );
    await paginate(
      db.selectFrom('items').selectAll(),
      SPEC,
      params({ sort: 'id', cursor: cursorFor(['itm_2'], 'id') }),
    );
    expect(queries[1]?.sql).toContain('where "id" > $1 order by "id" asc limit $2');
  });

  it("replaces the query's own order, limit and offset: nothing pages by offset", async () => {
    const { db, queries } = scriptedDb();
    const query = db.selectFrom('items').selectAll().orderBy('kind').limit(10).offset(20);
    await paginate(query, SPEC, params());
    expect(queries[0]?.sql).not.toContain('offset');
    expect(queries[0]?.sql).toMatch(/order by "created_at" asc, "id" asc limit \$1$/);
  });

  it('returns limit rows without the keyset columns, and a cursor after the last one', async () => {
    const rows = [row('itm_1', 't1'), row('itm_2', 't2'), row('itm_3', 't3')];
    const { db } = scriptedDb(() => rows);
    const result: Page<{ id: string }> = await paginate(
      db.selectFrom('items').select(['id', 'kind']),
      SPEC,
      params(),
    );
    expect(result.data).toEqual([
      { id: 'itm_1', kind: 'a' },
      { id: 'itm_2', kind: 'a' },
    ]);
    expect(result.has_more).toBe(true);
    expect(decodeCursor(result.next_cursor ?? '', KEYS, NOW, BINDING).k).toEqual(['t2', 'itm_2']);
    const { db: exact } = scriptedDb(() => rows.slice(0, 2));
    expect(await paginate(exact.selectFrom('items').selectAll(), SPEC, params())).toMatchObject({
      next_cursor: null,
      has_more: false,
    });
  });

  it('refuses NULL keyset values, unknown sorts, bad limits and cursors for another sort', async () => {
    const { db } = scriptedDb(() => [
      row('itm_1', 't1'),
      { ...row('itm_2', 't2'), __keyset_sort: null },
      row('itm_3', 't3'),
    ]);
    await expect(paginate(db.selectFrom('items').selectAll(), SPEC, params())).rejects.toThrow(
      TypeError,
    );
    await expect(
      paginate(db.selectFrom('items').selectAll(), SPEC, params({ sort: 'name' })),
    ).rejects.toThrow(TypeError);
    for (const limit of [0, 201, 1.5]) {
      await expect(
        paginate(db.selectFrom('items').selectAll(), SPEC, params({ limit })),
      ).rejects.toThrow(RangeError);
    }
    const otherSort = cursorFor(['itm_2'], 'id');
    await expect(
      paginate(db.selectFrom('items').selectAll(), SPEC, params({ cursor: otherSort })),
    ).rejects.toMatchObject({ code: 'cursor_invalid', errors: [{ code: 'mismatch' }] });
    // Signed for this sort but with one keyset value where it needs two.
    const misshapen = cursorFor(['t1']);
    await expect(
      paginate(db.selectFrom('items').selectAll(), SPEC, params({ cursor: misshapen })),
    ).rejects.toBeInstanceOf(AppError);
  });
});

interface Item {
  id: string;
  at: number;
}
const ARRAY_SPEC: ArrayKeysetSpec<Item> = {
  sorts: {
    at: { value: (item) => item.at, direction: 'asc' },
    '-at': { value: (item) => item.at, direction: 'desc' },
    name: { value: (item) => item.id, direction: 'asc' },
  },
  id: (item) => item.id,
};
const itemId = (n: number): string => `itm_${String(n).padStart(5, '0')}`;

/** Every page of `items` in `sort`, following next_cursor, with `between` run after each page. */
function walk(
  items: () => readonly Item[],
  sort: string,
  limit: number,
  between: (pageIndex: number) => void = () => undefined,
): Page<Item>[] {
  const pages: Page<Item>[] = [];
  let cursor: string | undefined;
  do {
    const current = paginateArray(
      items(),
      ARRAY_SPEC,
      params({ limit, sort, ...(cursor === undefined ? {} : { cursor }) }),
    );
    pages.push(current);
    between(pages.length);
    cursor = current.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return pages;
}

describe('paginateArray', () => {
  const thousand = Array.from({ length: 1000 }, (_, i) => ({
    id: itemId(i),
    at: (i * 7919) % 1000,
  }));

  it('pages 1 000 items by 200 in 5 pages, none repeated or skipped (acceptance 1)', () => {
    const pages = walk(() => thousand, 'at', 200);
    expect(pages).toHaveLength(5);
    expect(pages.map((p) => p.has_more)).toEqual([true, true, true, true, false]);
    expect(pages[4]?.next_cursor).toBeNull();
    const ids = pages.flatMap((p) => p.data.map((item) => item.id));
    expect(new Set(ids).size).toBe(1000);
    const ats = pages.flatMap((p) => p.data.map((item) => item.at));
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
  });

  it('breaks ties by id, so 100 equal values page stably (acceptance 7)', () => {
    const tied = Array.from({ length: 100 }, (_, i) => ({ id: itemId(99 - i), at: 5 }));
    const ids = walk(() => tied, 'at', 7).flatMap((p) => p.data.map((item) => item.id));
    expect(ids).toEqual(Array.from({ length: 100 }, (_, i) => itemId(i)));
    const backwards = walk(() => tied, '-at', 7).flatMap((p) => p.data.map((item) => item.id));
    expect(backwards).toEqual(Array.from({ length: 100 }, (_, i) => itemId(99 - i)));
  });

  it('never repeats or skips a row that was there, while rows are inserted between pages (acceptance 3)', () => {
    const items: Item[] = Array.from({ length: 300 }, (_, i) => ({ id: itemId(i * 2), at: i }));
    const before = new Set(items.map((item) => item.id));
    let next = 1;
    const seen = walk(
      () => items,
      'at',
      40,
      () => {
        // New rows land everywhere: before the cursor, at it, and after it.
        for (const at of [0, 150, 299, 400]) {
          items.push({ id: itemId(next), at });
          next += 2;
        }
      },
    ).flatMap((p) => p.data.map((item) => item.id));
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of before) expect(seen).toContain(id);
  });

  it('orders numbers before strings, and an empty list is one empty page', () => {
    const mixed: ArrayKeysetSpec<{ id: string; v: string | number }> = {
      sorts: { v: { value: (item) => item.v, direction: 'asc' } },
      id: (item) => item.id,
    };
    const result = paginateArray(
      [
        { id: 'a', v: 'b' },
        { id: 'b', v: 2 },
        { id: 'c', v: 'a' },
        { id: 'd', v: 1 },
      ],
      mixed,
      params({ sort: 'v', limit: 10 }),
    );
    expect(result.data.map((item) => item.v)).toEqual([1, 2, 'a', 'b']);
    expect(paginateArray([], ARRAY_SPEC, params({ sort: 'at' }))).toEqual({
      data: [],
      next_cursor: null,
      has_more: false,
    });
    expect(() => paginateArray([], ARRAY_SPEC, params({ sort: 'nope' }))).toThrow(TypeError);
  });
});
