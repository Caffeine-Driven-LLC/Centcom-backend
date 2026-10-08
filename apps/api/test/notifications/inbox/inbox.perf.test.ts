/**
 * The inbox's speed on Postgres 16 (B065 test plan "list of 200 within 50 ms on 100 000 rows
 * (index use)"; DATABASE_URL, CI's integration job). A user with 100 000 notifications (one in ten
 * unread) among other users' rows: a page of 200 with its unread count, plain and unread-only,
 * first page and deep in the list, is within 50 ms at the 95th percentile, and the plans of the
 * repository's own statements (captured, then EXPLAINed with their parameters) scan an index of
 * `notifications`, never the table.
 */
import { CompiledQuery, type Kysely } from 'kysely';
import type { NotificationDb } from '@centcom/db';
import { describe, expect, it } from 'vitest';
import { createInboxRepository } from '../../../src/modules/notifications/inbox/repository.js';
import { INBOX_RETENTION_MS } from '../../../src/modules/notifications/inbox/service.js';
import { scriptedDb } from '../../modules/users/helpers.js';
import { ADMIN_URL, KEYS, migratedDatabase, pgBulk, pgUser, T0 } from './helpers.js';

const ROWS = 100_000;
const LIMIT = 200;
const P95_BUDGET_MS = 50;

const p95 = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Infinity;
};

/** Node types of a JSON plan, depth first. */
function nodes(plan: Record<string, unknown>): Record<string, unknown>[] {
  const children = (plan['Plans'] as Record<string, unknown>[] | undefined) ?? [];
  return [plan, ...children.flatMap(nodes)];
}

describe.runIf(ADMIN_URL !== undefined)('inbox performance on Postgres 16', () => {
  it(`lists ${LIMIT} of ${ROWS} rows within ${P95_BUDGET_MS} ms (p95), on an index`, async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<NotificationDb>;
      const user = await pgUser(t.db);
      const newest = new Date(T0 - 60_000);
      await pgBulk(t.db, user, ROWS, { newest, unreadEvery: 10, prefix: '1' });
      for (const prefix of ['2', '3']) {
        await pgBulk(t.db, await pgUser(t.db), 20_000, { newest, unreadEvery: 3, prefix });
      }
      await t.db.executeQuery(CompiledQuery.raw('vacuum analyze notifications'));

      const repository = createInboxRepository(db);
      const since = new Date(T0 - INBOX_RETENTION_MS);
      const params = (cursor?: string) => ({
        limit: LIMIT,
        sort: 'created',
        filterHash: 'perf',
        keys: KEYS,
        now: T0,
        ...(cursor === undefined ? {} : { cursor }),
      });
      // A cursor about 40 000 rows in.
      let deep: string | undefined;
      for (let i = 0; i < 200; i += 1) {
        const page = await repository.list(user, { unread: false, since, page: params(deep) });
        deep = page.next_cursor ?? undefined;
      }
      expect(deep).toBeDefined();

      const cases = [
        { unread: false, cursor: undefined },
        { unread: true, cursor: undefined },
        { unread: false, cursor: deep },
      ];
      for (const c of cases) {
        const run = () =>
          Promise.all([
            repository.list(user, { unread: c.unread, since, page: params(c.cursor) }),
            repository.unreadCount(user, since),
          ]);
        for (let i = 0; i < 5; i += 1) await run();
        const samples: number[] = [];
        for (let i = 0; i < 40; i += 1) {
          const start = performance.now();
          const [page, unread] = await run();
          samples.push(performance.now() - start);
          expect(page.data).toHaveLength(LIMIT);
          expect(unread).toBe(ROWS / 10);
        }
        expect(p95(samples), JSON.stringify(c)).toBeLessThan(P95_BUDGET_MS);
      }

      // The statements the repository runs, captured with their parameters, then EXPLAINed.
      const captured: CompiledQuery[] = [];
      const { db: recorder } = scriptedDb((query) => {
        captured.push(query);
        return { rows: [] };
      });
      const recording = createInboxRepository(recorder as unknown as Kysely<NotificationDb>);
      await recording.list(user, { unread: false, since, page: params() });
      await recording.list(user, { unread: true, since, page: params() });
      await recording.list(user, { unread: false, since, page: params(deep) });
      await recording.unreadCount(user, since);
      expect(captured).toHaveLength(4);
      for (const query of captured) {
        const result = await t.db.executeQuery<{
          'QUERY PLAN': { Plan: Record<string, unknown> }[];
        }>(CompiledQuery.raw(`explain (format json) ${query.sql}`, [...query.parameters]));
        const plan = result.rows[0]?.['QUERY PLAN'][0]?.Plan ?? {};
        const scans = nodes(plan).filter((n) => n['Relation Name'] === 'notifications');
        expect(scans.length, query.sql).toBeGreaterThan(0);
        for (const scan of scans) {
          expect(String(scan['Node Type']), query.sql).toMatch(
            /^(Index|Index Only|Bitmap Heap) Scan$/,
          );
        }
      }
    } finally {
      await t.drop();
    }
  }, 180_000);
});
