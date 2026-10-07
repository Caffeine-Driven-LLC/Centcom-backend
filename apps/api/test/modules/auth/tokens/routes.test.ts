/**
 * The HTTP endpoints (B017 acceptance 3, 7 and 9): `POST /v1/auth/token` (form or JSON, client and
 * CSRF checks, grant dispatch, `no-store`), `POST /v1/auth/revoke` (RFC 7009: 200 for unknown
 * tokens, revokes the caller's family or device only), and a full flow whose log lines never
 * hold a token.
 */
import { describe, expect, it } from 'vitest';
import { captureLogger } from '../../../helpers.js';
import { authApp, bearer, memoryTokens, memoryUser, newId } from './helpers.js';

const form = (
  fields: Record<string, string>,
): { payload: string; headers: Record<string, string> } => ({
  payload: new URLSearchParams(fields).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
});

describe('POST /v1/auth/token', () => {
  it('refreshes with a form body or JSON, answering no-store (acceptance 3)', async () => {
    const { tokens, store } = memoryTokens();
    const { app } = await authApp(tokens);
    const issued = await tokens.issueTokens({ ...memoryUser(store), scopes: ['profile'] });
    const viaForm = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      ...form({
        grant_type: 'refresh_token',
        refresh_token: issued.refresh_token,
        client_id: 'centcom-cli',
      }),
    });
    expect(viaForm.statusCode).toBe(200);
    expect(viaForm.headers['cache-control']).toBe('no-store');
    expect(viaForm.headers['pragma']).toBe('no-cache');
    const body = viaForm.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
      scope: 'profile',
      user: issued.user,
      device: issued.device,
    });
    const viaJson = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: {
        grant_type: 'refresh_token',
        refresh_token: body['refresh_token'],
        client_id: 'centcom-cli',
      },
    });
    expect(viaJson.statusCode).toBe(200);
    // The first token, spent: reuse, and the family is gone.
    const reuse = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: {
        grant_type: 'refresh_token',
        refresh_token: issued.refresh_token,
        client_id: 'centcom-cli',
      },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json()).toMatchObject({ code: 'refresh_reuse_detected' });
    await app.close();
  });

  it.each([
    ['no grant_type', { client_id: 'centcom-cli' }, 400, 'invalid_request'],
    ['no client_id', { grant_type: 'refresh_token' }, 400, 'invalid_request'],
    [
      'an unknown client',
      { grant_type: 'refresh_token', client_id: 'evil-cli' },
      401,
      'invalid_client',
    ],
    [
      'an unsupported grant',
      { grant_type: 'password', client_id: 'centcom-cli' },
      400,
      'invalid_request',
    ],
    [
      'a refresh without the token',
      { grant_type: 'refresh_token', client_id: 'centcom-cli' },
      400,
      'invalid_request',
    ],
    [
      'a non-string scope',
      { grant_type: 'refresh_token', client_id: 'centcom-cli', refresh_token: 'x', scope: 3 },
      400,
      'invalid_request',
    ],
    [
      'the web client without its header',
      { grant_type: 'refresh_token', client_id: 'centcom-web', refresh_token: 'x' },
      400,
      'invalid_request',
    ],
  ])('refuses %s', async (_label, payload, status, code) => {
    const { tokens } = memoryTokens();
    const { app } = await authApp(tokens);
    const res = await app.inject({ method: 'POST', url: '/v1/auth/token', payload });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ code });
    await app.close();
  });

  it('refuses a repeated form parameter, and lets the web client in with X-Centcom-Client: web', async () => {
    const { tokens, store } = memoryTokens();
    const { app } = await authApp(tokens);
    const repeated = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: 'grant_type=refresh_token&client_id=centcom-cli&client_id=centcom-web',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(repeated.statusCode).toBe(400);
    expect(repeated.json()).toMatchObject({ code: 'invalid_request' });
    const web = await tokens.issueTokens({
      ...memoryUser(store),
      scopes: ['profile'],
      clientId: 'centcom-web',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: { 'x-centcom-client': 'web' },
      payload: {
        grant_type: 'refresh_token',
        client_id: 'centcom-web',
        refresh_token: web.refresh_token,
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('dispatches to registered grant handlers', async () => {
    const { tokens, store } = memoryTokens();
    const user = memoryUser(store);
    tokens.registerGrantHandler('urn:ietf:params:oauth:grant-type:device_code', async (request) => {
      expect(request).toMatchObject({ device_code: 'dc-123', client_id: 'centcom-cli' });
      return tokens.issueTokens({ ...user, scopes: ['profile'] });
    });
    const { app } = await authApp(tokens);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'dc-123',
        client_id: 'centcom-cli',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: user.userId, device: user.deviceId });
    await app.close();
  });
});

describe('POST /v1/auth/revoke', () => {
  it('answers 200 for an unknown token and changes nothing (acceptance 7)', async () => {
    const { tokens, store } = memoryTokens();
    const { app } = await authApp(tokens);
    const user = memoryUser(store);
    const issued = await tokens.issueTokens({ ...user, scopes: ['profile'] });
    const rowsBefore = JSON.stringify([...store.rows.values()]);
    for (const token of ['unknown-token', 'A'.repeat(43)]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/revoke',
        headers: bearer(issued.access_token),
        payload: { token, token_type_hint: 'refresh_token' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('');
    }
    expect(JSON.stringify([...store.rows.values()])).toBe(rowsBefore);
    await app.close();
  });

  it("revokes the family of the caller's refresh token, and only the caller's (acceptance 7)", async () => {
    const { tokens, store } = memoryTokens();
    const { app } = await authApp(tokens);
    const alice = await tokens.issueTokens({ ...memoryUser(store), scopes: ['profile'] });
    const bob = await tokens.issueTokens({ ...memoryUser(store), scopes: ['profile'] });
    const attempt = await app.inject({
      method: 'POST',
      url: '/v1/auth/revoke',
      headers: bearer(alice.access_token),
      payload: { token: bob.refresh_token },
    });
    expect(attempt.statusCode).toBe(200);
    expect(
      (await tokens.refresh({ refreshToken: bob.refresh_token, clientId: 'centcom-cli' })).user,
    ).toBe(bob.user);
    const own = await app.inject({
      method: 'POST',
      url: '/v1/auth/revoke',
      headers: bearer(alice.access_token),
      payload: { token: alice.refresh_token },
    });
    expect(own.statusCode).toBe(200);
    await expect(
      tokens.refresh({ refreshToken: alice.refresh_token, clientId: 'centcom-cli' }),
    ).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    await app.close();
  });

  it("revokes the caller's device, not another user's", async () => {
    const { tokens, store } = memoryTokens();
    const { app } = await authApp(tokens);
    const alice = memoryUser(store);
    const bob = memoryUser(store);
    const aliceTokens = await tokens.issueTokens({ ...alice, scopes: ['profile'] });
    const bobTokens = await tokens.issueTokens({ ...bob, scopes: ['profile'] });
    const foreign = await app.inject({
      method: 'POST',
      url: '/v1/auth/revoke',
      headers: bearer(aliceTokens.access_token),
      payload: { device: bob.deviceId },
    });
    expect(foreign.statusCode).toBe(200);
    expect((await tokens.verifyAccessToken(bobTokens.access_token)).sub).toBe(bob.userId);
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/auth/revoke',
      headers: bearer(aliceTokens.access_token),
      payload: { device: newId('dev') },
    });
    expect(unknown.statusCode).toBe(200);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/revoke',
      headers: bearer(aliceTokens.access_token),
      payload: { device: alice.deviceId },
    });
    await expect(tokens.verifyAccessToken(aliceTokens.access_token)).rejects.toMatchObject({
      code: 'device_revoked',
    });
    await app.close();
  });

  it('checks the body, the scope and the content type', async () => {
    const { tokens, store } = memoryTokens();
    const { app } = await authApp(tokens);
    const user = memoryUser(store);
    const token = (await tokens.issueTokens({ ...user, scopes: ['profile'] })).access_token;
    const post = (payload: unknown, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/revoke',
        headers: { ...bearer(token), ...headers },
        payload: payload as string,
      });
    expect((await post({})).json()).toMatchObject({ code: 'invalid_request' });
    const invalid = await post({ token: 7, token_type_hint: 'access_token', device: 'phone' });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json<{ errors: { pointer: string }[] }>().errors.map((e) => e.pointer)).toEqual([
      '/token',
      '/token_type_hint',
      '/device',
    ]);
    expect((await post([])).statusCode).toBe(422);
    expect(
      (await post('token=x', { 'content-type': 'application/x-www-form-urlencoded' })).statusCode,
    ).toBe(415);
    const noProfile = (await tokens.issueTokens({ ...user, scopes: ['sessions:read'] }))
      .access_token;
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/auth/revoke',
      headers: bearer(noProfile),
      payload: { token: 'x' },
    });
    expect(denied.statusCode).toBe(403);
    const anonymous = await app.inject({
      method: 'POST',
      url: '/v1/auth/revoke',
      payload: { token: 'x' },
    });
    expect(anonymous.statusCode).toBe(401);
    await app.close();
  });
});

