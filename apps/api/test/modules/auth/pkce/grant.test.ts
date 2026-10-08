/**
 * The `authorization_code` grant at `POST /v1/auth/token` (B018 acceptance 3 and 5): the happy
 * path with the RFC 7636 Appendix B pair, a code that works exactly once and whose replay revokes
 * the access and refresh tokens it issued (also when two exchanges race), a flipped verifier,
 * missing or malformed fields, and log lines that never hold a code, verifier or token.
 */
import { describe, expect, it } from 'vitest';
import {
  authorizeParams,
  exchange,
  issueCode,
  pkceApp,
  pkcePair,
  tokenRequest,
  whoAmI,
} from './helpers.js';

const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const redirectUri = 'http://127.0.0.1:53682/callback';

describe('grant_type=authorization_code', () => {
  it('exchanges a code made for the RFC 7636 Appendix B challenge', async () => {
    const h = await pkceApp();
    const { code, userId } = await issueCode(h.app, authorizeParams(RFC_CHALLENGE));
    const res = await exchange(h.app, { code, verifier: RFC_VERIFIER, redirectUri });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 900, user: userId });
    expect(body['refresh_token']).toEqual(expect.any(String));
    expect(body['device']).toBeUndefined();
    const me = await whoAmI(h.app, String(body['access_token']));
    expect(me.json()).toEqual({ user: userId });
    await h.app.close();
  });

  it('works exactly once: a second exchange fails and revokes what the first issued', async () => {
    const h = await pkceApp();
    const pair = pkcePair();
    const { code } = await issueCode(h.app, authorizeParams(pair.challenge));
    const first = await exchange(h.app, { code, verifier: pair.verifier, redirectUri });
    expect(first.statusCode).toBe(200);
    const tokens = first.json<{ access_token: string; refresh_token: string }>();
    expect((await whoAmI(h.app, tokens.access_token)).statusCode).toBe(200);

    const second = await exchange(h.app, { code, verifier: pair.verifier, redirectUri });
    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({ code: 'invalid_grant' });

    const me = await whoAmI(h.app, tokens.access_token);
    expect(me.statusCode).toBe(401);
    expect(me.json()).toMatchObject({ code: 'token_revoked' });
    const refresh = await tokenRequest(h.app, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: 'centcom-cli',
    });
    expect(refresh.statusCode).toBe(400);
    expect(refresh.json()).toMatchObject({ code: 'invalid_grant' });
    const warning = h.captured
      .lines()
      .find((l) => String(l['msg']).startsWith('auth.code_reuse_detected'));
    expect(warning).toMatchObject({ client_id: 'centcom-cli', revoked: true });
    await h.app.close();
  });

  it('lets no racing exchange keep working tokens', async () => {
    const h = await pkceApp();
    const pair = pkcePair();
    const { code } = await issueCode(h.app, authorizeParams(pair.challenge));
    const results = await Promise.all(
      [1, 2, 3].map(() => exchange(h.app, { code, verifier: pair.verifier, redirectUri })),
    );
    const ok = results.filter((r) => r.statusCode === 200);
    expect(ok.length).toBeLessThanOrEqual(1);
    for (const res of results.filter((r) => r.statusCode !== 200)) {
      expect(res.json()).toMatchObject({ code: 'invalid_grant' });
    }
    for (const res of ok) {
      expect(
        (await whoAmI(h.app, res.json<{ access_token: string }>().access_token)).statusCode,
      ).toBe(401);
    }
    await h.app.close();
  });

  it('rejects a verifier with one character flipped', async () => {
    const h = await pkceApp();
    const { code } = await issueCode(h.app, authorizeParams(RFC_CHALLENGE));
    const flipped = `${RFC_VERIFIER.slice(0, 10)}${RFC_VERIFIER[10] === 'A' ? 'B' : 'A'}${RFC_VERIFIER.slice(11)}`;
    const res = await exchange(h.app, { code, verifier: flipped, redirectUri });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_grant' });
    await h.app.close();
  });

  it('answers a code it never issued with invalid_grant', async () => {
    const h = await pkceApp();
    const res = await exchange(h.app, {
      code: 'A'.repeat(43),
      verifier: RFC_VERIFIER,
      redirectUri,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_grant' });
    await h.app.close();
  });

  it.each([
    ['no code', { code: undefined }],
    ['an empty code', { code: '' }],
    ['no code_verifier', { code_verifier: undefined }],
    ['a code_verifier of 42 characters', { code_verifier: 'a'.repeat(42) }],
    ['a code_verifier of 129 characters', { code_verifier: 'a'.repeat(129) }],
    ['no redirect_uri', { redirect_uri: undefined }],
  ])('answers %s with invalid_request, leaving the code usable', async (_case, overrides) => {
    const h = await pkceApp();
    const pair = pkcePair();
    const { code } = await issueCode(h.app, authorizeParams(pair.challenge));
    const body: Record<string, unknown> = {
      grant_type: 'authorization_code',
      code,
      code_verifier: pair.verifier,
      redirect_uri: redirectUri,
      client_id: 'centcom-cli',
      ...overrides,
    };
    const bad = await tokenRequest(
      h.app,
      Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)),
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'invalid_request' });
    const good = await exchange(h.app, { code, verifier: pair.verifier, redirectUri });
    expect(good.statusCode).toBe(200);
    await h.app.close();
  });

  it('never logs a code, verifier or token', async () => {
    const h = await pkceApp();
    const pair = pkcePair();
    const { code } = await issueCode(h.app, authorizeParams(pair.challenge));
    const first = await exchange(h.app, { code, verifier: pair.verifier, redirectUri });
    await exchange(h.app, { code, verifier: pair.verifier, redirectUri });
    const { access_token: access, refresh_token: refresh } = first.json<Record<string, string>>();
    const raw = h.captured.raw();
    expect(raw).toContain('auth.code_reuse_detected');
    for (const secret of [code, pair.verifier, pair.challenge, access, refresh]) {
      expect(raw).not.toContain(String(secret));
    }
    await h.app.close();
  });
});
