/**
 * `GET /v1/auth/authorize` (B018 acceptance 1, 2, 8 and 9; tests "authorize.test.ts"): the code
 * redirect with `state` echoed unchanged, the allow-list matrix over HTTP, missing and invalid
 * parameters (an error response, never a redirect, and no code issued), the login redirect with a
 * signed `return_to` (tampered, expired or foreign ones open to null), a login session that ends
 * mid-flow, scopes, and the `auth` rate-limit bucket.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTHORIZE_PATH,
  DEFAULT_SCOPE,
  MAX_RETURN_TO_PATH_LENGTH,
  MAX_STATE_LENGTH,
  openReturnTo,
  RETURN_TO_TTL_S,
  signReturnTo,
} from '../../../../src/modules/auth/pkce/authorize.js';
import { signAccessToken } from '../../../../src/modules/auth/tokens/jwt.js';
import { LOGIN_SESSION_TTL_MS } from '../../../../src/modules/auth/web-session/store.js';
import {
  authorize,
  authorizeParams,
  authorizeUrl,
  codeOf,
  DESKTOP_CALLBACK,
  exchange,
  issueCode,
  login,
  LOGIN_URL,
  newId,
  pkceApp,
  pkcePair,
  WEB_CALLBACK,
} from './helpers.js';

/** Code records written so far. */
const codeWrites = (h: Awaited<ReturnType<typeof pkceApp>>): number =>
  h.kv.writes.filter((w) => w.key.startsWith('auth:code:')).length;

