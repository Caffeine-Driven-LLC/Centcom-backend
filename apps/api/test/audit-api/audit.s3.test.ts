/**
 * The S3 object store client (B082) against an S3-compatible server that checks every signature:
 * uploads are streamed from disk and signed over their SHA-256, deletes tolerate a missing key, and
 * a download URL only GETs its own object, only until its lifetime (at most 900 s) is up. Failures
 * are ObjectStoreErrors that name the operation and status, never a credential.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Secret } from '@centcom/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createS3ObjectStore,
  ObjectStoreError,
  type LocalFile,
} from '../../src/modules/audit-api/object-store.js';
import { startFakeS3, type FakeS3 } from './fake-s3.js';
import { T0 } from './helpers.js';

const BUCKET = 'exports';
const accessKeyId = `test${randomBytes(4).toString('hex')}`;
const secretAccessKey = randomBytes(16).toString('hex');

let s3: FakeS3;
let dir: string;

beforeAll(async () => {
  s3 = await startFakeS3({ accessKeyId, secretAccessKey, region: 'us-east-1' }, BUCKET, T0);
  dir = await mkdtemp(join(tmpdir(), 'audit-s3-test-'));
});
afterAll(async () => {
  await s3.close();
  await rm(dir, { recursive: true, force: true });
});

const store = (secret = secretAccessKey, endpoint = s3.endpoint) =>
  createS3ObjectStore(
    {
      endpoint,
      region: 'us-east-1',
      bucket: BUCKET,
      accessKeyId: new Secret(accessKeyId),
      secretAccessKey: new Secret(secret),
    },
    { clock: () => s3.clock.now },
  );

async function localFile(
  body: Buffer,
  contentType = 'text/csv; charset=utf-8',
): Promise<LocalFile> {
  const path = join(dir, randomBytes(4).toString('hex'));
  await writeFile(path, body);
  return {
    path,
    size: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    contentType,
  };
}

describe('S3 object store', () => {
  it('uploads a file whole, signed over its digest, and deletes it', async () => {
    const body = Buffer.concat([Buffer.from('id,at\r\n'), randomBytes(256 * 1024)]);
    const key = 'audit-exports/wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W/exp_01JA3Z8K2M5N7P9Q0R1S2T3V4W.csv';
    await store().putFile(key, await localFile(body));
    expect(s3.objects.get(key)?.body.equals(body)).toBe(true);
    expect(s3.objects.get(key)?.contentType).toBe('text/csv; charset=utf-8');
    expect(s3.log.at(-1)).toMatchObject({ method: 'PUT', path: `/${BUCKET}/${key}`, status: 200 });

    await store().delete(key);
    expect(s3.objects.has(key)).toBe(false);
    // A key that is not there is fine.
    await store().delete(key);
    expect(s3.log.at(-1)).toMatchObject({ method: 'DELETE', status: 204 });
  });

  it('refuses with an ObjectStoreError that names no secret', async () => {
    const wrong = 'not-the-secret-value';
    const err = await store(wrong)
      .putFile('a.csv', await localFile(Buffer.from('x')))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect(String((err as Error).message)).toBe('PUT answered 403');
    expect(JSON.stringify(err)).not.toContain(wrong);
    expect(String((err as Error).stack)).not.toContain(secretAccessKey);
    await expect(store(wrong).delete('a.csv')).rejects.toBeInstanceOf(ObjectStoreError);

    // Unreachable: nothing listens on the port any more.
    const gone = await startFakeS3({ accessKeyId, secretAccessKey, region: 'us-east-1' }, BUCKET);
    const endpoint = gone.endpoint;
    await gone.close();
    await expect(
      store(secretAccessKey, endpoint).putFile('a.csv', await localFile(Buffer.from('x'))),
    ).rejects.toBeInstanceOf(ObjectStoreError);
  });

  it('signs download URLs that only GET, and only for their lifetime', async () => {
    const body = Buffer.from('id,at\r\naud_1,2026\r\n');
    const key = 'audit-exports/wsp_x/exp_y.csv';
    await store().putFile(key, await localFile(body));
    const url = store().presignGet(key, 900, new Date(s3.clock.now), {
      filename: 'audit-exp_y.csv',
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(`/${BUCKET}/${key}`);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url).not.toContain(secretAccessKey);

    const got = await fetch(url);
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer()).equals(body)).toBe(true);
    expect(got.headers.get('content-disposition')).toBe('attachment; filename="audit-exp_y.csv"');

    // Not for writing, deleting, or another object.
    expect((await fetch(url, { method: 'PUT', body: 'x' })).status).toBe(403);
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(403);
    expect((await fetch(url.replace('exp_y.csv', 'exp_z.csv'))).status).toBe(403);
    expect(s3.objects.get(key)?.body.equals(body)).toBe(true);

    // Still good at 900 s, gone after.
    s3.clock.now += 900_000;
    expect((await fetch(url)).status).toBe(200);
    s3.clock.now += 1_000;
    expect((await fetch(url)).status).toBe(403);
  });
});
