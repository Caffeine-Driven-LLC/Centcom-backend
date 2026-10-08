/**
 * The audit list's speed on Postgres 16 (B082 acceptance "list p95 <= 150 ms with 1 million events
 * in the workspace and filter by actor (index used, verified by EXPLAIN)", test plan "EXPLAIN
 * assertions for the three filter combinations"; DATABASE_URL, CI's integration job).
 *
 * A workspace with 1 000 000 events (50 actors, 30 actions) beside another with 100 000. A page of
 * 200 filtered by actor, first and deep in the list, is within 150 ms at the 95th percentile. The
 * repository's own statements (captured, then EXPLAINed with their parameters) read
 * `audit_events` through the index made for them, never by a sequential scan or a sort:
 *
 * - by actor: `audit_events_workspace_id_actor_id_created_at_idx`;
 * - by action: `audit_events_workspace_id_action_created_at_idx`;
 * - by time range alone: B036's `audit_events_workspace_id_created_at_id_idx`.
 */
import type { AuditApiDb } from '@centcom/db';
import { CompiledQuery, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createAuditRepository, AUDIT_SORT } from '../../src/modules/audit-api/repository.js';
import type { AuditFilters } from '../../src/modules/audit-api/filters.js';
import { scriptedDb } from '../modules/users/helpers.js';
import { KEYS } from './helpers.js';
import {
  ADMIN_URL,
  migratedDatabase,
  pgUser,
  pgWorkspace,
  SEED_ACTIONS,
  seedActor,
  seedEvents,
} from './postgres.js';

const ROWS = 1_000_000;
const LIMIT = 200;
const P95_BUDGET_MS = 150;
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const DAY = 86_400_000;

const p95 = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Infinity;
};

/** Nodes of a JSON plan, depth first. */
function nodes(plan: Record<string, unknown>): Record<string, unknown>[] {
  const children = (plan['Plans'] as Record<string, unknown>[] | undefined) ?? [];
  return [plan, ...children.flatMap(nodes)];
}

describe.runIf(ADMIN_URL !== undefined)('audit list performance on Postgres 16', () => {
  it(`lists ${LIMIT} of ${ROWS} events by actor within ${P95_BUDGET_MS} ms (p95), on its index`, async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<AuditApiDb>;
      const owner = await pgUser(t.db);
      const ws = await pgWorkspace(t.db, owner);
      const other = await pgWorkspace(t.db, owner);
      // 1 000 000 events over about 14 hours, and a neighbour's 100 000.
      await seedEvents(db, ws, ROWS, { prefix: '01', newest: new Date(NOW - 60_000), stepMs: 50 });
      await seedEvents(db, other, 100_000, { prefix: '02', newest: new Date(NOW - 60_000) });
      await t.db.executeQuery(CompiledQuery.raw('vacuum analyze audit_events'));

      const repository = createAuditRepository(db);
      const since = new Date(NOW - 90 * DAY);
      const actor = seedActor(17);
      const page = (filters: AuditFilters, cursor?: string) =>
        repository.list(
          { workspaceId: ws, filters, since },
          {
            limit: LIMIT,
            sort: AUDIT_SORT,
            filterHash: 'perf',
            keys: KEYS,
            now: NOW,
            ...(cursor === undefined ? {} : { cursor }),
          },
        );

      // A cursor 20 pages (4 000 of the actor's 20 000 events) in.
      let deep: string | undefined;
      for (let i = 0; i < 20; i += 1) deep = (await page({ actor }, deep)).next_cursor ?? undefined;
      expect(deep).toBeDefined();

      for (const cursor of [undefined, deep]) {
        for (let i = 0; i < 5; i += 1) await page({ actor }, cursor);
        const samples: number[] = [];
        for (let i = 0; i < 40; i += 1) {
          const start = performance.now();
          const result = await page({ actor }, cursor);
          samples.push(performance.now() - start);
          expect(result.data).toHaveLength(LIMIT);
          expect(result.data.every((e) => e.actor_id === actor)).toBe(true);
        }
        expect(p95(samples), cursor === undefined ? 'first page' : 'deep page').toBeLessThan(
          P95_BUDGET_MS,
        );
      }

      // The statements the repository runs, captured with their parameters, then EXPLAINed.
      const action = SEED_ACTIONS[3] ?? 'member.add';
      const cases: [string, AuditFilters, string][] = [
        ['actor', { actor }, 'audit_events_workspace_id_actor_id_created_at_idx'],
        ['action', { action }, 'audit_events_workspace_id_action_created_at_idx'],
        [
          'time range',
          { range: { from: new Date(NOW - 10 * 3_600_000), to: new Date(NOW - 2 * 3_600_000) } },
          'audit_events_workspace_id_created_at_id_idx',
        ],
      ];
      for (const [name, filters, index] of cases) {
        const captured: CompiledQuery[] = [];
        const { db: recorder } = scriptedDb((query) => {
          captured.push(query);
          return { rows: [] };
        });
        await createAuditRepository(recorder as unknown as Kysely<AuditApiDb>).list(
          { workspaceId: ws, filters, since },
          { limit: LIMIT, sort: AUDIT_SORT, filterHash: 'perf', keys: KEYS, now: NOW },
        );
        expect(captured, name).toHaveLength(1);
        const query = captured[0] as CompiledQuery;
        const result = await t.db.executeQuery<{
          'QUERY PLAN': { Plan: Record<string, unknown> }[];
        }>(CompiledQuery.raw(`explain (format json) ${query.sql}`, [...query.parameters]));
        const plan = nodes(result.rows[0]?.['QUERY PLAN'][0]?.Plan ?? {});
        const scans = plan.filter((n) => n['Relation Name'] === 'audit_events');
        expect(scans.length, name).toBe(1);
        expect(String(scans[0]?.['Node Type']), name).toMatch(/^Index (Only )?Scan$/);
        expect(scans[0]?.['Index Name'], name).toBe(index);
        expect(
          plan.some((n) => n['Node Type'] === 'Sort'),
          `${name}: no sort`,
        ).toBe(false);
      }
    } finally {
      await t.drop();
    }
  }, 600_000);
});
