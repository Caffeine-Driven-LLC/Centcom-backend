/**
 * B056 S3 snapshot objects (`presign.ts`): the SigV4 query signature (AWS's published example),
 * the PUT bound to its content-length, the streamed read (chunks of at most 64 KiB, 404, errors,
 * idle timeout) against a local HTTP server, and, where Docker runs, a real S3 (MinIO) refusing an
 * upload of another size and serving the object through the pre-signed GET.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { newId } from '@centcom/contracts';
import { Secret } from '@centcom/core';
import {
  amzDate,
  authorizationHeader,
  BlobNotFoundError,
  BlobStoreError,
  canonicalPath,
  createMemoryBlobStore,
  EMPTY_SHA256,
  presignQuery,
  type ObjectStoreConfig,
} from '@centcom/storage';
import { startMinio, testcontainersRuntime, type TestMinio } from '@centcom/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HASH_CHUNK_BYTES, snapshotKey } from '../../src/modules/snapshots/ports.js';
import {
  createS3SnapshotObjects,
  presignWithHeaders,
} from '../../src/modules/snapshots/presign.js';

// AWS's published example credentials, assembled at run time (as B082's tests do).
const EXAMPLE = {
  accessKeyId: ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join(''),
  secretAccessKey: ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/'),
  region: 'us-east-1',
  service: 's3',
};

describe('presignWithHeaders', () => {
  it("matches AWS's published pre-signed GET example", () => {
    const query = presignWithHeaders(
      { method: 'GET', host: 'examplebucket.s3.amazonaws.com', segments: ['test.txt'] },
      EXAMPLE,
      new Date('2013-05-24T00:00:00Z'),
      86400,
    );
    expect(new URLSearchParams(query).get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it("equals B082's presignQuery when only host is signed", () => {
    const request = {
      method: 'GET' as const,
      host: 'h.test:9000',
      segments: ['b', 'snapshots', 'x.bin'],
    };
    const now = new Date('2026-10-10T10:00:00Z');
    expect(presignWithHeaders(request, EXAMPLE, now, 300)).toBe(
      presignQuery(request, EXAMPLE, now, 300),
    );
  });

  it('signs content-length: another length gives another signature', () => {
    const at = new Date('2026-10-10T10:00:00Z');
    const sig = (n: number) =>
      new URLSearchParams(
        presignWithHeaders(
          {
            method: 'PUT',
            host: 'h.test',
            segments: ['k'],
            headers: { 'content-length': String(n) },
          },
          EXAMPLE,
          at,
          600,
        ),
      ).get('X-Amz-Signature');
    expect(sig(10)).not.toBe(sig(11));
  });
});

/** A local server answering GETs with `handler`. */
async function server(handler: Parameters<typeof createServer>[1]): Promise<{
  config: ObjectStoreConfig;
  close: () => Promise<void>;
}> {
  const srv: Server = createServer(handler);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as AddressInfo;
  return {
    config: {
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      bucket: 'b',
      accessKeyId: new Secret('AK'),
      secretAccessKey: new Secret('SK'),
    },
    close: () =>
      new Promise<void>((resolve) => {
        srv.closeAllConnections();
        srv.close(() => resolve());
      }),
  };
}

