/**
 * Who may read and purge history (B055; tests "history.authz.test.ts", acceptance 3 and 4):
 *
 * - host, editor and viewer may GET; a non-participant, an unknown session or a malformed id is
 *   404 (the session is not revealed); a share-link guest reads only while the session shares
 *   its history (403 otherwise);
 * - DELETE: the host or the workspace owner 204; an editor 403 `host_required`; anyone else 404;
 * - no credential 401; an API key or a token without the scope 403;
 * - store failures: a read that fails is 503 with `retry_after_s` (never a partial page); a purge
 *   that fails is 503 and can be retried.
 */
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { historyApp, memoryHistoryStore, newId, scriptedAccess, storedRange } from './helpers.js';

async function setup() {
  const store = memoryHistoryStore();
  const scripted = scriptedAccess();
  const h = await historyApp(store, scripted.access);
  const sid = newId('ses');
  await store.append(sid, storedRange(sid, 1, 3));
  const users = {
    host: newId('usr'),
    editor: newId('usr'),
    viewer: newId('usr'),
    owner: newId('usr'),
    stranger: newId('usr'),
    guest: newId('usr'),
  };
  scripted.set(sid, users.host, { role: 'host' });
  scripted.set(sid, users.editor, { role: 'editor' });
  scripted.set(sid, users.viewer, { role: 'viewer' });
  scripted.set(sid, users.owner, { workspaceOwner: true });
  scripted.set(sid, users.stranger, {});
  return { ...h, store, scripted, sid, users };
}

describe('GET /v1/sessions/{id}/history', () => {
  it('lets host, editor and viewer read; hides the session from anyone else (acceptance 3)', async () => {
    const s = await setup();
    for (const who of ['host', 'editor', 'viewer'] as const) {
      const res = await s.app.inject({
        method: 'GET',
        url: `/v1/sessions/${s.sid}/history`,
        headers: await s.bearerOf(s.users[who]),
      });
      expect(res.statusCode, who).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(validate('api/HistoryPage', res.json()).ok).toBe(true);
      expect(res.json<{ data: unknown[] }>().data).toHaveLength(3);
    }
    for (const [who, url] of [
      ['stranger', `/v1/sessions/${s.sid}/history`],
      ['host', `/v1/sessions/${newId('ses')}/history`],
      ['host', '/v1/sessions/nope/history'],
    ] as const) {
      const res = await s.app.inject({
        method: 'GET',
        url,
        headers: await s.bearerOf(s.users[who]),
      });
      expect(res.statusCode, `${who} ${url}`).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_found' });
    }
    await s.app.close();
  });

  it('lets a share-link guest read only while the session shares its history (acceptance 3)', async () => {
    const s = await setup();
    s.scripted.set(s.sid, s.users.guest, {
      role: 'viewer',
      shareLinkGuest: true,
      shareHistory: false,
    });
    const denied = await s.app.inject({
      method: 'GET',
      url: `/v1/sessions/${s.sid}/history`,
      headers: await s.bearerOf(s.users.guest),
    });
    expect(denied.statusCode).toBe(403);
    s.scripted.set(s.sid, s.users.guest, {
      role: 'viewer',
      shareLinkGuest: true,
      shareHistory: true,
    });
    const allowed = await s.app.inject({
      method: 'GET',
      url: `/v1/sessions/${s.sid}/history`,
      headers: await s.bearerOf(s.users.guest),
    });
    expect(allowed.statusCode).toBe(200);
    await s.app.close();
  });

  it('answers 503 rather than a partial page when the store fails', async () => {
    const s = await setup();
    s.store.failReads = true;
    const res = await s.app.inject({
      method: 'GET',
      url: `/v1/sessions/${s.sid}/history`,
      headers: await s.bearerOf(s.users.host),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'service_unavailable', retry_after_s: 1 });
    await s.app.close();
  });

  it('refuses bad parameters', async () => {
    const s = await setup();
    const headers = await s.bearerOf(s.users.host);
    for (const [query, status, code] of [
      ['after_seq=-1', 422, 'validation_failed'],
      ['after_seq=x', 422, 'validation_failed'],
      ['limit=0', 422, 'validation_failed'],
      ['limit=201', 422, 'validation_failed'],
      ['cursor=abc', 400, 'cursor_invalid'],
    ] as const) {
      const res = await s.app.inject({
        method: 'GET',
        url: `/v1/sessions/${s.sid}/history?${query}`,
        headers,
      });
      expect(res.statusCode, query).toBe(status);
      expect(res.json(), query).toMatchObject({ code });
    }
    await s.app.close();
  });
});

describe('DELETE /v1/sessions/{id}/history', () => {
  it('lets the host and the workspace owner purge; refuses an editor (acceptance 4)', async () => {
    const s = await setup();
    const editor = await s.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${s.sid}/history`,
      headers: await s.bearerOf(s.users.editor),
    });
    expect(editor.statusCode).toBe(403);
    expect(editor.json()).toMatchObject({ code: 'host_required' });
    const stranger = await s.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${s.sid}/history`,
      headers: await s.bearerOf(s.users.stranger),
    });
    expect(stranger.statusCode).toBe(404);
    for (const who of ['host', 'owner'] as const) {
      const res = await s.app.inject({
        method: 'DELETE',
        url: `/v1/sessions/${s.sid}/history`,
        headers: await s.bearerOf(s.users[who]),
      });
      expect(res.statusCode, who).toBe(204);
      expect(res.body).toBe('');
    }
    expect(s.audited).toHaveLength(2);
    expect(s.audited[0]).toMatchObject({
      action: 'history.purge',
      actor: { type: 'user', id: s.users.host },
      target: { type: 'session', id: s.sid },
      outcome: 'success',
      meta: { frames: 3, blobs: 1 },
    });
    await s.app.close();
  });

  it('answers 503 when the purge fails partway, and finishes on a retry', async () => {
    const s = await setup();
    s.store.failPurge = true;
    const headers = await s.bearerOf(s.users.host);
    const failed = await s.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${s.sid}/history`,
      headers,
    });
    expect(failed.statusCode).toBe(503);
    expect(s.audited).toEqual([]);
    s.store.failPurge = false;
    const done = await s.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${s.sid}/history`,
      headers,
    });
    expect(done.statusCode).toBe(204);
    await s.app.close();
  });
});

describe('credentials', () => {
  it('401 without one; 403 for an API key or a missing scope', async () => {
    const s = await setup();
    const url = `/v1/sessions/${s.sid}/history`;
    expect((await s.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const key = { authorization: `Bearer cen_live_${'h'.repeat(32)}` };
    expect((await s.app.inject({ method: 'GET', url, headers: key })).statusCode).toBe(403);
    expect((await s.app.inject({ method: 'DELETE', url, headers: key })).statusCode).toBe(403);
    const readOnly = await s.bearerOf(s.users.host, ['sessions:read']);
    expect((await s.app.inject({ method: 'DELETE', url, headers: readOnly })).statusCode).toBe(403);
    const noScope = await s.bearerOf(s.users.host, ['profile']);
    expect((await s.app.inject({ method: 'GET', url, headers: noScope })).statusCode).toBe(403);
    await s.app.close();
  });
});
