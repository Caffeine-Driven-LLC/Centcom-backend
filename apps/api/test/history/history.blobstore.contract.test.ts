/**
 * The BlobStore contract (B055; tests "history.blobstore.contract.test.ts"): one suite run against
 * the in-memory store always, and against the S3 store on a MinIO container (B010's testkit) where
 * a container runtime is reachable:
 *
 * - put then get returns the bytes unchanged (binary included); a put to the same key replaces it;
 * - get of a missing key is BlobNotFoundError;
 * - delete is idempotent; list returns the keys under a prefix, sorted, and nothing else;
 * - list pages through more than one page of keys (S3).
 */
import { randomBytes } from 'node:crypto';
import { Secret } from '@centcom/core';
import { startMinio, testcontainersRuntime, type TestMinio } from '@centcom/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorizationHeader, amzDate, canonicalPath, EMPTY_SHA256 } from '@centcom/storage';
import {
  BlobNotFoundError,
  createMemoryBlobStore,
  createS3BlobStore,
  historyBlobKey,
  historyPrefix,
  type BlobStore,
} from '../../src/modules/history/index.js';
import { newId } from './helpers.js';

function contract(name: string, make: () => BlobStore) {
  describe(`BlobStore contract: ${name}`, () => {
    it('round-trips bytes, replaces on put, and reports a missing key', async () => {
      const store = make();
      const sid = newId('ses');
      const key = historyBlobKey(sid, 1, 2);
      const body = new Uint8Array(randomBytes(4096));
      await store.put(key, body);
      expect(Buffer.from(await store.get(key)).equals(Buffer.from(body))).toBe(true);
      const next = new TextEncoder().encode('{"seq":1}\n');
      await store.put(key, next);
      expect(new TextDecoder().decode(await store.get(key))).toBe('{"seq":1}\n');
      await expect(store.get(historyBlobKey(sid, 3, 4))).rejects.toBeInstanceOf(BlobNotFoundError);
    });

    it('lists keys under a prefix, sorted, and deletes idempotently', async () => {
      const store = make();
      const sid = newId('ses');
      const other = newId('ses');
      const keys = [
        historyBlobKey(sid, 11, 20),
        historyBlobKey(sid, 1, 10),
        historyBlobKey(sid, 21, 21),
      ];
      for (const key of keys) await store.put(key, new Uint8Array([1]));
      await store.put(historyBlobKey(other, 1, 1), new Uint8Array([2]));
      expect(await store.list(historyPrefix(sid))).toEqual([...keys].sort());
      await store.delete([keys[0] as string, historyBlobKey(sid, 99, 99)]);
      await store.delete([keys[0] as string]);
      expect(await store.list(historyPrefix(sid))).toEqual([keys[1], keys[2]].sort());
      expect(await store.list(historyPrefix(other))).toHaveLength(1);
    });
  });
}

contract('memory', () => createMemoryBlobStore());

const runtime = await testcontainersRuntime.check().then(
  () => true,
  () => false,
);

describe.runIf(runtime)('BlobStore contract: S3 (MinIO)', () => {
  let minio: TestMinio;
  let store: BlobStore;
  const bucket = 'history-test';

  beforeAll(async () => {
    minio = await startMinio();
    const endpoint = new URL(minio.endpoint);
    const now = new Date();
    const segments = [bucket];
    const headers = { 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': amzDate(now) };
    const authorization = authorizationHeader(
      { method: 'PUT', host: endpoint.host, segments, headers },
      {
        accessKeyId: minio.accessKeyId,
        secretAccessKey: minio.secretAccessKey,
        region: minio.region,
        service: 's3',
      },
      now,
      EMPTY_SHA256,
    );
    const res = await fetch(`${minio.endpoint}${canonicalPath(segments)}`, {
      method: 'PUT',
      headers: { ...headers, authorization },
    });
    expect(res.status).toBe(200);
    store = createS3BlobStore({
      endpoint: minio.endpoint,
      region: minio.region,
      bucket,
      accessKeyId: new Secret(minio.accessKeyId),
      secretAccessKey: new Secret(minio.secretAccessKey),
    });
  }, 180_000);
  afterAll(async () => {
    await minio?.stop();
  });

  contract('S3 (MinIO)', () => store);

  it('pages through more than one page of keys', async () => {
    const sid = newId('ses');
    const keys = Array.from({ length: 1005 }, (_, i) => historyBlobKey(sid, i + 1, i + 1));
    await Promise.all(keys.map((key) => store.put(key, new Uint8Array([0]))));
    expect(await store.list(historyPrefix(sid))).toEqual([...keys].sort());
    await store.delete(keys.slice(0, 5));
    expect(await store.list(historyPrefix(sid))).toHaveLength(1000);
  }, 120_000);
});
