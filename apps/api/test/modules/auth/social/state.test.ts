/**
 * OAuth state (B015 acceptance 1 and 2, card test state.test.ts): `begin` builds authorize URLs
 * with PKCE S256, a random `state` and (Google) a `nonce`, different every time; the state cookie
 * is signed, expires after 10 minutes and resists tampering; a callback with a missing,
 * mismatched or expired state is refused before anything else happens.
 */
import { Secret } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  clearStateCookieHeader,
  GITHUB,
  GOOGLE,
  newOAuthState,
  openState,
  pkceChallenge,
  readCookie,
  sameState,
  sealState,
  STATE_TTL_MS,
  stateCookieHeader,
} from '../../../../src/modules/auth/social/index.js';
import {
  APP,
  begun,
  GITHUB_CLIENT,
  GOOGLE_CLIENT,
  runtimeSecret,
  socialService,
  T0,
} from './helpers.js';

const secret = new Secret(runtimeSecret('state-secret-0123456789'));

describe('begin', () => {
  it('builds a GitHub authorize URL with PKCE S256 and a random state (acceptance 1)', async () => {
    const { service, providers } = socialService();
    const { redirect, cookie } = await begun(service, providers, 'github');
    expect(`${redirect.origin}${redirect.pathname}`).toBe(GITHUB.authorize);
    const params = Object.fromEntries(redirect.searchParams);
    expect(params).toMatchObject({
      client_id: GITHUB_CLIENT,
      redirect_uri: 'https://api.centcom.test/login/github/callback',
      scope: 'read:user user:email',
      code_challenge_method: 'S256',
    });
    expect(params['state']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = openState(cookie, testSecretOf(service), T0);
    expect(params['code_challenge']).toBe(pkceChallenge(state?.verifier ?? ''));
    expect(params['state']).toBe(state?.state);
    expect(redirect.searchParams.has('nonce')).toBe(false);
  });

  it('adds a nonce for Google, and gives new values on every call (acceptance 1)', async () => {
    const { service, providers } = socialService();
    const first = await begun(service, providers, 'google');
    const second = await begun(service, providers, 'google');
    expect(`${first.redirect.origin}${first.redirect.pathname}`).toBe(GOOGLE.authorize);
    expect(Object.fromEntries(first.redirect.searchParams)).toMatchObject({
      client_id: GOOGLE_CLIENT,
      response_type: 'code',
      scope: 'openid email profile',
      code_challenge_method: 'S256',
    });
    for (const param of ['state', 'nonce', 'code_challenge']) {
      expect(first.redirect.searchParams.get(param)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first.redirect.searchParams.get(param)).not.toBe(
        second.redirect.searchParams.get(param),
      );
    }
    expect(first.cookie).not.toBe(second.cookie);
  });

  it('refuses a provider that is not configured', async () => {
    const { service } = socialService({ config: { ...socialService().config, providers: {} } });
    await expect(service.begin('github', APP)).rejects.toMatchObject({ reason: 'denied' });
  });
});

/** The state secret the service was configured with. */
function testSecretOf(service: unknown): Secret {
  return (service as { config: { stateSecret: Secret } }).config.stateSecret;
}

describe('the state cookie', () => {
  it('opens what it sealed, until 10 minutes have passed', () => {
    const state = newOAuthState('google', APP, T0);
    const sealed = sealState(state, secret);
    expect(openState(sealed, secret, T0)).toEqual(state);
    expect(openState(sealed, secret, T0 + STATE_TTL_MS - 1)).toEqual(state);
    expect(openState(sealed, secret, T0 + STATE_TTL_MS)).toBeUndefined();
    expect(STATE_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('refuses a tampered payload, a forged signature, another key and malformed values', () => {
    const sealed = sealState(newOAuthState('github', APP, T0), secret);
    const [payload, mac] = sealed.split('.');
    const altered = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()),
        returnTo: 'https://evil.example/',
      }),
    ).toString('base64url');
    for (const bad of [
      `${altered}.${mac}`,
      `${payload}.${(mac ?? '').slice(1)}A`,
      `${payload}.`,
      payload,
      `${payload}.${mac}.extra`,
      'not-a-state',
      '',
      `${Buffer.from('[]').toString('base64url')}.${mac}`,
      'x'.repeat(5000),
    ]) {
      expect(openState(bad, secret, T0), String(bad).slice(0, 40)).toBeUndefined();
    }
    expect(
      openState(sealed, new Secret(runtimeSecret('another-key-0123456789')), T0),
    ).toBeUndefined();
    expect(openState(undefined, secret, T0)).toBeUndefined();
  });

  it('is HttpOnly, SameSite=Lax, scoped to /login, 10 minutes, Secure unless told otherwise', () => {
    expect(stateCookieHeader('v', true)).toBe(
      'centcom_oauth=v; Path=/login; Max-Age=600; HttpOnly; SameSite=Lax; Secure',
    );
    expect(stateCookieHeader('v', false)).not.toContain('Secure');
    expect(clearStateCookieHeader(true)).toBe(
      'centcom_oauth=; Path=/login; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    );
  });

  it('is read from a Cookie header among others', () => {
    expect(readCookie('a=1; centcom_oauth=abc.def; b=2', 'centcom_oauth')).toBe('abc.def');
    expect(readCookie('centcom_oauthx=1', 'centcom_oauth')).toBeUndefined();
    expect(readCookie(undefined, 'centcom_oauth')).toBeUndefined();
    expect(sameState('abc', 'abc')).toBe(true);
    expect(sameState('abc', 'abd')).toBe(false);
    expect(sameState('abc', 'abcd')).toBe(false);
  });
});

describe('a callback with a bad state (acceptance 2)', () => {
  it.each([
    ['no cookie', (c: string) => ({ cookie: undefined as string | undefined, state: c })],
    ['a mismatched state', () => ({ cookie: 'use-real', state: 'another-state' })],
    ['no state', () => ({ cookie: 'use-real', state: undefined as string | undefined })],
  ])('is refused with %s, and no user is created', async (_label, make) => {
    const { service, providers, users, identities } = socialService();
    const { cookie, state } = await begun(service, providers, 'github');
    const given = make(state);
    const err = await service
      .complete(
        'github',
        { code: 'code-1', state: given.state },
        given.cookie === 'use-real' ? cookie : given.cookie,
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'state' });
    expect(providers.calls).toEqual([]);
    expect(users.users.size).toBe(0);
    expect(identities.rows.size).toBe(0);
  });

  it('is refused after 10 minutes, and for the cookie of another provider', async () => {
    const { service, providers, users, clock } = socialService();
    const github = await begun(service, providers, 'github');
    await expect(
      service.complete('google', { code: 'c', state: github.state }, github.cookie),
    ).rejects.toMatchObject({
      reason: 'state',
    });
    clock.advance(STATE_TTL_MS);
    await expect(
      service.complete('github', { code: 'c', state: github.state }, github.cookie),
    ).rejects.toMatchObject({
      reason: 'state',
    });
    expect(providers.calls).toEqual([]);
    expect(users.users.size).toBe(0);
  });
});
