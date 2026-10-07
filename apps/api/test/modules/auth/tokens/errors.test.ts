/**
 * Uniform error bodies (B017 acceptance 6, guardrails; card test errors.test.ts): every invalid
 * access token gets the same `token_invalid` body whatever was wrong with it, the four 401 codes
 * of CT-AUTH come out over HTTP, and an unknown, malformed, expired or revoked refresh token gets
 * one `invalid_grant` body (no oracle).
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateSigningJwk,
  signAccessToken,
  signJwt,
} from '../../../../src/modules/auth/tokens/index.js';
import { authApp, bearer, DAY_MS, keySet, memoryTokens, memoryUser, newId } from './helpers.js';

/** A body without what differs per request. */
const stable = (body: Record<string, unknown>): Record<string, unknown> => {
  const rest = { ...body };
  delete rest['request_id'];
  delete rest['instance'];
  return rest;
};

describe('error bodies', () => {
  it('are identical for every kind of invalid access token', async () => {
    const { tokens, keys, clock } = memoryTokens();
    const { app } = await authApp(tokens);
    const claims = { sub: newId('usr'), scp: 'profile', plan: 'free', ent: 0 } as const;
    const { token } = await signAccessToken(keys, claims, clock.now());
    const [h, p, s] = token.split('.');
    const strangerKeys = keySet([generateSigningJwk(keys.active.kid)], keys.active.kid);
    const header = (obj: object): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const hs = `${header({ alg: 'HS256', typ: 'at+jwt', kid: keys.active.kid })}.${p}`;
    const invalid = [
      'garbage',
      `${h}.${p}.${(s ?? '').startsWith('A') ? 'B' : 'A'}${(s ?? '').slice(1)}`,
      `${header({ alg: 'none', typ: 'at+jwt' })}.${p}.`,
      `${hs}.${createHmac('sha256', Buffer.from(keys.active.x, 'base64url')).update(hs).digest('base64url')}`,
      (await signAccessToken(strangerKeys, claims, clock.now())).token,
      await signJwt(keys, claims, {
        typ: 'at+jwt',
        audience: 'centcom-relay',
        ttlS: 900,
        nowMs: clock.now(),
      }),
    ];
    const bodies = await Promise.all(
      invalid.map(async (credential) => {
        const res = await app.inject({ url: '/v1/test/me', headers: bearer(credential) });
        expect(res.statusCode, credential).toBe(401);
        return stable(res.json<Record<string, unknown>>());
      }),
    );
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(bodies[0]).toEqual({
      type: 'https://centcom.dev/errors/token_invalid',
      title: 'Access token invalid',
      status: 401,
      code: 'token_invalid',
      detail: 'The access token is not valid.',
    });
    await app.close();
  });

  it('carry token_expired, token_revoked and device_revoked over HTTP', async () => {
    const { tokens, store, clock } = memoryTokens();
    const { app } = await authApp(tokens);
    const user = memoryUser(store);
    const expiring = await tokens.issueTokens({ ...user, scopes: ['profile'] });
    const revoked = await tokens.issueTokens({ ...user, scopes: ['profile'] });
    const claims = await tokens.verifyAccessToken(revoked.access_token);
    await tokens.revokeAccessJti(claims.jti, claims.exp);
    const codeOf = async (token: string): Promise<unknown> =>
      (await app.inject({ url: '/v1/test/me', headers: bearer(token) })).json<
        Record<string, unknown>
      >()['code'];
    expect(await codeOf(revoked.access_token)).toBe('token_revoked');
    clock.advance(16 * 60 * 1000);
    expect(await codeOf(expiring.access_token)).toBe('token_expired');
    const fresh = await tokens.issueTokens({ ...user, scopes: ['profile'] });
    await tokens.revokeDevice(user.deviceId);
    expect(await codeOf(fresh.access_token)).toBe('device_revoked');
    await app.close();
  });

  it('are one invalid_grant body for unknown, malformed, expired and revoked refresh tokens', async () => {
    const { tokens, store, clock } = memoryTokens();
    const { app } = await authApp(tokens);
    const user = memoryUser(store);
    const expired = (await tokens.issueTokens({ ...user, scopes: ['profile'] })).refresh_token;
    clock.advance(31 * DAY_MS);
    const revokedFamily = (await tokens.issueTokens({ ...user, scopes: ['profile'] }))
      .refresh_token;
    await tokens.revokeRefreshToken(revokedFamily, user.userId);
    const candidates = ['A'.repeat(43), 'short', 'x'.repeat(500), expired, revokedFamily];
    const bodies = await Promise.all(
      candidates.map(async (token) => {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/auth/token',
          payload: { grant_type: 'refresh_token', refresh_token: token, client_id: 'centcom-cli' },
        });
        expect(res.statusCode).toBe(400);
        return stable(res.json<Record<string, unknown>>());
      }),
    );
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({
      code: 'invalid_grant',
      detail: 'The refresh token is not valid.',
    });
    await app.close();
  });
});
