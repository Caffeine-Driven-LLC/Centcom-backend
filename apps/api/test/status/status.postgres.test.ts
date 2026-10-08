/**
 * Readiness and the status tables on Postgres 16 (B086; DATABASE_URL, CI's integration job):
 *
 * - `/readyz`'s checks pass on a migrated database, and fail `migrations` (only) with a pending
 *   migration or no migrations table;
 * - incidents, updates and deprecations through the real repository: ordering, the 7-day cut-off,
 *   statuses set by updates, and resolve keeping its first time.
 */
import { closeDb, createDb, type StatusDatabase } from '@centcom/db';
import { createMemoryRedis } from '@centcom/core';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { Readiness } from '../../src/modules/status/readiness.js';
import { createStatusRepository } from '../../src/modules/status/repository.js';
import { StatusAdmin } from '../../src/modules/status/service.js';
import { ADMIN_URL, migratedDatabase } from '../modules/users/helpers.js';
import { DAY_MS, T0 } from './helpers.js';

describe.runIf(ADMIN_URL !== undefined)('readiness and status on Postgres 16', () => {
  it('is ready on a migrated database, and not with a pending migration or no migrations table', async () => {
    const t = await migratedDatabase(5);
    try {
      const { rows } = await sql<{
        v: string;
      }>`select max(version) as v from schema_migrations`.execute(t.db);
      const current = rows[0]?.v ?? '';
      const redis = createMemoryRedis();
      const ready = await new Readiness({
        db: t.db,
        redis,
        expectedVersion: current,
        timeoutMs: 1000,
      }).check();
      expect(ready).toEqual({
        ok: true,
        checks: { db: { ok: true }, redis: { ok: true }, migrations: { ok: true } },
      });
      const pending = await new Readiness({
        db: t.db,
        redis,
        expectedVersion: '20991231000000',
        timeoutMs: 1000,
      }).check();
      expect(pending.checks).toEqual({
        db: { ok: true },
        redis: { ok: true },
        migrations: { ok: false },
      });

      // A database without the migrations table: reachable, but not migrated.
      const name = `${new URL(t.url).pathname.slice(1)}_empty`;
      const admin = createDb<unknown>({ url: ADMIN_URL ?? '', poolMax: 1 });
      await sql`create database ${sql.id(name)}`.execute(admin);
      const emptyUrl = new URL(t.url);
      emptyUrl.pathname = `/${name}`;
      const empty = createDb<unknown>({ url: emptyUrl.toString(), poolMax: 1 });
      try {
        const bare = await new Readiness({
          db: empty,
          redis,
          expectedVersion: current,
          timeoutMs: 1000,
        }).check();
        expect(bare.checks).toEqual({
          db: { ok: true },
          redis: { ok: true },
          migrations: { ok: false },
        });
      } finally {
        await closeDb(empty);
        await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin);
        await closeDb(admin);
      }
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('keeps incidents, updates and deprecations', async () => {
    const t = await migratedDatabase(5);
    try {
      const repo = createStatusRepository(t.db as unknown as Kysely<StatusDatabase>);
      const clock = { now: T0 - 10 * DAY_MS };
      const admin = new StatusAdmin({
        repository: repo,
        components: [{ id: 'relay-eu', name: 'Relay (EU)', probe: null }],
        clock: () => clock.now,
      });
      const old = await admin.createIncident({
        title: 'Old',
        component_ids: ['relay-eu'],
        status: 'investigating',
      });
      clock.now = T0 - 9 * DAY_MS;
      expect((await admin.resolveIncident(old.id)).resolved_at).toBe(
        new Date(T0 - 9 * DAY_MS).toISOString(),
      );
      clock.now = T0 - 8 * DAY_MS;
      // Resolving again keeps the first time.
      expect((await admin.resolveIncident(old.id)).resolved_at).toBe(
        new Date(T0 - 9 * DAY_MS).toISOString(),
      );
      clock.now = T0 - DAY_MS;
      const open = await admin.createIncident({
        title: 'Relay errors',
        component_ids: ['relay-eu'],
        status: 'investigating',
      });
      clock.now = T0 - 60_000;
      await admin.addIncidentUpdate(open.id, 'Looking into it.');
      clock.now = T0 - 30_000;
      const identified = await admin.addIncidentUpdate(open.id, 'Cause found.', 'identified');
      expect(identified.status).toBe('identified');
      expect(identified.updates.map((u) => u.text)).toEqual(['Looking into it.', 'Cause found.']);

      const feed = await repo.feedIncidents(new Date(T0 - 7 * DAY_MS), 20);
      expect(feed.map((i) => i.id)).toEqual([open.id]);
      expect((await repo.feedIncidents(new Date(T0 - 10 * DAY_MS), 20)).map((i) => i.id)).toEqual([
        open.id,
        old.id,
      ]);

      await admin.setDeprecation({ what: '/v1/legacy', sunset: '2027-03-01' });
      await admin.setDeprecation({ what: '/v1/legacy', sunset: '2027-06-01' });
      await admin.setDeprecation({ what: 'protocol 1', sunset: '2027-01-15' });
      expect(await repo.deprecations()).toEqual([
        { what: 'protocol 1', sunset: '2027-01-15' },
        { what: '/v1/legacy', sunset: '2027-06-01' },
      ]);
      expect(
        await repo.addUpdate('inc_01JA3Z8K2M5N7P9Q0R1S2T3V4W', {
          at: new Date(T0),
          text: 'x',
          status: null,
        }),
      ).toBe(false);
    } finally {
      await t.drop();
    }
  }, 60_000);
});