describe('logging', () => {
  it('never writes a token: a full flow of issue, refresh, use, reuse, bad tokens and revocation (acceptance 9)', async () => {
    // One log for the service and the app, as the API will run them.
    const captured = captureLogger();
    const { tokens, store } = memoryTokens({ logger: captured.logger });
    const { app, raw } = await authApp(tokens, { captured });
    const user = memoryUser(store);
    const issued = await tokens.issueTokens({ ...user, scopes: ['profile'] });
    const secrets = [issued.access_token, issued.refresh_token];
    const refresh = (refreshToken: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/token',
        payload: {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: 'centcom-cli',
        },
      });
    const rotated = (await refresh(issued.refresh_token)).json<{
      access_token: string;
      refresh_token: string;
    }>();
    secrets.push(rotated.access_token, rotated.refresh_token);
    await app.inject({ url: '/v1/test/me', headers: bearer(rotated.access_token) });
    await refresh(issued.refresh_token); // reuse: logged as a security event
    await app.inject({ url: '/v1/test/me', headers: bearer(`${rotated.access_token}x`) });
    await app.inject({
      method: 'POST',
      url: '/v1/auth/revoke',
      headers: bearer(rotated.access_token),
      payload: { token: rotated.refresh_token },
    });
    const log = raw();
    expect(log).toContain('auth.refresh_reuse_detected');
    expect(log).toContain('http.request');
    for (const secret of secrets) {
      expect(log).not.toContain(secret);
      // Nor any recognisable part of one (a JWT's signature, a refresh token's first half).
      expect(log).not.toContain(secret.slice(-20));
    }
    await app.close();
  });
});
