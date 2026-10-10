/**
 * B056 idempotency and ordering (acceptance 6): replaying a commit (and a begin) with the same
 * Idempotency-Key returns the same body with `Idempotency-Replayed: true`; a commit with a lower
 * seq than the latest is accepted and stored but GET latest still serves the highest seq.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ciphertext, snapshotApp } from './helpers.js';

describe('Idempotency-Key and lower seqs (acceptance 6)', () => {
  it('replays a commit with the same key: same body, Idempotency-Replayed: true', async () => {
    const env = await snapshotApp();
    const headers = await env.bearerOf(env.host);
    const data = ciphertext(40);
    const grant = await env.service.begin(env.sid, { userId: env.host }, { size: 40 });
    env.store.upload(grant.uploadUrl, data.bytes, new Date(env.clock.now));
    const key = randomUUID();
    const commit = () =>
      env.app.inject({
        method: 'POST',
        url: `/v1/sessions/${env.sid}/snapshot/${grant.snp}/commit`,
        headers: { ...headers, 'idempotency-key': key },
        payload: { seq: 12, sha256: data.sha256, size: 40, kid: 'k1' },
      });
    const first = await commit();
    expect(first.statusCode).toBe(200);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    const reads = env.store.reads.length;
    const again = await commit();
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.body).toBe(first.body);
    expect(again.headers['cache-control']).toBe('private, no-store');
    expect(env.store.reads).toHaveLength(reads);
    expect(env.audit.events.filter((e) => e.action === 'snapshot.commit')).toHaveLength(1);
  });

  it('replays a begin with the same key: one pending row, the same upload URL', async () => {
    const env = await snapshotApp();
    const headers = { ...(await env.bearerOf(env.host)), 'idempotency-key': randomUUID() };
    const begin = () =>
      env.app.inject({
        method: 'POST',
        url: `/v1/sessions/${env.sid}/snapshot`,
        headers,
        payload: { size: 5 },
      });
    const first = await begin();
    const again = await begin();
    expect(first.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.body).toBe(first.body);
    expect(env.rows.rows.size).toBe(1);
    // The same key with another body is a conflict.
    const other = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${env.sid}/snapshot`,
      headers,
      payload: { size: 6 },
    });
    expect(other.statusCode).toBe(409);
    expect(other.json<{ code: string }>().code).toBe('idempotency_conflict');
  });

  it('a lower seq than the latest is accepted and stored, but GET still serves the latest', async () => {
    const env = await snapshotApp();
    const high = await env.snapshot(400);
    const low = await env.snapshot(150);
    expect(low.descriptor.seq).toBe(150);
    expect(env.rows.rows.get(low.grant.snp)?.state).toBe('committed');
    const res = await env.app.inject({
      method: 'GET',
      url: `/v1/sessions/${env.sid}/snapshot`,
      headers: await env.bearerOf(env.viewer),
    });
    expect(res.json<{ snp: string; seq: number }>()).toMatchObject({
      snp: high.grant.snp,
      seq: 400,
    });
  });

  it('no committed snapshot: GET 404 snapshot_missing, and latest() is null (acceptance 8)', async () => {
    const env = await snapshotApp();
    await env.service.begin(env.sid, { userId: env.host }, { size: 1 });
    const res = await env.app.inject({
      method: 'GET',
      url: `/v1/sessions/${env.sid}/snapshot`,
      headers: await env.bearerOf(env.host),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('snapshot_missing');
    expect(await env.service.latest(env.sid)).toBeNull();
  });
});
