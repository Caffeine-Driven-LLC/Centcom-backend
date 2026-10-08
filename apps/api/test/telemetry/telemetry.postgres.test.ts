/**
 * Telemetry on Postgres 16 (B085; DATABASE_URL, CI's integration job):
 *
 * - a batch is one INSERT into the day's partition, created on demand;
 * - no column of the telemetry tables can hold an address, a user, a device or a request id;
 * - the previous day is rolled up exactly once over three runs, as counts only; partitions older
 *   than 90 days are dropped (rolled up first);
 * - a 100-event batch through the route is answered within 25 ms at the 95th percentile.
 */
import { createMemoryRedis, Secret } from '@centcom/core';
import type { TelemetryDatabase } from '@centcom/db';
import { fastify } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { TelemetryLimits } from '../../src/modules/telemetry/limits.js';
import { createTelemetryRepository } from '../../src/modules/telemetry/repository.js';
import { TelemetryRetention } from '../../src/modules/telemetry/retention.js';
import { TelemetryIngest } from '../../src/modules/telemetry/service.js';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.js';
import { telemetryRoutes } from '../../src/routes/telemetry.js';
import { captureLogger } from '../helpers.js';
import { ADMIN_URL, migratedDatabase, scriptedDb } from '../modules/users/helpers.js';
import { batch, DAY_MS, event, INSTALL, post, T0 } from './helpers.js';

const day = (offset: number) => new Date(T0 + offset * DAY_MS).toISOString().slice(0, 10);
const events = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({
    install_id: INSTALL,
    type: 'feature.used' as const,
    at: new Date(T0 + offset * DAY_MS),
    props: { key: i % 2 === 0 ? 'editor.split' : 'queue.add' },
  }));

