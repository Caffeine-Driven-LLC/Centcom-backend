/**
 * Pagination (B025; card test plugin.test.ts, and acceptance 1, 3, 7 and 8 against Postgres):
 * `reply.page` and a list route built from the library, end to end over HTTP; then `paginate`
 * on a real Postgres 16 (DATABASE_URL, CI's integration job): 1 000 rows in pages of 200, inserts
 * racing the pages, ties, microsecond timestamps, parameter-only SQL, and an index scan (no
 * sequential scan) on 100 000 rows.
 */
import { randomBytes } from 'node:crypto';
import {
  defineFilters,
  enumFilter,
  paginate,
  paginateArray,
  parsePageQuery,
  Secret,
  type KeysetSpec,
  type Page,
  type PageParams,
  type SigningKeys,
} from '@centcom/core';
import { fastify, type FastifyInstance } from 'fastify';
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorHandlerPlugin } from '../src/plugins/error-handler.js';
import { paginationPlugin } from '../src/plugins/pagination.js';
import { requestContextPlugin } from '../src/plugins/request-context.js';
import { captureLogger } from './helpers.js';
import { ADMIN_URL, migratedDatabase, type TestDatabase } from './modules/users/helpers.js';

const KEYS: SigningKeys = [{ id: 'k1', secret: new Secret(new Uint8Array(randomBytes(32))) }];
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const itemId = (n: number): string => `itm_${String(n).padStart(6, '0')}`;

describe('reply.page and a list route', () => {
  interface Item {
    id: string;
    state: 'active' | 'ended' | 'paused';
    at: number;
  }
  const ITEMS: Item[] = Array.from({ length: 1000 }, (_, i) => ({
    id: itemId(i),
    state: i % 3 === 0 ? 'active' : 'ended',
    at: i % 50,
  }));
  const FILTERS = defineFilters({ state: enumFilter(['active', 'ended', 'paused']) });
  const SORTS = { sorts: ['at', '-at'], defaultSort: 'at' };

  async function listApp(): Promise<{ app: FastifyInstance; clock: { now: number } }> {
    const clock = { now: NOW };
    const captured = captureLogger();
    const app = fastify({ logger: false });
    await app.register(requestContextPlugin, { logger: captured.logger });
    await app.register(errorHandlerPlugin, { logger: captured.logger });
    await app.register(paginationPlugin);
    app.get('/v1/items', async (request, reply) => {
      const query = parsePageQuery(request.query, SORTS);
      const filters = FILTERS.parse(request.query);
      const items = ITEMS.filter(
        (item) => filters.state === undefined || item.state === filters.state,
      );
      const result = paginateArray(
        items,
        {
          sorts: {
            at: { value: (item) => item.at, direction: 'asc' },
            '-at': { value: (item) => item.at, direction: 'desc' },
          },
          id: (item) => item.id,
        },
        { ...query, filterHash: FILTERS.hash(filters), keys: KEYS, now: clock.now },
      );
      return reply.page(result.data, result.next_cursor);
    });
    app.get('/v1/broken', async (_request, reply) => reply.page('nope' as unknown as [], null));
    await app.ready();
    return { app, clock };
  }

  const get = async (app: FastifyInstance, query: Record<string, string>) =>
    app.inject({ url: '/v1/items', query });

  it('walks 1 000 items in 5 pages of 200 with the CT-PAGE shape (acceptance 1)', async () => {
    const { app } = await listApp();
    const pages: Page<Item>[] = [];
    let cursor: string | undefined;
    do {
      const response = await get(app, {
        limit: '200',
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<Page<Item>>();
      expect(Object.keys(body).sort()).toEqual(['data', 'has_more', 'next_cursor']);
      pages.push(body);
      cursor = body.next_cursor ?? undefined;
    } while (cursor !== undefined);
    expect(pages.map((p) => [p.data.length, p.has_more])).toEqual([
      [200, true],
      [200, true],
      [200, true],
      [200, true],
      [200, false],
    ]);
    expect(new Set(pages.flatMap((p) => p.data.map((item) => item.id))).size).toBe(1000);
  });

  it('uses 50 by default, and answers an empty list with one empty page', async () => {
    const { app } = await listApp();
    expect((await get(app, {})).json<Page<Item>>().data).toHaveLength(50);
    expect((await get(app, { state: 'paused' })).json()).toEqual({
      data: [],
      next_cursor: null,
      has_more: false,
    });
  });

  it.each([['0'], ['201'], ['abc']])(
    'answers limit=%s with 422 pointing at /limit (acceptance 2)',
    async (limit) => {
      const { app } = await listApp();
      const response = await get(app, { limit });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        code: 'validation_failed',
        errors: [{ pointer: '/limit' }],
      });
    },
  );

  it('refuses offsets', async () => {
    const { app } = await listApp();
    const response = await get(app, { offset: '100' });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      errors: [{ pointer: '/offset', code: 'not_supported' }],
    });
  });

  it('answers a tampered, re-filtered, re-sorted or expired cursor with 400 cursor_invalid (acceptance 4)', async () => {
    const { app, clock } = await listApp();
    const cursor =
      (await get(app, { state: 'active', limit: '10' })).json<Page<Item>>().next_cursor ?? '';
    const tampered = cursor.slice(0, -1) + (cursor.endsWith('A') ? 'B' : 'A');
    const cases: [Record<string, string>, string][] = [
      [{ state: 'active', cursor: tampered }, 'invalid'],
      [{ state: 'ended', cursor }, 'mismatch'],
      [{ cursor }, 'mismatch'],
      [{ state: 'active', sort: '-at', cursor }, 'mismatch'],
    ];
    for (const [query, code] of cases) {
      const response = await get(app, query);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'cursor_invalid',
        errors: [{ pointer: '/cursor', code }],
      });
    }
    clock.now += DAY_MS;
    expect((await get(app, { state: 'active', cursor })).json()).toMatchObject({
      errors: [{ code: 'expired' }],
    });
  });

  it('turns a misused reply.page into a 500, not a malformed list', async () => {
    const { app } = await listApp();
    expect((await app.inject({ url: '/v1/broken' })).statusCode).toBe(500);
  });
});