describe('GET /v1/auth/authorize, signed in', () => {
  it('redirects to the redirect_uri with a code and state echoed unchanged', async () => {
    const h = await pkceApp();
    const { challenge } = pkcePair();
    const cookie = await login(h.app, newId('usr'));
    const state = 'a b+c/d?e=f&g#h%20ü=';
    const res = await authorize(h.app, authorizeParams(challenge, { state }), cookie);
    expect(res.statusCode).toBe(302);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const location = new URL(String(res.headers['location']));
    expect(`${location.origin}${location.pathname}`).toBe('http://127.0.0.1:53682/callback');
    expect([...location.searchParams.keys()]).toEqual(['code', 'state']);
    expect(location.searchParams.get('state')).toBe(state);
    expect(decodeURIComponent(location.search.split('&state=')[1] ?? '')).toBe(state);
    expect(codeOf(res)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await h.app.close();
  });

  it('sends the desktop client to centcom://auth/callback', async () => {
    const h = await pkceApp();
    const cookie = await login(h.app, newId('usr'));
    const res = await authorize(
      h.app,
      authorizeParams(pkcePair().challenge, { redirect_uri: DESKTOP_CALLBACK }),
      cookie,
    );
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'])).toMatch(/^centcom:\/\/auth\/callback\?code=/);
    await h.app.close();
  });

  it('ignores parameters it does not know (device_name, device_pubkeys)', async () => {
    const h = await pkceApp();
    const cookie = await login(h.app, newId('usr'));
    const params = authorizeParams(pkcePair().challenge, { device_name: 'Laptop' });
    const res = await authorize(h.app, params, cookie);
    expect(res.statusCode).toBe(302);
    await h.app.close();
  });

  it('binds the default scope, or the scope asked for', async () => {
    const h = await pkceApp();
    const pair = pkcePair();
    const redirectUri = 'http://127.0.0.1:53682/callback';
    const plain = await issueCode(h.app, authorizeParams(pair.challenge));
    const res = await exchange(h.app, { code: plain.code, verifier: pair.verifier, redirectUri });
    expect(res.json()).toMatchObject({ scope: DEFAULT_SCOPE });
    const narrow = await issueCode(
      h.app,
      authorizeParams(pair.challenge, { scope: 'profile workspaces:write' }),
    );
    const res2 = await exchange(h.app, { code: narrow.code, verifier: pair.verifier, redirectUri });
    expect(res2.json()).toMatchObject({ scope: 'profile workspaces:write' });
    await h.app.close();
  });
});

describe('GET /v1/auth/authorize, errors', () => {
  const { challenge } = pkcePair();

  it.each([
    ['no response_type', { response_type: undefined }, 400, 'invalid_request'],
    ['response_type token (implicit)', { response_type: 'token' }, 400, 'invalid_request'],
    ['no client_id', { client_id: undefined }, 401, 'invalid_client'],
    ['an unknown client_id', { client_id: 'evil-cli' }, 401, 'invalid_client'],
    ['no redirect_uri', { redirect_uri: undefined }, 400, 'invalid_request'],
    ['code_challenge_method plain', { code_challenge_method: 'plain' }, 400, 'invalid_request'],
    ['no code_challenge_method', { code_challenge_method: undefined }, 400, 'invalid_request'],
    ['code_challenge_method s256', { code_challenge_method: 's256' }, 400, 'invalid_request'],
    ['no code_challenge', { code_challenge: undefined }, 400, 'invalid_request'],
    ['a short code_challenge', { code_challenge: challenge.slice(1) }, 400, 'invalid_request'],
    ['a padded code_challenge', { code_challenge: `${challenge}=` }, 400, 'invalid_request'],
    ['no state', { state: undefined }, 400, 'invalid_request'],
    ['an empty state', { state: '' }, 400, 'invalid_request'],
    ['a state too long', { state: 's'.repeat(MAX_STATE_LENGTH + 1) }, 400, 'invalid_request'],
    ['an unknown scope', { scope: 'profile root' }, 400, 'invalid_scope'],
    ['the internal admin scope', { scope: 'profile admin' }, 400, 'invalid_scope'],
    ['a repeated scope', { scope: 'profile profile' }, 400, 'invalid_scope'],
    ['an empty scope', { scope: '' }, 400, 'invalid_scope'],
    ['a double space in scope', { scope: 'profile  billing:read' }, 400, 'invalid_scope'],
  ])('answers %s with an error and no redirect or code', async (_case, overrides, status, code) => {
    const h = await pkceApp();
    const cookie = await login(h.app, newId('usr'));
    const res = await authorize(h.app, authorizeParams(challenge, overrides), cookie);
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ code });
    expect(res.headers['location']).toBeUndefined();
    expect(codeWrites(h)).toBe(0);
    await h.app.close();
  });

  it.each([
    ['one character changed', 'http://127.0.0.1:53682/callbacc'],
    ['a trailing slash', 'http://127.0.0.1:53682/callback/'],
    ['an added query', 'http://127.0.0.1:53682/callback?next=/'],
    ['another host', 'http://127.0.0.2:53682/callback'],
    ['an attacker', 'https://evil.test/callback'],
    ['another client', WEB_CALLBACK],
  ])('refuses a redirect_uri with %s, without redirecting', async (_case, redirectUri) => {
    const h = await pkceApp();
    const cookie = await login(h.app, newId('usr'));
    const res = await authorize(
      h.app,
      authorizeParams(challenge, { redirect_uri: redirectUri }),
      cookie,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_request' });
    expect(res.headers['location']).toBeUndefined();
    expect(codeWrites(h)).toBe(0);
    await h.app.close();
  });

  it('accepts centcom://auth/callback only for clients that list it', async () => {
    const h = await pkceApp();
    const cookie = await login(h.app, newId('usr'));
    const web = await authorize(
      h.app,
      authorizeParams(challenge, { client_id: 'centcom-web', redirect_uri: DESKTOP_CALLBACK }),
      cookie,
    );
    expect(web.statusCode).toBe(400);
    const tui = await authorize(
      h.app,
      authorizeParams(challenge, { client_id: 'centcom-tui', redirect_uri: DESKTOP_CALLBACK }),
      cookie,
    );
    expect(tui.statusCode).toBe(400);
    const cli = await authorize(
      h.app,
      authorizeParams(challenge, { redirect_uri: DESKTOP_CALLBACK }),
      cookie,
    );
    expect(cli.statusCode).toBe(302);
    await h.app.close();
  });

  it('refuses a repeated parameter, even with a bad redirect_uri in the copy', async () => {
    const h = await pkceApp();
    const cookie = await login(h.app, newId('usr'));
    const url = `${authorizeUrl(authorizeParams(challenge))}&redirect_uri=https%3A%2F%2Fevil.test%2F`;
    const res = await h.app.inject({ method: 'GET', url, headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.headers['location']).toBeUndefined();
    await h.app.close();
  });

  it('checks the request before sending anyone to the login page', async () => {
    const h = await pkceApp();
    const res = await authorize(
      h.app,
      authorizeParams(challenge, { code_challenge_method: 'plain' }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.headers['location']).toBeUndefined();
    await h.app.close();
  });
});

describe('GET /v1/auth/authorize, not signed in', () => {
  it('redirects to the login page with a signed return_to that leads back here', async () => {
    const h = await pkceApp();
    const params = authorizeParams(pkcePair().challenge);
    const res = await authorize(h.app, params);
    expect(res.statusCode).toBe(302);
    expect(res.headers['set-cookie']).toBeUndefined();
    const location = new URL(String(res.headers['location']));
    expect(`${location.origin}${location.pathname}`).toBe(LOGIN_URL);
    const returnTo = location.searchParams.get('return_to') ?? '';
    expect(await openReturnTo(h.keys, returnTo, h.clock.now())).toBe(authorizeUrl(params));
    expect(codeWrites(h)).toBe(0);
    await h.app.close();
  });

  it('opens no tampered, expired or foreign return_to', async () => {
    const h = await pkceApp();
    const res = await authorize(h.app, authorizeParams(pkcePair().challenge));
    const returnTo = new URL(String(res.headers['location'])).searchParams.get('return_to') ?? '';
    const [header, payload, signature] = returnTo.split('.') as [string, string, string];
    const evil = Buffer.from(JSON.stringify({ url: '/v1/auth/authorize?x=evil' })).toString(
      'base64url',
    );
    const flipped = `${signature.slice(0, 5)}${signature[5] === 'A' ? 'B' : 'A'}${signature.slice(6)}`;
    for (const tampered of [
      `${header}.${evil}.${signature}`,
      `${header}.${payload}.${flipped}`,
      `${returnTo}x`,
      '',
      'not-a-jwt',
    ]) {
      expect(await openReturnTo(h.keys, tampered, h.clock.now())).toBeNull();
    }
    expect(await openReturnTo(h.keys, 42, h.clock.now())).toBeNull();
    // Expired (one hour, plus the 60 s clock skew).
    const later = h.clock.now() + (RETURN_TO_TTL_S + 61) * 1000;
    expect(await openReturnTo(h.keys, returnTo, later)).toBeNull();
    // Ours, but not a return_to: an access token, or a URL that is not the authorize endpoint.
    const { token } = await signAccessToken(
      h.keys,
      { sub: newId('usr'), scp: 'profile', plan: 'free', ent: 0 },
      h.clock.now(),
    );
    expect(await openReturnTo(h.keys, token, h.clock.now())).toBeNull();
    const elsewhere = await signReturnTo(h.keys, 'https://evil.test/', h.clock.now());
    expect(await openReturnTo(h.keys, elsewhere, h.clock.now())).toBeNull();
    const bare = await signReturnTo(h.keys, AUTHORIZE_PATH, h.clock.now());
    expect(await openReturnTo(h.keys, bare, h.clock.now())).toBeNull();
    await h.app.close();
  });

  it('sends a browser whose login session expired back to login, keeping return_to', async () => {
    const h = await pkceApp();
    const cookie = await login(h.app, newId('usr'));
    h.clock.advance(LOGIN_SESSION_TTL_MS + 1);
    const params = authorizeParams(pkcePair().challenge);
    const res = await authorize(h.app, params, cookie);
    expect(res.statusCode).toBe(302);
    const location = new URL(String(res.headers['location']));
    expect(`${location.origin}${location.pathname}`).toBe(LOGIN_URL);
    const returnTo = location.searchParams.get('return_to');
    expect(await openReturnTo(h.keys, returnTo, h.clock.now())).toBe(authorizeUrl(params));
    await h.app.close();
  });

  it('refuses a request too long to seal into a return_to', async () => {
    const h = await pkceApp();
    const params = authorizeParams(pkcePair().challenge, {
      device_name: 'x'.repeat(MAX_RETURN_TO_PATH_LENGTH),
    });
    const res = await authorize(h.app, params);
    expect(res.statusCode).toBe(400);
    expect(res.headers['location']).toBeUndefined();
    await h.app.close();
  });
});

describe('GET /v1/auth/authorize, rate limit', () => {
  it('counts in the auth bucket: 20 per minute per address', async () => {
    const h = await pkceApp({ rateLimit: true });
    const params = authorizeParams(pkcePair().challenge);
    const first = await authorize(h.app, params);
    expect(first.headers['ratelimit-limit']).toBe('20');
    for (let i = 1; i < 20; i += 1) expect((await authorize(h.app, params)).statusCode).toBe(302);
    const limited = await authorize(h.app, params);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'rate_limited' });
    await h.app.close();
  });
});
