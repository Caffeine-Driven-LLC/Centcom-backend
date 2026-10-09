/**
 * Audit exports into a real S3-compatible store (B082 test plan "integration: list/export against
 * seeded Postgres and MinIO"): MinIO in a container (the testkit's, the development stack's build),
 * wherever a container runtime is reachable (CI's test and integration jobs; locally when Docker
 * runs), reading seeded Postgres where DATABASE_URL is set too (the integration job) and memory
 * otherwise. An export runs into the bucket, its download URL serves the file and only GETs, a URL
 * past its lifetime is refused, and the sweep deletes the file once it expires.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { newId } from '@centcom/contracts';
import { createAuditEmitter, Secret, type AuditEmitter } from '@centcom/core';
import type { AuditApiDb } from '@centcom/db';
import { startMinio, testcontainersRuntime, type TestMinio } from '@centcom/testkit';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_API_ACTIONS, type AuditApiAction } from '../../src/modules/audit-api/actions.js';
import { AuditExportRunner } from '../../src/modules/audit-api/exporter.js';
import { createS3ObjectStore, type ObjectStore } from '../../src/modules/audit-api/object-store.js';
import { amzDate, authorizationHeader, EMPTY_SHA256 } from '@centcom/storage';
import {
  createAuditRepository,
  type AuditRepository,
} from '../../src/modules/audit-api/repository.js';
import { AuditApiService } from '../../src/modules/audit-api/service.js';
import { auditRow, KEYS, MemoryAuditRepository } from './helpers.js';
import { ADMIN_URL, migratedDatabase, pgUser, pgWorkspace, seedEvents } from './postgres.js';

const RUNTIME = await testcontainersRuntime.check().then(
  () => true,
  () => false,
);
const BUCKET = 'exports';
const HOUR = 3_600_000;

describe.runIf(RUNTIME)('audit exports on MinIO', () => {
  let minio: TestMinio | undefined;
  let store: ObjectStore;
  let dir: string | undefined;

  beforeAll(async () => {
    minio = await startMinio();
    const endpoint = new URL(minio.endpoint);
    const now = new Date();
    const headers = { 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': amzDate(now) };
    const created = await fetch(`${minio.endpoint}/${BUCKET}`, {
      method: 'PUT',
      headers: {
        ...headers,
        authorization: authorizationHeader(
          { method: 'PUT', host: endpoint.host, segments: [BUCKET], headers },
          { ...minio, service: 's3' },
          now,
          EMPTY_SHA256,
        ),
      },
    });
    expect(created.status).toBe(200);
    store = createS3ObjectStore({
      endpoint: minio.endpoint,
      region: minio.region,
      bucket: BUCKET,
      accessKeyId: new Secret(minio.accessKeyId),
      secretAccessKey: new Secret(minio.secretAccessKey),
    });
    dir = await mkdtemp(join(tmpdir(), 'audit-minio-test-'));
  }, 180_000);

  afterAll(async () => {
    await minio?.stop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it('exports into the bucket, serves it by URL for its lifetime, and expires it', async () => {
    const now = Date.now();
    const src = await source(now);
    try {
      const { repository, workspace } = src;
      const service = new AuditApiService({
        repository,
        retentionDays: () => Promise.resolve(90),
        emitter: src.emitter,
        queue: { enqueue: () => Promise.resolve() },
        store,
        cursorKeys: KEYS,
        maxRows: 1_000_000,
        urlTtlS: 900,
        clock: () => now,
      });
      const created = await service.createExport(
        workspace,
        { format: 'csv', gzip: true, filters: {} },
        { actor: { type: 'user', id: src.owner } },
      );
      const runner = new AuditExportRunner({
        repository,
        store,
        maxRows: 1_000_000,
        retainMs: 24 * HOUR,
        ...(dir === undefined ? {} : { tmpDir: dir }),
        clock: () => now,
      });
      expect(await runner.run(created.id, { finalAttempt: false })).toBe('ready');
      // A second run of a finished export changes nothing.
      expect(await runner.run(created.id, { finalAttempt: true })).toBe('skipped');

      const ready = await service.getExport(workspace, created.id, new Date(now));
      expect(ready).toMatchObject({ status: 'ready', row_count: src.rows });
      const url = String(ready.download_url);
      const got = await fetch(url);
      expect(got.status).toBe(200);
      const gz = Buffer.from(await got.arrayBuffer());
      const lines = gunzipSync(gz).toString('utf8').trim().split('\r\n');
      expect(lines).toHaveLength(src.rows + 1);
      expect(lines[0]).toBe(
        'id,at,workspace,actor_type,actor_id,action,target_type,target_id,result,metadata',
      );

      // A download URL is for GET only.
      expect((await fetch(url, { method: 'PUT', body: 'x' })).status).toBe(403);
      expect((await fetch(url, { method: 'DELETE' })).status).toBe(403);
      expect((await fetch(url)).status).toBe(200);

      // One signed 901 s ago for 900 s has expired.
      const key = `audit-exports/${workspace}/${created.id}.csv.gz`;
      const stale = store.presignGet(key, 900, new Date(Date.now() - 901_000));
      expect((await fetch(stale)).status).toBe(403);

      // After 24 h the sweep deletes the file: even a fresh URL finds nothing.
      expect(await runner.sweep(new Date(now + 24 * HOUR))).toEqual({
        expired: 1,
        failed: 0,
        stale: [],
      });
      expect((await fetch(store.presignGet(key, 60, new Date()))).status).toBe(404);
      expect(
        (await service.getExport(workspace, created.id, new Date(now + 24 * HOUR))).status,
      ).toBe('expired');
    } finally {
      await src.drop();
    }
  }, 180_000);
});

/** The events to export: on Postgres when DATABASE_URL is set (CI's integration job), else in memory. */
async function source(now: number): Promise<{
  repository: AuditRepository;
  workspace: string;
  owner: string;
  emitter: Pick<AuditEmitter<AuditApiAction>, 'emit'>;
  /** Rows the export holds. */
  rows: number;
  drop(): Promise<void>;
}> {
  if (ADMIN_URL !== undefined) {
    const t = await migratedDatabase(5);
    const db = t.db as unknown as Kysely<AuditApiDb>;
    const owner = await pgUser(t.db);
    const workspace = await pgWorkspace(t.db, owner);
    await seedEvents(db, workspace, 50, {
      prefix: '01',
      newest: new Date(now - 1000),
      stepMs: 1000,
    });
    return {
      repository: createAuditRepository(db),
      workspace,
      owner,
      emitter: createAuditEmitter({ db, actions: AUDIT_API_ACTIONS, clock: () => now }),
      // The seeded events and the request's own `audit.export`.
      rows: 51,
      drop: () => t.drop(),
    };
  }
  const repo = new MemoryAuditRepository();
  const workspace = newId('wsp');
  for (let i = 0; i < 50; i += 1) repo.add(auditRow(workspace, { at: now - (i + 1) * 1000 }));
  return {
    repository: repo,
    workspace,
    owner: newId('usr'),
    emitter: { emit: () => Promise.resolve(newId('aud')) },
    rows: 50,
    drop: () => Promise.resolve(),
  };
}