/** The tables the Postgres tests page through. */
interface ItemsTable {
  id: string;
  created_at: Date;
  kind: string;
}
interface ItemsDatabase {
  items: ItemsTable;
  big_items: ItemsTable;
}

/** A Kysely that runs every query on `real` and keeps each compiled query (the query log). */
function recording(real: Kysely<unknown>): { db: Kysely<ItemsDatabase>; queries: CompiledQuery[] } {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(query);
      return real.executeQuery<R>(query);
    },
    streamQuery() {
      throw new Error('recording does not stream');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const db = new Kysely<ItemsDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}

const SPEC: KeysetSpec = {
  sorts: {
    created_at: { column: 'created_at', direction: 'asc' },
    '-created_at': { column: 'created_at', direction: 'desc' },
  },
};
const FILTER_HASH = `sha256:${'0'.repeat(64)}`;

describe.runIf(ADMIN_URL !== undefined)('paginate on Postgres 16', () => {
  let t: TestDatabase;
  let log: ReturnType<typeof recording>;
  beforeAll(async () => {
    t = await migratedDatabase(5);
    log = recording(t.db as unknown as Kysely<unknown>);
    for (const table of ['items', 'big_items']) {
      await sql`create table ${sql.id(table)} (id text primary key, created_at timestamptz not null, kind text not null)`.execute(
        t.db,
      );
    }
  }, 60_000);
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await sql`truncate items`.execute(t.db);
  });

  const params = (overrides: Partial<PageParams> = {}): PageParams => ({
    limit: 200,
    sort: 'created_at',
    filterHash: FILTER_HASH,
    keys: KEYS,
    now: NOW,
    ...overrides,
  });

  /** Every page of `items` in `sort`, `between` run after each fetch. */
  async function walk(
    limit: number,
    sort = 'created_at',
    between: () => Promise<void> = async () => undefined,
  ): Promise<Page<{ id: string }>[]> {
    const pages: Page<{ id: string }>[] = [];
    let cursor: string | undefined;
    do {
      const current = await paginate(
        log.db.selectFrom('items').select(['id']),
        SPEC,
        params({ limit, sort, ...(cursor === undefined ? {} : { cursor }) }),
      );
      pages.push(current);
      await between();
      cursor = current.next_cursor ?? undefined;
    } while (cursor !== undefined);
    return pages;
  }

  /** The ids in Postgres's own order. */
  const ordered = async (direction: 'asc' | 'desc' = 'asc'): Promise<string[]> =>
    (
      await log.db
        .selectFrom('items')
        .select('id')
        .orderBy('created_at', direction)
        .orderBy('id', direction)
        .execute()
    ).map((r) => r.id);

  it('pages 1 000 rows by 200: 5 pages, nothing repeated or skipped, stable order (acceptance 1)', async () => {
    await sql`insert into items select 'itm_' || lpad(n::text, 6, '0'), timestamptz '2026-10-07 12:00:00+00' + (n % 97) * interval '1 second', 'a' from generate_series(1, 1000) n`.execute(
      t.db,
    );
    const pages = await walk(200);
    expect(pages.map((p) => [p.data.length, p.has_more])).toEqual([
      [200, true],
      [200, true],
      [200, true],
      [200, true],
      [200, false],
    ]);
    expect(pages[4]?.next_cursor).toBeNull();
    expect(pages.flatMap((p) => p.data.map((r) => r.id))).toEqual(await ordered());
    const backwards = await walk(200, '-created_at');
    expect(backwards.flatMap((p) => p.data.map((r) => r.id))).toEqual(await ordered('desc'));
  });

  it('never repeats or skips a row while rows are inserted between and during fetches (acceptance 3)', async () => {
    await sql`insert into items select 'itm_' || lpad((n * 2)::text, 6, '0'), timestamptz '2026-10-07 12:00:00+00' + n * interval '1 second', 'a' from generate_series(1, 400) n`.execute(
      t.db,
    );
    const before = await ordered();
    let next = 1;
    const insert = async (): Promise<void> => {
      const rows = [0, 200, 400, 600].map((seconds) => ({
        id: itemId(next++ * 2 - 1),
        created_at: new Date(Date.UTC(2026, 9, 7, 12, 0, 0) + seconds * 1000),
        kind: 'new',
      }));
      await log.db.insertInto('items').values(rows).execute();
    };
    // Inserts both between pages and racing the fetches.
    const [pages] = await Promise.all([walk(37, 'created_at', insert), insert(), insert()]);
    const seen = pages.flatMap((p) => p.data.map((r) => r.id));
    expect(new Set(seen).size).toBe(seen.length);
    const seenOld = seen.filter((id) => before.includes(id));
    expect(seenOld).toEqual(before);
  });

  it('pages 100 rows with one timestamp stably, by id (acceptance 7)', async () => {
    await sql`insert into items select 'itm_' || lpad(n::text, 6, '0'), timestamptz '2026-10-07 12:00:00+00', 'a' from generate_series(1, 100) n`.execute(
      t.db,
    );
    const pages = await walk(7);
    expect(pages).toHaveLength(15);
    expect(pages.flatMap((p) => p.data.map((r) => r.id))).toEqual(await ordered());
  });

  it('keeps microseconds: rows a microsecond apart in one millisecond page exactly', async () => {
    await sql`insert into items select 'itm_' || lpad((1000 - n)::text, 6, '0'), timestamptz '2026-10-07 12:00:00.123+00' + n * interval '1 microsecond', 'a' from generate_series(0, 99) n`.execute(
      t.db,
    );
    const ids = (await walk(9)).flatMap((p) => p.data.map((r) => r.id));
    expect(ids).toEqual(await ordered());
    expect(new Set(ids).size).toBe(100);
  });

  it('sends cursor values only as parameters, and scans an index on 100 000 rows (acceptance 8)', async () => {
    await sql`insert into big_items select 'itm_' || lpad(n::text, 6, '0'), timestamptz '2026-01-01 00:00:00+00' + n * interval '1 second', 'a' from generate_series(1, 100000) n`.execute(
      t.db,
    );
    await sql`create index big_items_created_at_id on big_items (created_at, id)`.execute(t.db);
    await sql`analyze big_items`.execute(t.db);
    const first = await paginate(
      log.db.selectFrom('big_items').select(['id', 'kind']),
      SPEC,
      params(),
    );
    log.queries.length = 0;
    await paginate(
      log.db.selectFrom('big_items').select(['id', 'kind']),
      SPEC,
      params({ cursor: first.next_cursor ?? '' }),
    );
    const [query] = log.queries;
    if (query === undefined) throw new Error('no query was logged');
    expect(query.sql).toMatch(/where \("created_at", "id"\) > \(\$1, \$2\)/);
    for (const value of query.parameters.slice(0, 2))
      expect(query.sql).not.toContain(String(value));
    expect(query.parameters[1]).toBe(first.data.at(-1)?.id);
    const plan = await t.db.executeQuery<{ 'QUERY PLAN': unknown }>(
      CompiledQuery.raw(`explain (format json) ${query.sql}`, [...query.parameters]),
    );
    const nodes = JSON.stringify(plan.rows[0]?.['QUERY PLAN']);
    expect(nodes).not.toContain('Seq Scan');
    expect(nodes).toContain('big_items_created_at_id');
  });
});
