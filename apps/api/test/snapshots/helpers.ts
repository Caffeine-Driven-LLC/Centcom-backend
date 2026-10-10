/**
 * Test helpers for snapshots (B056): an in-memory `SnapshotRows` with the Postgres repository's
 * rules (pending cap, conditional state changes, latest by seq), snapshot objects whose URLs are
 * the real SigV4 pre-signed ones (`presign.ts`) over B055's memory BlobStore, a fake store that
 * enforces those URLs' policy (expiry, method, exact signed content-length, key) the way S3 does,
 * random "ciphertext" fixtures with a known SHA-256, a recording audit sink, and the API on the
 * real request-context, error-handler, auth and idempotency plugins.
 */
import { createHash, randomBytes } from 'node:crypto';
import { newId } from '@centcom/contracts';
import { createMemoryRedis, Secret, type AuditEvent } from '@centcom/core';
import {
  BlobNotFoundError,
  BlobStoreError,
  createMemoryBlobStore,
  type ObjectStoreConfig,
} from '@centcom/storage';
import { fastify, type FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { authPlugin } from '../../src/plugins/auth.js';
import { errorHandlerPlugin, frameworkErrorHandler } from '../../src/plugins/error-handler.js';
import { idempotencyPlugin } from '../../src/plugins/idempotency.js';
import { requestContextPlugin } from '../../src/plugins/request-context.js';
import {
  HASH_CHUNK_BYTES,
  type SnapshotObjects,
  type SnapshotRow,
  type SnapshotRows,
} from '../../src/modules/snapshots/ports.js';
import {
  createS3SnapshotObjects,
  presignWithHeaders,
} from '../../src/modules/snapshots/presign.js';
import { SnapshotService, type SnapshotServiceDeps } from '../../src/modules/snapshots/service.js';
import { snapshotRoutes } from '../../src/routes/snapshots/index.js';
import { captureLogger } from '../helpers.js';
import { scriptedAccess } from '../history/helpers.js';
import { memoryTokens } from '../modules/auth/tokens/helpers.js';

/** The fake store's address and credentials. */
export const STORE: ObjectStoreConfig = {
  endpoint: 'https://objects.test',
  region: 'us-east-1',
  bucket: 'centcom-test',
  accessKeyId: new Secret('AKTESTSNAPSHOTS'),
  secretAccessKey: new Secret('test-secret-for-snapshot-urls'),
};

/** Random bytes standing in for client ciphertext, and their `sha256:<hex>`. */
export function ciphertext(size: number): { bytes: Uint8Array; sha256: string } {
  const bytes = new Uint8Array(randomBytes(size));
  return { bytes, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
}

/** `SnapshotRows` in memory, with the repository's rules. */
export function memoryRows(): SnapshotRows & {
  rows: Map<string, SnapshotRow>;
  fail: { remove: boolean; insert: boolean };
} {
  const rows = new Map<string, SnapshotRow>();
  const fail = { remove: false, insert: false };
  const trx = { isTransaction: true, executeQuery: () => Promise.reject(new Error('fake trx')) };
  const of = (sid: string) => [...rows.values()].filter((r) => r.sessionId === sid);
  const newestFirst = (a: SnapshotRow, b: SnapshotRow): number =>
    (b.seq ?? 0) - (a.seq ?? 0) ||
    (b.committedAt?.getTime() ?? 0) - (a.committedAt?.getTime() ?? 0);
  const copy = (r: SnapshotRow): SnapshotRow => ({ ...r });
  return {
    rows,
    fail,
    async insertPending(row, maxPending, pendingSince, audit) {
      if (fail.insert) throw Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
      const pending = of(row.sessionId).filter(
        (r) => r.state === 'pending' && r.createdAt >= pendingSince,
      );
      if (pending.length >= maxPending) {
        const oldest = pending.map((r) => r.createdAt).sort((a, b) => a.getTime() - b.getTime());
        return oldest[0] ?? pendingSince;
      }
      rows.set(row.snp, {
        ...row,
        state: 'pending',
        seq: null,
        sha256: null,
        committedAt: null,
      });
      await audit(trx);
      return true;
    },
    get(sid, snp) {
      const r = rows.get(snp);
      return Promise.resolve(r === undefined || r.sessionId !== sid ? null : copy(r));
    },
    async commit(sid, snp, fields, audit) {
      const r = rows.get(snp);
      if (r === undefined || r.sessionId !== sid || r.state !== 'pending') return null;
      const next: SnapshotRow = { ...r, state: 'committed', ...fields };
      await audit(trx);
      rows.set(snp, next);
      return copy(next);
    },
    latest(sid) {
      const r = of(sid)
        .filter((x) => x.state === 'committed')
        .sort(newestFirst)[0];
      return Promise.resolve(r === undefined ? null : copy(r));
    },
    beyondNewest(sid, keep) {
      const committed = of(sid).filter((x) => x.state === 'committed');
      const top = [...committed].sort(newestFirst)[0];
      if (top === undefined) return Promise.resolve([]);
      return Promise.resolve(
        committed
          .filter((x) => x.snp !== top.snp)
          .sort(
            (a, b) =>
              (b.committedAt?.getTime() ?? 0) - (a.committedAt?.getTime() ?? 0) ||
              (b.snp < a.snp ? -1 : 1),
          )
          .slice(Math.max(keep - 1, 0))
          .map(copy),
      );
    },
    expiredPending(before, limit, sid) {
      return Promise.resolve(
        [...rows.values()]
          .filter(
            (r) =>
              r.state === 'pending' &&
              r.createdAt < before &&
              (sid === undefined || r.sessionId === sid),
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit)
          .map(copy),
      );
    },
    deleting(limit, sid) {
      return Promise.resolve(
        [...rows.values()]
          .filter((r) => r.state === 'deleting' && (sid === undefined || r.sessionId === sid))
          .slice(0, limit)
          .map(copy),
      );
    },
    allOf(sid) {
      return Promise.resolve(of(sid).map(copy));
    },
    markDeleting(snps, fromState) {
      const marked: string[] = [];
      for (const snp of snps) {
        const r = rows.get(snp);
        if (r?.state === fromState) {
          rows.set(snp, { ...r, state: 'deleting' });
          marked.push(snp);
        }
      }
      return Promise.resolve(marked);
    },
    restorePending(snps) {
      for (const snp of snps) {
        const r = rows.get(snp);
        if (r?.state === 'deleting' && r.committedAt === null)
          rows.set(snp, { ...r, state: 'pending' });
      }
      return Promise.resolve();
    },
    remove(snps) {
      if (fail.remove) return Promise.reject(new Error('database down'));
      for (const snp of snps) rows.delete(snp);
      return Promise.resolve();
    },
  };
}

/** What the fake store answered to a request through a pre-signed URL. */
export interface StoreAnswer {
  status: number;
  body?: Uint8Array;
}

/**
 * Snapshot objects over a memory BlobStore, with the real pre-signed URLs, and the store's side:
 * `upload(url, bytes, at)` and `download(url, at)` check a URL as S3 does (signature over the
 * method, key and signed headers, expiry), then act on the object.
 */
export function memoryObjects() {
  const blobs = createMemoryBlobStore();
  const signer = createS3SnapshotObjects(STORE, { blobs });
  const failures = { read: false };
  const reads: string[] = [];
  const keyOf = (url: URL): string => {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== STORE.bucket) throw new Error('not this bucket');
    return parts.slice(1).join('/');
  };

  /** S3's check of a pre-signed request: 403 unless the signature and the clock agree. */
  function authorise(
    method: 'GET' | 'PUT',
    raw: string,
    headers: Record<string, string>,
    at: Date,
  ): { ok: true; key: string } | { ok: false; status: number } {
    const url = new URL(raw);
    const q = url.searchParams;
    const date = q.get('X-Amz-Date') ?? '';
    const expires = Number(q.get('X-Amz-Expires'));
    const signedAt = new Date(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
    );
    if (at.getTime() > signedAt.getTime() + expires * 1000) return { ok: false, status: 403 };
    const signedNames = (q.get('X-Amz-SignedHeaders') ?? '').split(';').filter((n) => n !== 'host');
    const signedHeaders: Record<string, string> = {};
    for (const name of signedNames) signedHeaders[name] = headers[name] ?? '';
    const expected = presignWithHeaders(
      {
        method,
        host: url.host,
        segments: url.pathname.split('/').filter(Boolean).map(decodeURIComponent),
        headers: signedHeaders,
      },
      {
        accessKeyId: STORE.accessKeyId.reveal(),
        secretAccessKey: STORE.secretAccessKey.reveal(),
        region: STORE.region,
        service: 's3',
      },
      signedAt,
      expires,
    );
    const sig = new URLSearchParams(expected).get('X-Amz-Signature');
    if (sig === null || sig !== q.get('X-Amz-Signature')) return { ok: false, status: 403 };
    return { ok: true, key: keyOf(url) };
  }

  const objects: SnapshotObjects = {
    presignPut: (key, n, ttl, now) => signer.presignPut(key, n, ttl, now),
    presignGet: (key, ttl, now) => signer.presignGet(key, ttl, now),
    delete: (keys) => blobs.delete(keys),
    list: (prefix) => blobs.list(prefix),
    async *read(key) {
      reads.push(key);
      if (failures.read) throw new BlobStoreError('GET failed');
      const body = blobs.objects.get(key);
      if (body === undefined) throw new BlobNotFoundError('snapshot object not found');
      for (let at = 0; at < body.length; at += HASH_CHUNK_BYTES) {
        await Promise.resolve();
        yield body.subarray(at, at + HASH_CHUNK_BYTES);
      }
    },
  };

  return {
    blobs,
    objects,
    failures,
    reads,
    /** A PUT of `bytes` through `url` at `at`, sending its true Content-Length. */
    upload(url: string, bytes: Uint8Array, at: Date): StoreAnswer {
      const auth = authorise('PUT', url, { 'content-length': String(bytes.length) }, at);
      if (!auth.ok) return { status: auth.status };
      blobs.objects.set(auth.key, new Uint8Array(bytes));
      return { status: 200 };
    },
    /** A GET through `url` at `at`. */
    download(url: string, at: Date): StoreAnswer {
      const auth = authorise('GET', url, {}, at);
      if (!auth.ok) return { status: auth.status };
      const body = blobs.objects.get(auth.key);
      return body === undefined ? { status: 404 } : { status: 200, body };
    },
  };
}

/** A recording audit sink with `emit`. */
export function auditRecorder() {
  const events: AuditEvent<string>[] = [];
  return {
    events,
    emit(_trx: unknown, event: AuditEvent<string>) {
      events.push(event);
      return Promise.resolve(newId('aud'));
    },
  };
}

/** A service over memory rows and objects, a scripted access and a fake clock. */
export function snapshotEnv(overrides: Partial<SnapshotServiceDeps> = {}) {
  const clock = { now: Date.parse('2026-10-10T12:00:00.000Z') };
  const rows = memoryRows();
  const store = memoryObjects();
  const access = scriptedAccess();
  const audit = auditRecorder();
  const captured = captureLogger();
  const service = new SnapshotService({
    rows,
    objects: store.objects,
    access: access.access,
    audit,
    clock: () => clock.now,
    logger: captured.logger,
    ...overrides,
  });
  const sid = newId('ses');
  const host = newId('usr');
  const editor = newId('usr');
  const viewer = newId('usr');
  const outsider = newId('usr');
  access.set(sid, host, { role: 'host' });
  access.set(sid, editor, { role: 'editor' });
  access.set(sid, viewer, { role: 'viewer' });
  access.set(sid, outsider, {});
  /** Begins, uploads and commits `size` random bytes at `seq` as the host. */
  const snapshot = async (seq: number, size = 1024) => {
    const data = ciphertext(size);
    const grant = await service.begin(sid, { userId: host }, { size, kid: 'k1' });
    expect(store.upload(grant.uploadUrl, data.bytes, new Date(clock.now)).status).toBe(200);
    const descriptor = await service.commit(
      sid,
      grant.snp,
      { seq, sha256: data.sha256, size, kid: 'k1' },
      { userId: host },
    );
    return { grant, data, descriptor };
  };
  return {
    clock,
    rows,
    store,
    access,
    audit,
    captured,
    service,
    sid,
    host,
    editor,
    viewer,
    outsider,
    snapshot,
  };
}

/** The snapshot API over a service like `snapshotEnv`'s, with the in-memory token service. */
export async function snapshotApp(env = snapshotEnv()) {
  const { tokens, store: refresh } = memoryTokens();
  tokens.registerPrincipalResolver('cen_', () =>
    Promise.resolve({
      kind: 'api_key',
      userId: null,
      deviceId: null,
      workspaceId: newId('wsp'),
      scopes: ['sessions:read', 'sessions:host'],
    }),
  );
  const redis = createMemoryRedis(() => env.clock.now);
  const app: FastifyInstance = fastify({
    logger: false,
    frameworkErrors: frameworkErrorHandler({ logger: env.captured.logger }),
  });
  await app.register(requestContextPlugin, { logger: env.captured.logger });
  await app.register(errorHandlerPlugin, { logger: env.captured.logger });
  await app.register(authPlugin, { tokens });
  await app.register(idempotencyPlugin, {
    kv: redis.kv,
    clock: () => env.clock.now,
    encryptionKey: new Secret(new Uint8Array(randomBytes(32))),
    principal: (request) => request.principal?.userId ?? request.principal?.keyId ?? null,
  });
  await app.register(snapshotRoutes, { service: env.service });
  await app.ready();
  /** A bearer header for `userId` with `scopes`. */
  const bearerOf = async (
    userId: string,
    scopes: string[] = ['sessions:read', 'sessions:host'],
  ): Promise<Record<string, string>> => {
    const deviceId = newId('dev');
    refresh.devices.set(deviceId, { userId, revoked: false });
    const t = await tokens.issueTokens({ userId, deviceId, scopes });
    return { authorization: `Bearer ${t.access_token}` };
  };
  return { ...env, app, bearerOf };
}