describe.runIf(ADMIN_URL !== undefined)('telemetry on Postgres 16', () => {
  it('inserts batches into day partitions created on demand, in one statement', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<TelemetryDatabase>;
      const repo = createTelemetryRepository(db);
      await repo.insert(day(0), events(100));
      await repo.insert(day(0), events(3));
      await repo.insert(day(-1), events(2, -1));
      expect(await repo.partitionDays()).toEqual([day(-1), day(0)]);
      const { rows } = await sql<{
        n: string;
      }>`select count(*) as n from ${sql.table(`telemetry_events_${day(0).replaceAll('-', '')}`)}`.execute(
        db,
      );
      expect(Number(rows[0]?.n)).toBe(103);

      // The repository's statements: one INSERT per batch, inside the 1 s statement timeout.
      const statements: string[] = [];
      const { db: recorder } = scriptedDb((query) => {
        statements.push(query.sql);
        return { rows: [] };
      });
      await createTelemetryRepository(recorder as unknown as Kysely<TelemetryDatabase>).insert(
        day(0),
        events(100),
      );
      expect(statements.filter((s) => /^insert into "telemetry_events"/.test(s))).toHaveLength(1);
      expect(statements.some((s) => s.includes('statement_timeout'))).toBe(true);
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('has no column for an address, a user, a device or a request', async () => {
    const t = await migratedDatabase(5);
    try {
      const { rows } = await sql<{ table_name: string; column_name: string }>`
        select table_name, column_name from information_schema.columns
        where table_name like 'telemetry%' and table_schema = 'public'
        order by table_name, ordinal_position
      `.execute(t.db);
      const columns = rows.map((r) => `${r.table_name}.${r.column_name}`);
      expect(columns).toEqual(
        expect.arrayContaining([
          'telemetry_events.day',
          'telemetry_events.install_id',
          'telemetry_events.type',
          'telemetry_events.at',
          'telemetry_events.props',
          'telemetry_daily_agg.count',
        ]),
      );
      for (const column of columns) {
        expect(column).not.toMatch(/ip|user|usr|device|request|workspace|address|email/);
      }
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('rolls a day up exactly once over three runs, and drops partitions older than 90 days', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<TelemetryDatabase>;
      const repo = createTelemetryRepository(db);
      await repo.insert(day(-1), events(5, -1));
      await repo.insert(day(-91), events(2, -91));
      await repo.insert(day(-95), events(1, -95));
      await repo.insert(day(0), events(1));
      const retention = new TelemetryRetention({
        repository: repo,
        retentionDays: 90,
        clock: () => T0,
      });
      for (let run = 0; run < 3; run += 1) await retention.rollup(day(-1));
      const agg = await db
        .selectFrom('telemetry_daily_agg')
        .select(['type', 'key', 'count'])
        .where(sql<boolean>`day = ${day(-1)}::date`)
        .orderBy('key')
        .execute();
      expect(agg).toEqual([
        { type: 'feature.used', key: '*', count: '5' },
        { type: 'feature.used', key: 'key=editor.split', count: '3' },
        { type: 'feature.used', key: 'key=queue.add', count: '2' },
      ]);

      const dropped = await retention.drop();
      expect(dropped).toEqual([
        `telemetry_events_${day(-95).replaceAll('-', '')}`,
        `telemetry_events_${day(-91).replaceAll('-', '')}`,
      ]);
      expect(await repo.partitionDays()).toEqual([day(-1), day(0)]);
      expect(await repo.rolledUpDays()).toEqual(
        expect.arrayContaining([day(-95), day(-91), day(-1)]),
      );
      expect(await retention.drop()).toEqual([]);
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('answers a 100-event batch within 25 ms at the 95th percentile', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<TelemetryDatabase>;
      const redis = createMemoryRedis();
      let now = Date.now();
      const ingest = new TelemetryIngest({
        repository: createTelemetryRepository(db),
        limits: new TelemetryLimits(redis.rateLimit, new Secret('s'.repeat(32))),
        config: { maxEvents: 100, maxBytes: 65_536, retentionDays: 90 },
        clock: () => now,
      });
      const app = fastify({ logger: false });
      await app.register(errorHandlerPlugin, { logger: captureLogger().logger });
      await app.register(telemetryRoutes, { ingest });
      await app.ready();
      const at = now - 60_000;
      const install = (i: number) => `01JA3Z8K2M5N7P9Q0R1S2T${String(i).padStart(4, '0')}`;
      const body = (i: number) =>
        batch(
          Array.from({ length: 100 }, (_, k) =>
            event(
              k % 2 === 0 ? 'feature.used' : 'perf.frame',
              k % 2 === 0 ? { key: 'editor.split' } : { p95_ms: 16 },
              at,
            ),
          ),
          { install_id: install(i) },
        );
      for (let i = 0; i < 10; i += 1) await post(app, body(i), {}, `192.0.2.${i}`);
      const samples: number[] = [];
      for (let i = 0; i < 60; i += 1) {
        now += 1000;
        const started = performance.now();
        const res = await post(app, body(100 + i), {}, `198.51.100.${i}`);
        samples.push(performance.now() - started);
        expect(res.statusCode).toBe(204);
      }
      samples.sort((a, b) => a - b);
      expect(samples[Math.ceil(samples.length * 0.95) - 1]).toBeLessThanOrEqual(25);
      const { rows } = await sql<{ n: string }>`select count(*) as n from telemetry_events`.execute(
        db,
      );
      expect(Number(rows[0]?.n)).toBe(70 * 100);
      // Privacy: nothing stored looks like an address, a user or request id, an e-mail or a path.
      const stored = JSON.stringify(await db.selectFrom('telemetry_events').selectAll().execute());
      expect(stored).not.toMatch(
        /(?:\d{1,3}\.){3}\d{1,3}|usr_|req_|[^\s@"]+@[^\s@"]+\.|\/home|[A-Z]:\\/,
      );
      await app.close();
    } finally {
      await t.drop();
    }
  }, 120_000);
});
