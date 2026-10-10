/**
 * B056 begin and commit: the pre-signed PUT's policy (acceptance 1), the size and hash checks
 * (acceptance 1, 2), the happy path and the pre-signed GET (acceptance 3), and the failure modes
 * (store unreachable during verification, begin storms over the pending cap).
 */
import { AppError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  DOWNLOAD_TTL_S,
  PENDING_TTL_MS,
  SNAPSHOT_MAX_BYTES,
  snapshotKey,
  UPLOAD_TTL_S,
} from '../../src/modules/snapshots/ports.js';
import { ciphertext, snapshotApp, snapshotEnv } from './helpers.js';

/** The AppError `work` rejects with. */
async function refusal(work: Promise<unknown>): Promise<AppError> {
  const err: unknown = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

describe('begin (acceptance 1)', () => {
  it('returns a PUT URL bound to the exact size (<= 32 MiB), the key, and 600 s', async () => {
    const env = snapshotEnv();
    const grant = await env.service.begin(
      env.sid,
      { userId: env.host },
      { size: SNAPSHOT_MAX_BYTES, kid: 'k1' },
    );
    expect(grant.expiresIn).toBe(UPLOAD_TTL_S);
    expect(UPLOAD_TTL_S).toBe(600);
    const url = new URL(grant.uploadUrl);
    expect(url.pathname).toBe(`/centcom-test/${snapshotKey(env.sid, grant.snp)}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host');
    expect(grant.snp).toMatch(/^snp_[0-9A-HJKMNP-TV-Z]{26}$/);

    // The store takes exactly 32 MiB and refuses 32 MiB + 1 byte.
    const at = new Date(env.clock.now);
    expect(env.store.upload(grant.uploadUrl, new Uint8Array(SNAPSHOT_MAX_BYTES + 1), at)).toEqual({
      status: 403,
    });
    expect(env.store.upload(grant.uploadUrl, new Uint8Array(SNAPSHOT_MAX_BYTES - 1), at)).toEqual({
      status: 403,
    });
    expect(env.store.upload(grant.uploadUrl, new Uint8Array(SNAPSHOT_MAX_BYTES), at)).toEqual({
      status: 200,
    });
    // ... until the URL expires.
    const late = new Date(env.clock.now + (UPLOAD_TTL_S + 1) * 1000);
    expect(env.store.upload(grant.uploadUrl, new Uint8Array(SNAPSHOT_MAX_BYTES), late)).toEqual({
      status: 403,
    });
  });

  it('refuses a declared size over 32 MiB, a negative or missing size', async () => {
    const env = snapshotEnv();
    for (const size of [SNAPSHOT_MAX_BYTES + 1, -1, 1.5]) {
      const err = await refusal(env.service.begin(env.sid, { userId: env.host }, { size }));
      expect(err.status).toBe(422);
      expect(err.errors?.[0]?.pointer).toBe('/size');
    }
    const missing = await refusal(env.service.begin(env.sid, { userId: env.host }, {}));
    expect(missing.errors?.[0]).toMatchObject({ pointer: '/size', code: 'required' });
    expect(env.rows.rows.size).toBe(0);
  });

  it('over HTTP: 201 SnapshotUpload; a body over the cap is 422', async () => {
    const env = await snapshotApp();
    const headers = await env.bearerOf(env.host);
    const ok = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${env.sid}/snapshot`,
      headers,
      payload: { size: 10, kid: 'k1' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.headers['cache-control']).toBe('private, no-store');
    const body = ok.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(['expires_in', 'snp', 'upload_url']);
    expect(body['expires_in']).toBe(600);
    const big = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${env.sid}/snapshot`,
      headers,
      payload: { size: SNAPSHOT_MAX_BYTES + 1 },
    });
    expect(big.statusCode).toBe(422);
    expect(big.json<{ errors: { pointer: string }[] }>().errors[0]?.pointer).toBe('/size');
  });

  it('caps pending uploads at 3 per session: a begin storm gets 429 with retry_after_s', async () => {
    const env = snapshotEnv();
    const started = env.clock.now;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        env.service.begin(env.sid, { userId: env.host }, { size: 10 }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const refused = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as AppError] : []));
    expect(refused).toHaveLength(7);
    for (const err of refused) {
      expect(err.code).toBe('rate_limited');
      expect(err.retryAfterS).toBe(PENDING_TTL_MS / 1000);
    }
    // The wait counts down to the oldest counted upload's 15 min.
    env.clock.now = started + 10 * 60_000;
    await expect(
      env.service.begin(env.sid, { userId: env.host }, { size: 10 }),
    ).rejects.toMatchObject({ retryAfterS: 300 });
    // A committed upload frees its place; so does the 15 min expiry.
    env.clock.now += 15 * 60_000 + 1;
    await expect(
      env.service.begin(env.sid, { userId: env.host }, { size: 10 }),
    ).resolves.toMatchObject({ expiresIn: 600 });
  });
});

describe('commit (acceptance 1, 2, 3)', () => {
  it('commits matching bytes; GET latest gives the descriptor and a 300 s GET URL', async () => {
    const env = snapshotEnv();
    const { grant, data, descriptor } = await env.snapshot(100, 4096);
    expect(descriptor).toMatchObject({
      snp: grant.snp,
      seq: 100,
      size: 4096,
      sha256: data.sha256,
      kid: 'k1',
    });
    expect(descriptor.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    const latest = await env.service.latestFor(env.sid, { userId: env.viewer });
    expect(latest.descriptor).toEqual(descriptor);
    expect(latest.expiresIn).toBe(DOWNLOAD_TTL_S);
    expect(DOWNLOAD_TTL_S).toBe(300);
    const url = new URL(latest.downloadUrl);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    const got = env.store.download(latest.downloadUrl, new Date(env.clock.now));
    expect(got.status).toBe(200);
    expect(Buffer.from(got.body ?? []).equals(Buffer.from(data.bytes))).toBe(true);
    const late = new Date(env.clock.now + (DOWNLOAD_TTL_S + 1) * 1000);
    expect(env.store.download(latest.downloadUrl, late).status).toBe(403);
  });

  it('a commit with size > 32 MiB is 422', async () => {
    const env = snapshotEnv();
    const grant = await env.service.begin(env.sid, { userId: env.host }, { size: 10 });
    const err = await refusal(
      env.service.commit(
        env.sid,
        grant.snp,
        { seq: 1, sha256: ciphertext(1).sha256, size: SNAPSHOT_MAX_BYTES + 1, kid: 'k1' },
        { userId: env.host },
      ),
    );
    expect(err.status).toBe(422);
    expect(err.errors?.[0]?.pointer).toBe('/size');
  });

  it('a hash mismatch is 409 snapshot_hash_mismatch at /sha256: pending, object deleted', async () => {
    const env = snapshotEnv();
    const data = ciphertext(2048);
    const grant = await env.service.begin(env.sid, { userId: env.host }, { size: 2048 });
    env.store.upload(grant.uploadUrl, data.bytes, new Date(env.clock.now));
    const key = snapshotKey(env.sid, grant.snp);
    expect(env.store.blobs.objects.has(key)).toBe(true);
    const err = await refusal(
      env.service.commit(
        env.sid,
        grant.snp,
        { seq: 5, sha256: ciphertext(1).sha256, size: 2048, kid: 'k1' },
        { userId: env.host },
      ),
    );
    // CT-ERR (errors.json) registers snapshot_hash_mismatch as 409; contracts win over the
    // card's "422 validation-class" (GUIDELINES §2.2). The field error is the card's.
    expect(err.status).toBe(409);
    expect(err.code).toBe('snapshot_hash_mismatch');
    expect(err.errors?.[0]).toMatchObject({ pointer: '/sha256', code: 'snapshot_hash_mismatch' });
    expect(env.rows.rows.get(grant.snp)?.state).toBe('pending');
    expect(env.store.blobs.objects.has(key)).toBe(false);
    expect(await env.service.latest(env.sid)).toBeNull();
  });

  it('a concurrent commit cannot commit the row while a refused commit deletes its object', async () => {
    const env = snapshotEnv();
    const good = ciphertext(64);
    const grant = await env.service.begin(env.sid, { userId: env.host }, { size: 64 });
    env.store.upload(grant.uploadUrl, good.bytes, new Date(env.clock.now));
    let raced: unknown = 'not run';
    const del = env.store.objects.delete.bind(env.store.objects);
    env.store.objects.delete = async (keys) => {
      // Commit B, already verified, reaches its UPDATE while A's discard is under way.
      raced = await env.rows.commit(
        env.sid,
        grant.snp,
        { seq: 9, sha256: good.sha256, kid: 'k1', committedAt: new Date(env.clock.now) },
        () => Promise.resolve(),
      );
      await del(keys);
    };
    await expect(
      env.service.commit(
        env.sid,
        grant.snp,
        { seq: 9, sha256: ciphertext(1).sha256, size: 64, kid: 'k1' },
        { userId: env.host },
      ),
    ).rejects.toMatchObject({ code: 'snapshot_hash_mismatch' });
    expect(raced).toBeNull();
    expect(env.rows.rows.get(grant.snp)?.state).toBe('pending');
    expect(await env.service.latest(env.sid)).toBeNull();
  });

  it('an object of another size than declared is 422 at /size and is deleted', async () => {
    const env = snapshotEnv();
    const grant = await env.service.begin(env.sid, { userId: env.host }, { size: 100 });
    const key = snapshotKey(env.sid, grant.snp);
    for (const n of [99, 101]) {
      const data = ciphertext(n);
      env.store.blobs.objects.set(key, data.bytes);
      const err = await refusal(
        env.service.commit(
          env.sid,
          grant.snp,
          { seq: 5, sha256: data.sha256, size: 100, kid: 'k1' },
          { userId: env.host },
        ),
      );
      expect(err.errors?.[0]).toMatchObject({ pointer: '/size', code: 'size_mismatch' });
      expect(env.store.blobs.objects.has(key)).toBe(false);
    }
    // A body whose size differs from begin's: 422 before reading anything.
    const reads = env.store.reads.length;
    const err = await refusal(
      env.service.commit(
        env.sid,
        grant.snp,
        { seq: 5, sha256: ciphertext(1).sha256, size: 99, kid: 'k1' },
        { userId: env.host },
      ),
    );
    expect(err.errors?.[0]).toMatchObject({ pointer: '/size', code: 'size_mismatch' });
    expect(env.store.reads).toHaveLength(reads);
  });

  it('no uploaded object: 404 snapshot_missing, the row stays pending; unknown snp too', async () => {
    const env = snapshotEnv();
    const data = ciphertext(10);
    const grant = await env.service.begin(env.sid, { userId: env.host }, { size: 10 });
    const body = { seq: 1, sha256: data.sha256, size: 10, kid: 'k1' };
    const err = await refusal(env.service.commit(env.sid, grant.snp, body, { userId: env.host }));
    expect(err.code).toBe('snapshot_missing');
    expect(err.status).toBe(404);
    expect(env.rows.rows.get(grant.snp)?.state).toBe('pending');
    const other = await refusal(
      env.service.commit(env.sid, `snp_${'0'.repeat(26)}`, body, { userId: env.host }),
    );
    expect(other.code).toBe('snapshot_missing');
    // Retrying after the upload arrives commits it.
    env.store.upload(grant.uploadUrl, data.bytes, new Date(env.clock.now));
    await expect(
      env.service.commit(env.sid, grant.snp, body, { userId: env.host }),
    ).resolves.toMatchObject({ seq: 1 });
  });

  it('store unreachable during verification: 503 with retry_after_s, pending, retry works', async () => {
    const env = snapshotEnv();
    const data = ciphertext(10);
    const grant = await env.service.begin(env.sid, { userId: env.host }, { size: 10 });
    env.store.upload(grant.uploadUrl, data.bytes, new Date(env.clock.now));
    env.store.failures.read = true;
    const body = { seq: 1, sha256: data.sha256, size: 10, kid: 'k1' };
    const err = await refusal(env.service.commit(env.sid, grant.snp, body, { userId: env.host }));
    expect(err.status).toBe(503);
    expect(err.retryAfterS).toBeGreaterThanOrEqual(1);
    expect(env.rows.rows.get(grant.snp)?.state).toBe('pending');
    env.store.failures.read = false;
    await expect(
      env.service.commit(env.sid, grant.snp, body, { userId: env.host }),
    ).resolves.toMatchObject({ seq: 1 });
  });

  it('the database unreachable at begin: 503', async () => {
    const env = snapshotEnv();
    env.rows.fail.insert = true;
    const err = await refusal(env.service.begin(env.sid, { userId: env.host }, { size: 1 }));
    expect(err.status).toBe(503);
  });

  it('a repeated commit with the same values answers the same descriptor; other values 422', async () => {
    const env = snapshotEnv();
    const { grant, data, descriptor } = await env.snapshot(7, 64);
    const body = { seq: 7, sha256: data.sha256, size: 64, kid: 'k1' };
    await expect(
      env.service.commit(env.sid, grant.snp, body, { userId: env.host }),
    ).resolves.toEqual(descriptor);
    const err = await refusal(
      env.service.commit(env.sid, grant.snp, { ...body, seq: 8 }, { userId: env.host }),
    );
    expect(err.errors?.[0]).toMatchObject({ pointer: '/seq', code: 'already_committed' });
  });

  it('over HTTP: 200 SnapshotDescriptor; a malformed hash is 422 before any read', async () => {
    const env = await snapshotApp();
    const headers = await env.bearerOf(env.host);
    const data = ciphertext(32);
    const begun = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${env.sid}/snapshot`,
      headers,
      payload: { size: 32 },
    });
    const { snp, upload_url: uploadUrl } = begun.json<{ snp: string; upload_url: string }>();
    env.store.upload(uploadUrl, data.bytes, new Date(env.clock.now));
    const bad = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${env.sid}/snapshot/${snp}/commit`,
      headers,
      payload: { seq: 3, sha256: 'md5:abc', size: 32, kid: 'k1' },
    });
    expect(bad.statusCode).toBe(422);
    expect(env.store.reads).toHaveLength(0);
    const res = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${env.sid}/snapshot/${snp}/commit`,
      headers,
      payload: { seq: 3, sha256: data.sha256, size: 32, kid: 'k1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const descriptor = res.json<Record<string, unknown>>();
    expect(descriptor).toMatchObject({ snp, seq: 3, size: 32, sha256: data.sha256, kid: 'k1' });
    expect(descriptor['download_url']).toBeUndefined();
    const got = await env.app.inject({
      method: 'GET',
      url: `/v1/sessions/${env.sid}/snapshot`,
      headers,
    });
    expect(got.statusCode).toBe(200);
    expect(got.json<Record<string, unknown>>()).toMatchObject({
      snp,
      seq: 3,
      expires_in: 300,
      download_url: expect.stringMatching(/^https:\/\/objects\.test\//) as unknown,
    });
    const nope = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${env.sid}/snapshot/not-an-id/commit`,
      headers,
      payload: { seq: 3, sha256: data.sha256, size: 32, kid: 'k1' },
    });
    expect(nope.statusCode).toBe(404);
    expect(nope.json<{ code: string }>().code).toBe('snapshot_missing');
  });
});