describe('read', () => {
  it('streams in chunks of at most 64 KiB, the whole object', async () => {
    const body = Buffer.alloc(1_000_000, 7);
    const s = await server((_req, res) => {
      res.writeHead(200, { 'content-length': body.length });
      res.end(body);
    });
    try {
      const objects = createS3SnapshotObjects(s.config, { blobs: createMemoryBlobStore() });
      const hash = createHash('sha256');
      let total = 0;
      let largest = 0;
      for await (const chunk of objects.read('snapshots/x.bin')) {
        total += chunk.byteLength;
        largest = Math.max(largest, chunk.byteLength);
        hash.update(chunk);
      }
      expect(total).toBe(body.length);
      expect(largest).toBeLessThanOrEqual(HASH_CHUNK_BYTES);
      expect(hash.digest('hex')).toBe(createHash('sha256').update(body).digest('hex'));
    } finally {
      await s.close();
    }
  });

  it('404 is BlobNotFoundError, 500 a BlobStoreError naming only the status', async () => {
    let status = 404;
    const s = await server((_req, res) => {
      res.writeHead(status);
      res.end('<Error>secret detail</Error>');
    });
    try {
      const objects = createS3SnapshotObjects(s.config, { blobs: createMemoryBlobStore() });
      const drain = async () => {
        for await (const chunk of objects.read('k')) void chunk;
      };
      await expect(drain()).rejects.toBeInstanceOf(BlobNotFoundError);
      status = 500;
      const err: unknown = await drain().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BlobStoreError);
      expect((err as Error).message).toBe('GET answered 500');
    } finally {
      await s.close();
    }
  });

  it('an idle server or a refused connection is a BlobStoreError', async () => {
    const s = await server((_req, res) => {
      res.writeHead(200, { 'content-length': 10 });
      res.write('12345');
    });
    try {
      const objects = createS3SnapshotObjects(s.config, {
        blobs: createMemoryBlobStore(),
        idleTimeoutMs: 200,
      });
      const drain = async () => {
        for await (const chunk of objects.read('k')) void chunk;
      };
      await expect(drain()).rejects.toBeInstanceOf(BlobStoreError);
    } finally {
      await s.close();
    }
    const gone = createS3SnapshotObjects(
      { ...s.config, endpoint: 'http://127.0.0.1:1' },
      { blobs: createMemoryBlobStore() },
    );
    const drainGone = async () => {
      for await (const chunk of gone.read('k')) void chunk;
    };
    await expect(drainGone()).rejects.toBeInstanceOf(BlobStoreError);
  });
});

const runtime = await testcontainersRuntime.check().then(
  () => true,
  () => false,
);

describe.runIf(runtime)('snapshot objects on S3 (MinIO)', () => {
  let minio: TestMinio;
  const bucket = 'snapshots-test';
  let config: ObjectStoreConfig;

  beforeAll(async () => {
    minio = await startMinio();
    const endpoint = new URL(minio.endpoint);
    const now = new Date();
    const headers = { 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': amzDate(now) };
    const authorization = authorizationHeader(
      { method: 'PUT', host: endpoint.host, segments: [bucket], headers },
      {
        accessKeyId: minio.accessKeyId,
        secretAccessKey: minio.secretAccessKey,
        region: minio.region,
        service: 's3',
      },
      now,
      EMPTY_SHA256,
    );
    const res = await fetch(`${minio.endpoint}${canonicalPath([bucket])}`, {
      method: 'PUT',
      headers: { ...headers, authorization },
    });
    expect(res.status).toBe(200);
    config = {
      endpoint: minio.endpoint,
      region: minio.region,
      bucket,
      accessKeyId: new Secret(minio.accessKeyId),
      secretAccessKey: new Secret(minio.secretAccessKey),
    };
  }, 180_000);
  afterAll(async () => {
    await minio?.stop();
  });

  it('refuses an upload of another size; takes the declared one; serves it by GET', async () => {
    const objects = createS3SnapshotObjects(config);
    const key = snapshotKey(newId('ses'), newId('snp'));
    const bytes = new Uint8Array(4096).fill(9);
    const url = objects.presignPut(key, bytes.length, 600, new Date());
    const tooBig = await fetch(url, { method: 'PUT', body: new Uint8Array(bytes.length + 1) });
    expect(tooBig.status).toBe(403);
    const tooSmall = await fetch(url, { method: 'PUT', body: bytes.subarray(1) });
    expect(tooSmall.status).toBe(403);
    expect(await objects.list(key)).toEqual([]);
    const ok = await fetch(url, { method: 'PUT', body: bytes });
    expect(ok.status).toBe(200);

    const hash = createHash('sha256');
    for await (const chunk of objects.read(key)) hash.update(chunk);
    expect(hash.digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    const got = await fetch(objects.presignGet(key, 300, new Date()));
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);

    await objects.delete([key]);
    const missing = async () => {
      for await (const chunk of objects.read(key)) void chunk;
    };
    await expect(missing()).rejects.toBeInstanceOf(BlobNotFoundError);
  }, 60_000);
});
