/**
 * The web client at `POST /v1/auth/token` (B018 acceptance 6 and 7; tests "web-cookie.test.ts"):
 * the CSRF header and Origin checks (403 `forbidden`, no cookie, code untouched), the refresh
 * cookie's attributes, a JSON body without `refresh_token`, refresh through the cookie with
 * rotation, a spent cookie cleared, logout clearing cookies, other clients unaffected, and the
 * plugin refusing to start in the wrong order.
 */
import { describe, expect, it } from 'vitest';
import { fastify } from 'fastify';
import {
  clearRefreshCookieHeader,
  REFRESH_COOKIE,
  webTokenCookiePlugin,
} from '../../../../src/modules/auth/web-session/cookies.js';
import { tokenRoutes } from '../../../../src/routes/auth/token.js';
import { memoryTokens } from '../tokens/helpers.js';
import {
  authorize,
  authorizeParams,
  cookieValue,
  exchange,
  issueCode,
  login,
  newId,
  pkceApp,
  pkcePair,
  refreshCookie,
  setCookie,
  setCookies,
  tokenRequest,
  WEB_CALLBACK,
  WEB_HEADERS,
  whoAmI,
} from './helpers.js';

const webParams = (challenge: string): Record<string, string> =>
  authorizeParams(challenge, { client_id: 'centcom-web', redirect_uri: WEB_CALLBACK });

/** A web sign-in up to a code. */
async function webCode(h: Awaited<ReturnType<typeof pkceApp>>) {
  const pair = pkcePair();
  const { code, userId } = await issueCode(h.app, webParams(pair.challenge));
  const fields = {
    code,
    verifier: pair.verifier,
    redirectUri: WEB_CALLBACK,
    clientId: 'centcom-web',
  };
  return { fields, userId };
}

const webRefresh = (
  h: Awaited<ReturnType<typeof pkceApp>>,
  cookie: string | undefined,
  headers: Record<string, string> = WEB_HEADERS,
  extra: Record<string, unknown> = {},
) =>
  tokenRequest(
    h.app,
    { grant_type: 'refresh_token', client_id: 'centcom-web', ...extra },
    { ...headers, ...(cookie === undefined ? {} : { cookie: refreshCookie(cookie) }) },
  );

describe('web token exchange', () => {
  it('sets the refresh cookie and keeps the refresh token out of the JSON', async () => {
    const h = await pkceApp();
    const { fields, userId } = await webCode(h);
    const res = await exchange(h.app, fields, WEB_HEADERS);
    expect(res.statusCode).toBe(200);
    const header = setCookie(res, REFRESH_COOKIE) ?? '';
    const attributes = header.split('; ').slice(1);
    expect(attributes).toEqual(
      expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/v1/auth/token']),
    );
    expect(attributes).toContain('Max-Age=2592000');
    expect(cookieValue(res, REFRESH_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const body = res.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty('refresh_token');
    expect(body).toMatchObject({ token_type: 'Bearer', user: userId });
    expect(res.body).not.toContain(cookieValue(res, REFRESH_COOKIE) ?? '-');
    expect((await whoAmI(h.app, String(body['access_token']))).statusCode).toBe(200);
    await h.app.close();
  });

  it.each([
    ['no X-Centcom-Client header', { origin: WEB_HEADERS.origin }],
    ['another X-Centcom-Client value', { ...WEB_HEADERS, 'x-centcom-client': 'cli' }],
    ['an Origin not allowed', { ...WEB_HEADERS, origin: 'https://evil.test' }],
    ['an Origin with a path', { ...WEB_HEADERS, origin: `${WEB_HEADERS.origin}/` }],
    ['no Origin', { 'x-centcom-client': 'web' }],
    ['the null Origin', { ...WEB_HEADERS, origin: 'null' }],
  ])('refuses %s with 403 forbidden, no cookie, and the code untouched', async (_case, headers) => {
    const h = await pkceApp();
    const { fields } = await webCode(h);
    const res = await exchange(h.app, fields, headers);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'forbidden' });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await exchange(h.app, fields, WEB_HEADERS)).statusCode).toBe(200);
    await h.app.close();
  });

  it('leaves the other clients alone: tokens in the body, no cookie', async () => {
    const h = await pkceApp();
    const pair = pkcePair();
    const { code } = await issueCode(h.app, authorizeParams(pair.challenge));
    const res = await exchange(h.app, {
      code,
      verifier: pair.verifier,
      redirectUri: 'http://127.0.0.1:53682/callback',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.json()).toHaveProperty('refresh_token');
    await h.app.close();
  });
});

