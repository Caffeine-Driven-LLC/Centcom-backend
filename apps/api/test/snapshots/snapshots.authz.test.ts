/**
 * B056 authorisation (acceptance 5): only the host begins or commits (an editor or viewer gets 403
 * `host_required`); the host or any participant reads; a non-participant, an unknown session or an
 * API key gets 404 or 403; no caller is 401.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { ciphertext, snapshotApp } from './helpers.js';

describe('who may use snapshots (acceptance 5)', () => {
  it('begin: host 201, editor and viewer 403 host_required, outsider and unknown 404', async () => {
    const env = await snapshotApp();
    const begin = async (userId: string, sid = env.sid) =>
      env.app.inject({
        method: 'POST',
        url: `/v1/sessions/${sid}/snapshot`,
        headers: await env.bearerOf(userId),
        payload: { size: 4 },
      });
    expect((await begin(env.host)).statusCode).toBe(201);
    for (const who of [env.editor, env.viewer]) {
      const res = await begin(who);
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('host_required');
    }
    expect((await begin(env.outsider)).statusCode).toBe(404);
    expect((await begin(env.host, newId('ses'))).statusCode).toBe(404);
    expect((await begin(env.host, 'ses_nope')).statusCode).toBe(404);
  });

  it('commit: host 200, editor 403, outsider 404; nothing is read for a refused caller', async () => {
    const env = await snapshotApp();
    const data = ciphertext(16);
    const grant = await env.service.begin(env.sid, { userId: env.host }, { size: 16 });
    env.store.upload(grant.uploadUrl, data.bytes, new Date(env.clock.now));
    const commit = async (userId: string) =>
      env.app.inject({
        method: 'POST',
        url: `/v1/sessions/${env.sid}/snapshot/${grant.snp}/commit`,
        headers: await env.bearerOf(userId),
        payload: { seq: 1, sha256: data.sha256, size: 16, kid: 'k1' },
      });
    const editor = await commit(env.editor);
    expect(editor.statusCode).toBe(403);
    expect(editor.json<{ code: string }>().code).toBe('host_required');
    expect((await commit(env.outsider)).statusCode).toBe(404);
    expect(env.store.reads).toHaveLength(0);
    expect((await commit(env.host)).statusCode).toBe(200);
  });

  it('GET: host and every participant 200, outsider and unknown session 404', async () => {
    const env = await snapshotApp();
    await env.snapshot(9, 8);
    const get = async (userId: string, sid = env.sid) =>
      env.app.inject({
        method: 'GET',
        url: `/v1/sessions/${sid}/snapshot`,
        headers: await env.bearerOf(userId),
      });
    for (const who of [env.host, env.editor, env.viewer]) {
      const res = await get(who);
      expect(res.statusCode).toBe(200);
      expect(res.json<{ seq: number }>().seq).toBe(9);
    }
    const outsider = await get(env.outsider);
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json<{ code: string }>().code).toBe('not_found');
    expect((await get(env.host, newId('ses'))).statusCode).toBe(404);
  });

  it('no caller 401; an API key or a token without the scope 403', async () => {
    const env = await snapshotApp();
    const anonymous = await env.app.inject({
      method: 'GET',
      url: `/v1/sessions/${env.sid}/snapshot`,
    });
    expect(anonymous.statusCode).toBe(401);
    const key = await env.app.inject({
      method: 'GET',
      url: `/v1/sessions/${env.sid}/snapshot`,
      headers: { authorization: `Bearer cen_live_${'a'.repeat(40)}` },
    });
    expect([401, 403]).toContain(key.statusCode);
    const readOnly = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${env.sid}/snapshot`,
      headers: await env.bearerOf(env.host, ['sessions:read']),
      payload: { size: 4 },
    });
    expect(readOnly.statusCode).toBe(403);
  });
});
