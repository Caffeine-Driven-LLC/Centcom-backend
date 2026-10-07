/**
 * GitHub sign-in (B015 acceptance 4 and 8, card test github.test.ts): the e-mail rules with
 * canned responses (only the primary address, only when verified), the code exchange with PKCE,
 * refusals and failures, and the 5 s limit on provider calls.
 */
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_TIMEOUT_MS,
  primaryVerifiedEmail,
} from '../../../../src/modules/auth/social/index.js';
import { begun, socialService } from './helpers.js';

describe('primaryVerifiedEmail', () => {
  it.each([
    ['a verified primary', [{ email: 'a@x.test', primary: true, verified: true }], 'a@x.test'],
    [
      'only unverified addresses',
      [
        { email: 'a@x.test', primary: true, verified: false },
        { email: 'b@x.test', primary: false, verified: false },
      ],
      undefined,
    ],
    [
      'a verified secondary but an unverified primary',
      [
        { email: 'a@x.test', primary: true, verified: false },
        { email: 'b@x.test', primary: false, verified: true },
      ],
      undefined,
    ],
    ['no addresses', [], undefined],
    [
      'a verified primary among others',
      [
        { email: 'b@x.test', primary: false, verified: true },
        { email: 'a@x.test', primary: true, verified: true },
      ],
      'a@x.test',
    ],
    [
      'malformed entries',
      [
        null,
        'a@x.test',
        { email: '', primary: true, verified: true },
        { email: 7, primary: true, verified: true },
      ],
      undefined,
    ],
    ['not a list', { email: 'a@x.test' }, undefined],
  ])('with %s gives %j', (_label, emails, expected) => {
    expect(primaryVerifiedEmail(emails)).toBe(expected);
  });
});

describe('GitHub login', () => {
  it('logs in with the verified primary address, exchanging the code with PKCE and the client secret (acceptance 4)', async () => {
    const { service, providers, users, config } = socialService();
    const { state, cookie } = await begun(service, providers, 'github');
    const done = await service.complete('github', { code: 'gh-code', state }, cookie);
    expect(done.created).toBe(true);
    expect(users.users.get('octo@example.test')).toMatchObject({
      id: done.userId,
      display_name: 'Octo Cat',
    });
    expect(providers.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://github.com/login/oauth/access_token',
      'GET https://api.github.com/user',
      'GET https://api.github.com/user/emails',
    ]);
    const exchange = new URLSearchParams(providers.calls[0]?.body);
    expect(exchange.get('code')).toBe('gh-code');
    expect(exchange.get('client_secret')).toBe(config.secrets[0]);
    expect(exchange.get('redirect_uri')).toBe('https://api.centcom.test/login/github/callback');
    expect(exchange.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(providers.calls[1]?.authorization).toMatch(/^Bearer gh-access-/);
  });

  it('refuses an account whose only addresses are unverified, creating nobody (acceptance 4)', async () => {
    const { service, providers, users, identities } = socialService();
    providers.github.emails = [{ email: 'octo@example.test', primary: true, verified: false }];
    const { state, cookie } = await begun(service, providers, 'github');
    await expect(service.complete('github', { code: 'c', state }, cookie)).rejects.toMatchObject({
      reason: 'no_verified_email',
    });
    expect(users.users.size).toBe(0);
    expect(identities.rows.size).toBe(0);
  });

  it('uses the login as the display name when the account has no name', async () => {
    const { service, providers, users } = socialService();
    providers.github.user = { id: 7, login: 'octo-login', name: null };
    const { state, cookie } = await begun(service, providers, 'github');
    await service.complete('github', { code: 'c', state }, cookie);
    expect(users.users.get('octo@example.test')?.display_name).toBe('octo-login');
  });

  it.each([
    [
      'a refused exchange (200 with error)',
      (p: ReturnType<typeof socialService>['providers']) =>
        void (p.github.token = { error: 'bad_verification_code' }),
      'denied',
    ],
    [
      'a 401 from the token endpoint',
      (p: ReturnType<typeof socialService>['providers']) => void (p.github.tokenStatus = 401),
      'denied',
    ],
    [
      'a 502 from the token endpoint',
      (p: ReturnType<typeof socialService>['providers']) => void (p.github.tokenStatus = 502),
      'provider',
    ],
    [
      'a user without an id',
      (p: ReturnType<typeof socialService>['providers']) => void (p.github.user = { login: 'x' }),
      'invalid_identity',
    ],
    [
      'an id that is not a number',
      (p: ReturnType<typeof socialService>['providers']) => void (p.github.user = { id: '42' }),
      'invalid_identity',
    ],
  ])('fails on %s (%s)', async (_label, breakIt, reason) => {
    const { service, providers, users } = socialService();
    breakIt(providers);
    const { state, cookie } = await begun(service, providers, 'github');
    await expect(service.complete('github', { code: 'c', state }, cookie)).rejects.toMatchObject({
      reason,
    });
    expect(users.users.size).toBe(0);
  });

  it('gives up on a provider after the time limit, with no account change (acceptance 8)', async () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(5_000);
    const { service, providers, users, identities } = socialService({ timeoutMs: 50 });
    providers.hang.add('api.github.com');
    const { state, cookie } = await begun(service, providers, 'github');
    const started = performance.now();
    await expect(service.complete('github', { code: 'c', state }, cookie)).rejects.toMatchObject({
      reason: 'provider',
    });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(users.users.size).toBe(0);
    expect(identities.rows.size).toBe(0);
  });

  it('refuses a callback carrying the provider’s error (the user declined), and one without a code', async () => {
    const { service, providers } = socialService();
    const first = await begun(service, providers, 'github');
    await expect(
      service.complete('github', { error: 'access_denied', state: first.state }, first.cookie),
    ).rejects.toMatchObject({
      reason: 'denied',
    });
    const second = await begun(service, providers, 'github');
    await expect(
      service.complete('github', { state: second.state }, second.cookie),
    ).rejects.toMatchObject({ reason: 'denied' });
    expect(providers.calls).toEqual([]);
  });
});
