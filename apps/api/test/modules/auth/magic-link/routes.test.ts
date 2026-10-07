/**
 * The e-mail sign-in routes and configuration (B014): a completer that answers itself (as B018's
 * web session will), the mail's locale from Accept-Language, cookies without `Secure` for
 * http://localhost development, and MAGIC_LINK_TTL_S, MAGIC_LINK_BASE_URL and
 * LOGIN_RETURN_TO_ALLOWLIST.
 */
import { ConfigError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { loadMagicLinkConfig } from '../../../../src/modules/auth/magic-link/config.js';
import { csrfFor } from '../../../../src/routes/login-email.js';
import { magicLinkApp, nonceOf, requestLink, tokenOf, useLink } from './helpers.js';

describe('the routes', () => {
  it('leave the answer to a completer that sends one', async () => {
    const { app, service, mailer } = await magicLinkApp({ completerSends: true });
    const nonce = nonceOf(await requestLink(app, 'ada@example.test'));
    await service.idle();
    const response = await useLink(app, tokenOf(mailer.sent[0]?.link ?? ''), nonce, csrfFor(nonce));
    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe('https://app.centcom.test/#signed-in');
  });

  it('mail in the browser’s first language, or English when it is not a language tag', async () => {
    const { app, service, mailer } = await magicLinkApp();
    for (const [header, ip] of [
      ['fr-FR,fr;q=0.9,en;q=0.8', '198.51.100.1'],
      ['*', '198.51.100.2'],
      ['', '198.51.100.3'],
    ] as const) {
      await app.inject({
        method: 'POST',
        url: '/login/email',
        remoteAddress: ip,
        headers: { 'content-type': 'application/json', 'accept-language': header },
        payload: { email: `user-${ip}@example.test` },
      });
    }
    await requestLink(app, 'plain@example.test', { ip: '198.51.100.4' });
    await service.idle();
    expect(mailer.sent.map((m) => m.locale)).toEqual(['fr-FR', 'en', 'en', 'en']);
  });

  it('can leave Secure off the cookie, for http://localhost development', async () => {
    const { app } = await magicLinkApp({ secureCookies: false });
    const response = await requestLink(app, 'ada@example.test');
    expect(String(response.headers['set-cookie'])).not.toContain('Secure');
  });
});

describe('loadMagicLinkConfig', () => {
  const env = {
    MAGIC_LINK_BASE_URL: 'https://api.centcom.test//',
    LOGIN_RETURN_TO_ALLOWLIST: 'https://app.centcom.test/, https://app.centcom.test/settings',
  };

  it('reads the base URL without trailing slashes, the allow-list, and 15 minutes by default', () => {
    const config = loadMagicLinkConfig(env);
    expect(config.ttlS).toBe(900);
    expect(config.baseUrl).toBe('https://api.centcom.test');
    expect(config.returnTo.fallback).toBe('https://app.centcom.test/');
    expect(config.returnTo.resolve('https://app.centcom.test/settings')).toBe(
      'https://app.centcom.test/settings',
    );
    expect(loadMagicLinkConfig({ ...env, MAGIC_LINK_TTL_S: '600' }).ttlS).toBe(600);
  });

  it.each([
    [{ ...env, MAGIC_LINK_TTL_S: '30' }, 'MAGIC_LINK_TTL_S'],
    [{ ...env, MAGIC_LINK_BASE_URL: 'https://api.centcom.test/?x=1' }, 'MAGIC_LINK_BASE_URL'],
    [{ LOGIN_RETURN_TO_ALLOWLIST: env.LOGIN_RETURN_TO_ALLOWLIST }, 'MAGIC_LINK_BASE_URL'],
    [{ ...env, LOGIN_RETURN_TO_ALLOWLIST: 'javascript:alert(1)' }, 'LOGIN_RETURN_TO_ALLOWLIST'],
  ])('refuses %j at startup, naming %s', (values, key) => {
    let error: unknown;
    try {
      loadMagicLinkConfig(values);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues.map((i) => i.key)).toContain(key);
  });
});
