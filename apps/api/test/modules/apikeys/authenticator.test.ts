/**
 * Keys as bearers (B019 acceptance 2-4 and 8, failure mode; card test authenticator.test.ts): a
 * key authenticates with only its scopes, revoked, expired and deleted-workspace keys are refused
 * from the next request, an unknown key and a wrong one get the same body, keys cannot join
 * sessions, and `last_used_at` is written at most once a minute however hard a key is used.
 */
import { describe, expect, it } from 'vitest';
import { LAST_USED_FAILURES_METRIC } from '../../../src/modules/apikeys/authenticator.js';
import { generateApiKey } from '../../../src/modules/apikeys/generate.js';
import { recordingMetrics } from '../../helpers.js';
import { testClock } from '../auth/tokens/helpers.js';
import { arrangeWorkspace, bearer, bearerApp, type BearerApp } from './helpers.js';

/** A key made through the API by the workspace owner. */
async function newKey(
  t: BearerApp,
  body: Record<string, unknown> = {},
): Promise<{ key: string; id: string; workspaceId: string; owner: string }> {
  const { workspaceId, users } = arrangeWorkspace(t.ws);
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: bearer(await t.userToken(users.owner, CREATOR_SCOPES)),
    payload: { workspace: workspaceId, name: 'CI', scopes: ['workspaces:read'], ...body },
  });
  expect(res.statusCode, res.body).toBe(201);
  return {
    key: String(res.json().secret),
    id: String(res.json().id),
    workspaceId,
    owner: users.owner,
  };
}

/** The owner's own credential holds every scope a test key asks for. */
const CREATOR_SCOPES =
  'profile workspaces:read workspaces:write sessions:read sessions:write sessions:host usage:write';

const stable = (body: Record<string, unknown>) => ({ ...body, request_id: undefined });

describe('a key as a bearer', () => {
  it('authenticates as the key, with only its scopes (acceptance 2)', async () => {
    const t = await bearerApp();
    const { key, id, workspaceId } = await newKey(t, {
      scopes: ['workspaces:read', 'usage:write'],
    });
    const me = await t.app.inject({ method: 'GET', url: '/v1/test/whoami', headers: bearer(key) });
    expect(me.json()).toEqual({
      kind: 'api_key',
      keyId: id,
      workspaceId,
      scopes: ['workspaces:read', 'usage:write'],
    });
  });

  it('gets 403 forbidden on GET /v1/api-keys without workspaces:write, and with it (keys do not manage keys)', async () => {
    const t = await bearerApp();
    const without = await newKey(t);
    const res = await t.app.inject({
      method: 'GET',
      url: `/v1/api-keys?workspace=${without.workspaceId}`,
      headers: bearer(without.key),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'forbidden' });
    const withWrite = await newKey(t, { scopes: ['workspaces:read', 'workspaces:write'] });
    const again = await t.app.inject({
      method: 'GET',
      url: `/v1/api-keys?workspace=${withWrite.workspaceId}`,
      headers: bearer(withWrite.key),
    });
    expect(again.statusCode).toBe(403);
  });

  it('cannot get a relay ticket or join a session (acceptance 4)', async () => {
    const t = await bearerApp();
    const { key } = await newKey(t, {
      scopes: ['workspaces:read', 'sessions:read', 'sessions:write', 'sessions:host'],
    });
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/test/sessions/ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W/join-token',
      headers: bearer(key),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'forbidden' });
  });

  it('is refused with 401 token_revoked on the very next request after DELETE (acceptance 3)', async () => {
    const t = await bearerApp();
    const { key, id, owner } = await newKey(t);
    expect(
      (await t.app.inject({ method: 'GET', url: '/v1/test/whoami', headers: bearer(key) }))
        .statusCode,
    ).toBe(200);
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${id}`,
      headers: bearer(await t.userToken(owner)),
    });
    expect(del.statusCode).toBe(204);
    const after = await t.app.inject({
      method: 'GET',
      url: '/v1/test/whoami',
      headers: bearer(key),
    });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ code: 'token_revoked' });
    expect(after.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
  });

  it('is refused with token_revoked once its workspace is deleted', async () => {
    const t = await bearerApp();
    const { key, workspaceId } = await newKey(t);
    const row = t.ws.workspaces.get(workspaceId);
    if (row !== undefined) row.deletedAt = new Date();
    const res = await t.app.inject({ method: 'GET', url: '/v1/test/whoami', headers: bearer(key) });
    expect(res.json()).toMatchObject({ code: 'token_revoked' });
  });

  it('is refused with token_expired after its expires_at', async () => {
    const clock = testClock();
    const t = await bearerApp({ now: clock.now });
    const { key } = await newKey(t, { expires_at: new Date(clock.now() + 60_000).toISOString() });
    expect(
      (await t.app.inject({ method: 'GET', url: '/v1/test/whoami', headers: bearer(key) }))
        .statusCode,
    ).toBe(200);
    clock.advance(60_000);
    const res = await t.app.inject({ method: 'GET', url: '/v1/test/whoami', headers: bearer(key) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'token_expired' });
  });

  it('gives an unknown key, a malformed one and a one-character-off one the same 401 body', async () => {
    const t = await bearerApp();
    const { key } = await newKey(t);
    const flipped = `${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`;
    const answers = [];
    for (const credential of [
      generateApiKey('live').key,
      generateApiKey('test').key,
      flipped,
      'cen_live_short',
      `${key}x`,
    ]) {
      const res = await t.app.inject({
        method: 'GET',
        url: '/v1/test/whoami',
        headers: bearer(credential),
      });
      expect(res.statusCode).toBe(401);
      answers.push(JSON.stringify(stable(res.json())));
    }
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0] ?? '{}')).toMatchObject({ code: 'token_invalid' });
  });

  it('does not route another prefix to the key resolver (it is not a key)', async () => {
    const t = await bearerApp();
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/test/whoami',
      headers: bearer(`cen_prod_${'a'.repeat(32)}`),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'token_invalid' });
  });
});

describe('last_used_at (acceptance 8, failure mode)', () => {
  it('is written at most once per 60 s under 1 000 rapid calls', async () => {
    const clock = testClock();
    const t = await bearerApp({ now: clock.now });
    const { key, id } = await newKey(t);
    for (let i = 0; i < 1000; i++) {
      const res = await t.app.inject({
        method: 'GET',
        url: '/v1/test/whoami',
        headers: bearer(key),
      });
      expect(res.statusCode).toBe(200);
      clock.advance(50); // 1 000 calls over 50 s
    }
    await t.authenticator.settled();
    expect(t.keys.touches).toBe(1);
    expect(t.keys.keys.get(id)?.lastUsedAt).not.toBeNull();
    clock.advance(10_000); // past the minute
    await t.app.inject({ method: 'GET', url: '/v1/test/whoami', headers: bearer(key) });
    await t.authenticator.settled();
    expect(t.keys.touches).toBe(2);
  });

  it('a failed write is counted and logged, and the request still succeeds', async () => {
    const recorded = recordingMetrics();
    const t = await bearerApp({ metrics: recorded.metrics });
    const { key } = await newKey(t);
    t.keys.failTouches = 1;
    const res = await t.app.inject({ method: 'GET', url: '/v1/test/whoami', headers: bearer(key) });
    expect(res.statusCode).toBe(200);
    await t.authenticator.settled();
    expect(recorded.count(LAST_USED_FAILURES_METRIC)).toBe(1);
    expect(t.logs()).toContain('api_key.last_used_failed');
  });
});
