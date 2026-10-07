/**
 * `return_to` and configuration (B015, card test redirect.test.ts; failure mode "client secret
 * missing"): only exact allow-list entries are honoured, everything else becomes the default; the
 * allow-list and the rest of the configuration are checked at startup; a provider without its
 * client id or secret is off, with a warning.
 */
import { ConfigError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { returnToAllowlistSchema, returnToPolicy } from '../../../../src/modules/auth/return-to.js';
import { loadSocialConfig } from '../../../../src/modules/auth/social/index.js';
import { APP, begun, runtimeSecret, SETTINGS, socialService } from './helpers.js';

describe('return_to', () => {
  const policy = returnToPolicy([APP, SETTINGS]);

  it('honours exact allow-list entries', () => {
    expect(policy.resolve(APP)).toBe(APP);
    expect(policy.resolve(SETTINGS)).toBe(SETTINGS);
    expect(policy.fallback).toBe(APP);
  });

  it.each([
    ['//evil.example'],
    ['javascript:alert(1)'],
    ['https://evil.example/'],
    ['https://app.centcom.test.evil.example/'],
    ['https://app.centcom.test/settings/extra'],
    ['https://app.centcom.test/settings?x=1'],
    ['/settings'],
    ['HTTPS://APP.CENTCOM.TEST/'],
    [''],
    [undefined],
    [42],
    [[APP]],
  ])('replaces %j with the default', (candidate) => {
    expect(policy.resolve(candidate)).toBe(APP);
  });

  it('carries the resolved return_to through the login', async () => {
    const { service, providers } = socialService();
    const kept = await begun(service, providers, 'github', SETTINGS);
    expect(
      (await service.complete('github', { code: 'c', state: kept.state }, kept.cookie)).returnTo,
    ).toBe(SETTINGS);
    const replaced = await begun(service, providers, 'github', '//evil.example');
    expect(
      (await service.complete('github', { code: 'c', state: replaced.state }, replaced.cookie))
        .returnTo,
    ).toBe(APP);
  });

  it('checks the allow-list: absolute http(s) URLs only, 1 to 32 of them', () => {
    expect(returnToAllowlistSchema.parse(` ${APP} , ${SETTINGS} ,`)).toEqual([APP, SETTINGS]);
    for (const bad of [
      '',
      ' , ',
      '/relative',
      'javascript:alert(1)',
      'ftp://x.test/',
      'https://user:pw@x.test/',
      'https://x.test/#frag',
    ]) {
      expect(returnToAllowlistSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(
      returnToAllowlistSchema.safeParse(
        Array.from({ length: 33 }, (_, i) => `https://x.test/${i}`).join(','),
      ).success,
    ).toBe(false);
    expect(() => returnToPolicy([])).toThrow(TypeError);
  });
});

describe('loadSocialConfig', () => {
  const base = () => ({
    SOCIAL_REDIRECT_BASE_URL: 'https://api.centcom.test/',
    SOCIAL_STATE_SECRET: runtimeSecret('state-0123456789abcdef'),
    LOGIN_RETURN_TO_ALLOWLIST: `${APP},${SETTINGS}`,
  });

  it('turns on the providers that have both id and secret, warning about the others (failure mode)', () => {
    const warnings: string[] = [];
    const gh = runtimeSecret('gh');
    const config = loadSocialConfig(
      {
        ...base(),
        GITHUB_CLIENT_ID: 'gh-id',
        GITHUB_CLIENT_SECRET: gh,
        GOOGLE_CLIENT_ID: 'only-an-id',
      },
      (w) => warnings.push(w),
    );
    expect(Object.keys(config.providers)).toEqual(['github']);
    expect(config.providers.github?.clientSecret.reveal()).toBe(gh);
    expect(config.redirectBaseUrl).toBe('https://api.centcom.test');
    expect(config.returnTo.fallback).toBe(APP);
    expect(warnings).toEqual([
      'social login: google is off (its client id or secret is not configured)',
    ]);
    expect(warnings.join(' ')).not.toContain(gh);
  });

  it('refuses a short state secret, a bad base URL and a bad allow-list, without echoing them', () => {
    const shortSecret = 'too-short';
    let err: unknown;
    try {
      loadSocialConfig({
        SOCIAL_REDIRECT_BASE_URL: 'api.centcom.test',
        SOCIAL_STATE_SECRET: shortSecret,
        LOGIN_RETURN_TO_ALLOWLIST: 'nope',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).issues.map((i) => i.key).sort()).toEqual([
      'LOGIN_RETURN_TO_ALLOWLIST',
      'SOCIAL_REDIRECT_BASE_URL',
      'SOCIAL_STATE_SECRET',
    ]);
    expect((err as Error).message).not.toContain(shortSecret);
  });
});
