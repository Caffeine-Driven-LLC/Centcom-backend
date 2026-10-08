/**
 * The audit API on Postgres 16 (B082; DATABASE_URL, CI's integration job), through the real
 * repository and B036's emitter:
 *
 * - the retention horizon and the filters are in the SQL, every statement scoped by workspace;
 * - pagination over 10 000 events (several per millisecond), 200 a page, while new events are
 *   inserted: every event exactly once, newest first;
 * - an export request writes its job and its `audit.export` event in one transaction (an emitter
 *   failure leaves neither); reading writes no event;
 * - an export of 100 000 events through the S3 client (into the signature-checking fake) completes
 *   within 60 s, with the right rows; the job's states move only forward.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { newId } from '@centcom/contracts';
import { createAuditEmitter, Secret } from '@centcom/core';
import type { AuditApiDb } from '@centcom/db';
import type { CompiledQuery, Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { AUDIT_API_ACTIONS } from '../../src/modules/audit-api/actions.js';
import { AuditExportRunner } from '../../src/modules/audit-api/exporter.js';
import { createS3ObjectStore } from '../../src/modules/audit-api/object-store.js';
import { createAuditRepository } from '../../src/modules/audit-api/repository.js';
import { AuditApiService } from '../../src/modules/audit-api/service.js';
import { scriptedDb } from '../modules/users/helpers.js';
import { startFakeS3 } from './fake-s3.js';
import { KEYS } from './helpers.js';
import {
  ADMIN_URL,
  countEvents,
  migratedDatabase,
  pgUser,
  pgWorkspace,
  seedActor,
  seedEvents,
} from './postgres.js';

const DAY = 86_400_000;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

function service(db: Kysely<AuditApiDb>, over: { days?: number; now?: () => number } = {}) {
  const clock = over.now ?? (() => NOW);
  return new AuditApiService({
    repository: createAuditRepository(db),
    retentionDays: () => Promise.resolve(over.days ?? 90),
    emitter: createAuditEmitter({ db, actions: AUDIT_API_ACTIONS, clock }),
    queue: { enqueue: () => Promise.resolve() },
    store: { presignGet: (key) => `https://store.test/${key}` },
    cursorKeys: KEYS,
    maxRows: 1_000_000,
    urlTtlS: 900,
    clock,
  });
}

describe.runIf(ADMIN_URL !== undefined)('the audit API on Postgres 16', () => {
  it('applies the horizon and the filters in SQL, scoped by workspace', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<AuditApiDb>;
      const owner = await pgUser(t.db);
      const ws = await pgWorkspace(t.db, owner);
      const other = await pgWorkspace(t.db, owner);
      await seedEvents(db, ws, 100, { prefix: '01', newest: new Date(NOW - 89 * DAY), stepMs: 1 });
      await seedEvents(db, ws, 10, { prefix: '02', newest: new Date(NOW - 91 * DAY), stepMs: 1 });
      await seedEvents(db, other, 10, { prefix: '03', newest: new Date(NOW - DAY) });
      const audit = service(db);

      const page = await audit.list(ws, { filters: {}, limit: 200 }, new Date(NOW));
      expect(page.data).toHaveLength(100);
      expect(page.data.every((e) => e.workspace === ws)).toBe(true);
      expect(page.has_more).toBe(false);

      const actor = seedActor(7);
      const byActor = await audit.list(ws, { filters: { actor }, limit: 200 }, new Date(NOW));
      expect(byActor.data.map((e) => e.actor.id)).toEqual(Array(2).fill(actor));
      const both = await audit.list(
        ws,
        { filters: { actor, action: byActor.data[0]?.action ?? '' }, limit: 200 },
        new Date(NOW),
      );
      expect(both.data).toHaveLength(1);
      const unknown = await audit.list(
        ws,
        { filters: { action: 'no.such' }, limit: 200 },
        new Date(NOW),
      );
      expect(unknown.data).toEqual([]);

      // The statement itself carries the workspace and the horizon.
      const captured: CompiledQuery[] = [];
      const { db: recorder } = scriptedDb((query) => {
        captured.push(query);
        return { rows: [] };
      });
      await service(recorder as unknown as Kysely<AuditApiDb>).list(
        ws,
        { filters: { actor }, limit: 10 },
        new Date(NOW),
      );
      const statement = captured[0];
      expect(statement?.sql).toMatch(
        /where "workspace_id" = \$1 and "created_at" >= \$2 and "actor_id" = \$3/,
      );
      expect(statement?.parameters.slice(0, 3)).toEqual([ws, new Date(NOW - 90 * DAY), actor]);
    } finally {
      await t.drop();
    }
  }, 120_000);

  it('pages 10 000 events exactly once while new ones arrive, and reading writes nothing', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<AuditApiDb>;
      const ws = await pgWorkspace(t.db, await pgUser(t.db));
      // Several events per millisecond, at microsecond times only Postgres keeps.
      await seedEvents(db, ws, 10_000, {
        prefix: '01',
        newest: new Date(NOW - 60_000),
        stepMs: 0.3,
      });
      const audit = service(db);
      const before = await countEvents(db, ws);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await audit.list(
          ws,
          { filters: {}, limit: 200, ...(cursor === undefined ? {} : { cursor }) },
          new Date(NOW),
        );
        seen.push(...page.data.map((e) => e.id));
        cursor = page.next_cursor ?? undefined;
        pages += 1;
        const n = 64 + pages;
        await seedEvents(db, ws, 3, {
          prefix: `${CROCKFORD[n >> 5] ?? ''}${CROCKFORD[n & 31] ?? ''}`,
          newest: new Date(NOW - 1000),
        });
      } while (cursor !== undefined);
      expect(pages).toBe(50);
      expect(seen).toHaveLength(10_000);
      expect(new Set(seen).size).toBe(10_000);
      const ordered = await db
        .selectFrom('audit_events')
        .select('id')
        .where('workspace_id', '=', ws)
        .where('created_at', '<', new Date(NOW - 50_000))
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
      expect(seen).toEqual(ordered.map((r) => r.id));
      // Only the inserted events were added: listing wrote no audit event.
      expect(await countEvents(db, ws)).toBe(before + 3 * pages);
    } finally {
      await t.drop();
    }
  }, 120_000);

  it('writes an export and its audit event together, or neither', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<AuditApiDb>;
      const owner = await pgUser(t.db);
      const ws = await pgWorkspace(t.db, owner);
      await seedEvents(db, ws, 10, { prefix: '01', newest: new Date(NOW - DAY) });
      const requester = { actor: { type: 'user' as const, id: owner }, requestId: newId('req') };
      const created = await service(db).createExport(
        ws,
        { format: 'json', gzip: false, filters: { action: 'member.add' } },
        requester,
      );
      const job = await db.selectFrom('audit_export_jobs').selectAll().executeTakeFirstOrThrow();
      expect(job).toMatchObject({
        id: created.id,
        workspace_id: ws,
        requested_by: owner,
        format: 'json',
        status: 'pending',
        filters: { action: 'member.add', since: new Date(NOW - 90 * DAY).toISOString() },
      });
      const event = await db
        .selectFrom('audit_events')
        .selectAll()
        .where('action', '=', 'audit.export')
        .executeTakeFirstOrThrow();
      expect(event).toMatchObject({
        workspace_id: ws,
        actor_type: 'user',
        actor_id: owner,
        target_type: 'audit_export',
        target_id: created.id,
        outcome: 'success',
        request_id: requester.requestId,
        meta: { format: 'json', gzip: false, filters: 'action' },
      });

      const failing = new AuditApiService({
        repository: createAuditRepository(db),
        retentionDays: () => Promise.resolve(90),
        emitter: { emit: () => Promise.reject(new Error('audit insert failed')) },
        queue: { enqueue: () => Promise.resolve() },
        store: { presignGet: () => '' },
        cursorKeys: KEYS,
        maxRows: 1_000_000,
        urlTtlS: 900,
        clock: () => NOW,
      });
      await expect(
        failing.createExport(ws, { format: 'csv', gzip: false, filters: {} }, requester),
      ).rejects.toThrow('audit insert failed');
      expect(await db.selectFrom('audit_export_jobs').select('id').execute()).toHaveLength(1);

      // States only move forward.
      const repo = createAuditRepository(db);
      expect(
        await repo.finish(created.id, {
          rowCount: 1,
          objectKey: 'k',
          completedAt: new Date(NOW),
          expiresAt: new Date(NOW + DAY),
        }),
      ).toBe(false);
      expect((await repo.start(created.id, new Date(NOW)))?.status).toBe('running');
      expect((await repo.start(created.id, new Date(NOW)))?.status).toBe('running');
      expect(
        await repo.finish(created.id, {
          rowCount: 1,
          objectKey: 'k',
          completedAt: new Date(NOW),
          expiresAt: new Date(NOW + DAY),
        }),
      ).toBe(true);
      expect(await repo.fail(created.id, 'internal', new Date(NOW))).toBe(false);
      expect(await repo.start(created.id, new Date(NOW))).toBeNull();
      expect(await repo.expiring(new Date(NOW + DAY - 1), 10)).toEqual([]);
      expect(await repo.expiring(new Date(NOW + DAY), 10)).toEqual([
        { id: created.id, objectKey: 'k' },
      ]);
      await repo.expire(created.id);
      expect((await repo.getExport(ws, created.id))?.status).toBe('expired');
      expect(await repo.getExport(newId('wsp'), created.id)).toBeNull();

      // The sweep's queries: a pending export is stale after its request, then failed as stuck.
      const later = await service(db).createExport(
        ws,
        { format: 'csv', gzip: false, filters: {} },
        requester,
      );
      expect(await repo.stalePending(new Date(NOW), 10)).toEqual([]);
      expect(await repo.stalePending(new Date(NOW + 1), 10)).toEqual([later.id]);
      expect(await repo.failStuck(new Date(NOW + 1), new Date(NOW + 2))).toBe(1);
      expect(await repo.getExport(ws, later.id)).toMatchObject({
        status: 'failed',
        error: 'internal',
      });
      // A finished export is never failed as stuck.
      expect((await repo.getExport(ws, created.id))?.status).toBe('expired');
    } finally {
      await t.drop();
    }
  }, 120_000);

  it('exports 100 000 events within 60 s', async () => {
    const t = await migratedDatabase(5);
    const accessKeyId = `test${randomBytes(4).toString('hex')}`;
    const secretAccessKey = randomBytes(16).toString('hex');
    const s3 = await startFakeS3({ accessKeyId, secretAccessKey, region: 'us-east-1' }, 'exports');
    const dir = await mkdtemp(join(tmpdir(), 'audit-pg-export-'));
    try {
      const db = t.db as unknown as Kysely<AuditApiDb>;
      const owner = await pgUser(t.db);
      const ws = await pgWorkspace(t.db, owner);
      const now = Date.now();
      await seedEvents(db, ws, 100_000, {
        prefix: '01',
        newest: new Date(now - 60_000),
        stepMs: 10,
      });
      const store = createS3ObjectStore({
        endpoint: s3.endpoint,
        region: 'us-east-1',
        bucket: 'exports',
        accessKeyId: new Secret(accessKeyId),
        secretAccessKey: new Secret(secretAccessKey),
      });
      const audit = service(db, { now: () => now });
      const created = await audit.createExport(
        ws,
        { format: 'csv', gzip: true, filters: {} },
        { actor: { type: 'user', id: owner } },
      );
      const runner = new AuditExportRunner({
        repository: createAuditRepository(db),
        store,
        maxRows: 1_000_000,
        retainMs: DAY,
        tmpDir: dir,
        clock: () => now,
      });
      const started = performance.now();
      expect(await runner.run(created.id, { finalAttempt: false })).toBe('ready');
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(60_000);

      // The seeded events and the request's own audit event, which happened at the request time.
      const job = await db.selectFrom('audit_export_jobs').selectAll().executeTakeFirstOrThrow();
      expect(job).toMatchObject({ status: 'ready', row_count: 100_001 });
      const object = s3.objects.get(String(job.object_key));
      const lines = gunzipSync(object?.body ?? Buffer.alloc(0))
        .toString('utf8')
        .trimEnd()
        .split('\r\n');
      expect(lines).toHaveLength(100_002);
      expect(lines[1]).toContain(',audit.export,');
      const ids = lines.slice(2).map((line) => line.slice(0, 30));
      expect(new Set(ids).size).toBe(100_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await s3.close();
      await t.drop();
    }
  }, 180_000);
});