describe('web refresh', () => {
  it('refreshes with the cookie and rotates it', async () => {
    const h = await pkceApp();
    const { fields } = await webCode(h);
    const first = cookieValue(await exchange(h.app, fields, WEB_HEADERS), REFRESH_COOKIE);
    const res = await webRefresh(h, first);
    expect(res.statusCode).toBe(200);
    const next = cookieValue(res, REFRESH_COOKIE);
    expect(next).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(next).not.toBe(first);
    expect(setCookie(res, REFRESH_COOKIE)).toContain('Path=/v1/auth/token');
    expect(res.json()).not.toHaveProperty('refresh_token');
    expect((await webRefresh(h, next)).statusCode).toBe(200);
    await h.app.close();
  });

  it('clears the cookie when it was spent (reuse detected)', async () => {
    const h = await pkceApp();
    const { fields } = await webCode(h);
    const first = cookieValue(await exchange(h.app, fields, WEB_HEADERS), REFRESH_COOKIE);
    expect((await webRefresh(h, first)).statusCode).toBe(200);
    const reuse = await webRefresh(h, first);
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json()).toMatchObject({ code: 'refresh_reuse_detected' });
    expect(setCookie(reuse, REFRESH_COOKIE)).toBe(clearRefreshCookieHeader());
    await h.app.close();
  });

  it('refuses a refresh_token parameter from the web client, keeping its cookie', async () => {
    const h = await pkceApp();
    const { fields } = await webCode(h);
    const cookie = cookieValue(await exchange(h.app, fields, WEB_HEADERS), REFRESH_COOKIE);
    const res = await webRefresh(h, cookie, WEB_HEADERS, { refresh_token: cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_request' });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await webRefresh(h, cookie)).statusCode).toBe(200);
    await h.app.close();
  });

  it('answers a refresh without the cookie with invalid_request', async () => {
    const h = await pkceApp();
    const res = await webRefresh(h, undefined);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_request' });
    const empty = await webRefresh(h, '');
    expect(empty.statusCode).toBe(400);
    await h.app.close();
  });

  it('refuses a cookie refresh without the CSRF header or from another origin', async () => {
    const h = await pkceApp();
    const { fields } = await webCode(h);
    const cookie = cookieValue(await exchange(h.app, fields, WEB_HEADERS), REFRESH_COOKIE);
    for (const headers of [
      { origin: WEB_HEADERS.origin },
      { ...WEB_HEADERS, origin: 'https://evil.test' },
    ]) {
      const res = await webRefresh(h, cookie, headers);
      expect(res.statusCode).toBe(403);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect((await webRefresh(h, cookie)).statusCode).toBe(200);
    await h.app.close();
  });
});

describe('logout', () => {
  it('clears the refresh cookie on its path', () => {
    expect(clearRefreshCookieHeader()).toBe(
      'centcom_rt=; Path=/v1/auth/token; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('ends the login session and clears its cookie', async () => {
    const h = await pkceApp();
    const cookie = await login(h.app, newId('usr'));
    const out = await h.app.inject({ method: 'POST', url: '/v1/test/logout', headers: { cookie } });
    expect(setCookies(out)).toEqual([
      'centcom_sid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    ]);
    const res = await authorize(h.app, authorizeParams(pkcePair().challenge), cookie);
    expect(String(res.headers['location'])).toMatch(/^https:\/\/app\.centcom\.test\/login\?/);
    await h.app.close();
  });
});

describe('webTokenCookiePlugin', () => {
  it('refuses to start when registered after the token route', async () => {
    const { tokens } = memoryTokens();
    const app = fastify({ logger: false });
    await app.register(tokenRoutes, { tokens });
    await app.register(webTokenCookiePlugin, { allowedOrigins: new Set(['https://a.test']) });
    await expect(app.ready()).rejects.toThrow(/register it before tokenRoutes/);
  });
});
