/**
 * The auth plugin (B017, card test auth-plugin.test.ts): a missing or malformed Authorization
 * header, the principal attached to the request, route scopes, the resolver registry for other
 * bearer credentials (`cen_` API keys, B019), public and unmatched routes.
 */
import { AppError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { authApp, bearer, memoryTokens, memoryUser } from './helpers.js';

describe('the auth plugin', () => {
  it('attaches the principal of a valid access token', async () => {
    const { tokens, store } = memoryTokens();
    const user = memoryUser(store);
    const { access_token: token } = await tokens.issueTokens({
      ...user,
      scopes: ['profile', 'sessions:read'],
    });
    const { app } = await authApp(tokens);
    const res = await app.inject({ url: '/v1/test/me', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      kind: 'user',
      userId: user.userId,
      deviceId: user.deviceId,
      workspaceId: null,
      scopes: ['profile', 'sessions:read'],
    });
    // The scheme is case-insensitive (RFC 7235).
    expect(
      (await app.inject({ url: '/v1/test/me', headers: { authorization: `bearer ${token}` } }))
        .statusCode,
    ).toBe(200);
    await app.close();
  });

  it.each([
    ['no header', {}],
    ['another scheme', { authorization: 'Basic dXNlcjpwYXNz' }],
    ['an empty bearer', { authorization: 'Bearer ' }],
    ['two credentials', { authorization: 'Bearer a b' }],
    ['a credential with a space', { authorization: 'Bearer a,b' }],
  ])('answers %s with 401 unauthorized and WWW-Authenticate: Bearer', async (_label, headers) => {
    const { tokens } = memoryTokens();
    const { app } = await authApp(tokens);
    const res = await app.inject({ url: '/v1/test/me', headers });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'unauthorized' });
    expect(res.headers['www-authenticate']).toBe('Bearer');
    await app.close();
  });

  it('answers a bad token with its 401 code and WWW-Authenticate: Bearer error="invalid_token"', async () => {
    const { tokens } = memoryTokens();
    const { app } = await authApp(tokens);
    const res = await app.inject({ url: '/v1/test/me', headers: bearer('not.a.token') });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'token_invalid' });
    expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    await app.close();
  });

  it('requires the scopes a route lists (403 forbidden otherwise)', async () => {
    const { tokens, store } = memoryTokens();
    const user = memoryUser(store);
    const { app } = await authApp(tokens);
    const plain = await tokens.issueTokens({ ...user, scopes: ['profile'] });
    const admin = await tokens.issueTokens({ ...user, scopes: ['profile', 'admin'] });
    const denied = await app.inject({ url: '/v1/test/admin', headers: bearer(plain.access_token) });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'forbidden' });
    expect(denied.headers['www-authenticate']).toBeUndefined();
    expect(
      (await app.inject({ url: '/v1/test/admin', headers: bearer(admin.access_token) })).statusCode,
    ).toBe(200);
    await app.close();
  });

  it('hands credentials with a registered prefix to their resolver', async () => {
    const { tokens } = memoryTokens();
    const seen: string[] = [];
    tokens.registerPrincipalResolver('cen_', (credential) => {
      seen.push(credential);
      if (credential !== 'cen_test_good')
        return Promise.reject(
          new AppError('token_invalid', { detail: 'The access token is not valid.' }),
        );
      return Promise.resolve({
        kind: 'api_key',
        userId: null,
        deviceId: null,
        workspaceId: 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
        scopes: ['admin'],
      });
    });
    expect(() =>
      tokens.registerPrincipalResolver('', () => Promise.reject(new Error('never'))),
    ).toThrow(TypeError);
    const { app } = await authApp(tokens);
    const ok = await app.inject({ url: '/v1/test/admin', headers: bearer('cen_test_good') });
    expect(ok.statusCode).toBe(200);
    const me = await app.inject({ url: '/v1/test/me', headers: bearer('cen_test_good') });
    expect(me.json()).toMatchObject({ kind: 'api_key', userId: null, scopes: ['admin'] });
    expect(
      (await app.inject({ url: '/v1/test/me', headers: bearer('cen_test_bad') })).json(),
    ).toMatchObject({ code: 'token_invalid' });
    expect(seen).toEqual(['cen_test_good', 'cen_test_good', 'cen_test_bad']);
    await app.close();
  });

  it('leaves public and unmatched routes alone', async () => {
    const { tokens } = memoryTokens();
    const { app } = await authApp(tokens);
    const open = await app.inject({ url: '/v1/test/public', headers: bearer('garbage') });
    expect(open.statusCode).toBe(200);
    expect(open.json()).toEqual({ principal: null });
    const missing = await app.inject({ url: '/v1/nothing-here' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
