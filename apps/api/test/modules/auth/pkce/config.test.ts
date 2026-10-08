/**
 * Configuration and the redirect allow-list (B018 acceptance 2, failure mode "allow-list config
 * invalid -> API refuses to start"): CT-AUTH's defaults, the exact-match matrix, RFC 8252
 * loopback ports, the desktop scheme per client, and a ConfigError for every invalid value.
 */
import { ConfigError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEB_ALLOWED_ORIGINS,
  DEFAULT_WEB_LOGIN_URL,
  loadPkceConfig,
} from '../../../../src/modules/auth/pkce/config.js';
import {
  MAX_REDIRECT_URI_LENGTH,
  readRedirectUris,
  redirectAllowlist,
} from '../../../../src/modules/auth/pkce/redirect-allowlist.js';
import { TEST_ENV } from './helpers.js';

/** The ConfigError `fn` throws. */
function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('no ConfigError');
}

describe('loadPkceConfig', () => {
  it("defaults to CT-AUTH's production values", () => {
    const config = loadPkceConfig({});
    expect(config.loginUrl).toBe(DEFAULT_WEB_LOGIN_URL);
    expect([...config.allowedOrigins]).toEqual([DEFAULT_WEB_ALLOWED_ORIGINS]);
    const { redirects } = config;
    expect(redirects.allows('centcom-web', 'https://app.centcom.dev/auth/callback')).toBe(true);
    expect(redirects.allows('centcom-cli', 'http://127.0.0.1:49152/callback')).toBe(true);
    expect(redirects.allows('centcom-tui', 'http://[::1]:8080/callback')).toBe(true);
    expect(redirects.allows('centcom-cli', 'centcom://auth/callback')).toBe(true);
    expect(redirects.allows('centcom-web', 'centcom://auth/callback')).toBe(false);
  });

  it('reads the keys it is given', () => {
    const config = loadPkceConfig({
      ...TEST_ENV,
      WEB_ALLOWED_ORIGINS: 'https://app.centcom.test, http://localhost:5173',
    });
    expect(config.loginUrl).toBe('https://app.centcom.test/login');
    expect([...config.allowedOrigins]).toEqual([
      'https://app.centcom.test',
      'http://localhost:5173',
    ]);
    expect(config.redirects.allows('centcom-web', 'https://app.centcom.test/auth/callback')).toBe(
      true,
    );
    expect(config.redirects.allows('centcom-web', 'https://app.centcom.dev/auth/callback')).toBe(
      false,
    );
  });

  it.each([
    ['not JSON', '{centcom-web:'],
    ['an array', '["https://app.centcom.test/cb"]'],
    ['an unknown client', '{"evil-cli":["https://evil.test/cb"]}'],
    ['an empty list', '{"centcom-web":[]}'],
    ['a list that is not one', '{"centcom-web":"https://app.centcom.test/cb"}'],
    ['a repeated entry', '{"centcom-web":["https://a.test/cb","https://a.test/cb"]}'],
    [
      'too many entries',
      JSON.stringify({
        'centcom-web': Array.from({ length: 17 }, (_, i) => `https://a.test/cb${i}`),
      }),
    ],
    ['http off loopback', '{"centcom-web":["http://app.centcom.test/cb"]}'],
    ['another scheme', '{"centcom-web":["ftp://app.centcom.test/cb"]}'],
    ['a relative URI', '{"centcom-web":["/auth/callback"]}'],
    ['a query', '{"centcom-web":["https://app.centcom.test/cb?x=1"]}'],
    ['a fragment', '{"centcom-web":["https://app.centcom.test/cb#x"]}'],
    ['credentials', '{"centcom-web":["https://u:p@app.centcom.test/cb"]}'],
    ['a non-canonical host', '{"centcom-web":["https://App.Centcom.test/cb"]}'],
    ['no path', '{"centcom-web":["https://app.centcom.test"]}'],
    ['a non-string entry', '{"centcom-web":[42]}'],
    ['an empty entry', '{"centcom-web":[""]}'],
  ])('refuses to start with AUTH_REDIRECT_URIS holding %s', (_case, value) => {
    const error = configError(() => loadPkceConfig({ ...TEST_ENV, AUTH_REDIRECT_URIS: value }));
    expect(error.issues.map((i) => i.key)).toEqual(['AUTH_REDIRECT_URIS']);
  });

  it.each([
    ['nothing', ' , '],
    ['a path', 'https://app.centcom.test/'],
    ['http off loopback', 'http://app.centcom.test'],
    ['not a URL', 'app.centcom.test'],
    ['too many', Array.from({ length: 17 }, (_, i) => `https://a${i}.test`).join(',')],
  ])('refuses to start with WEB_ALLOWED_ORIGINS holding %s', (_case, value) => {
    const error = configError(() => loadPkceConfig({ ...TEST_ENV, WEB_ALLOWED_ORIGINS: value }));
    expect(error.issues.map((i) => i.key)).toEqual(['WEB_ALLOWED_ORIGINS']);
  });

  it.each([
    ['a query', 'https://app.centcom.test/login?x=1'],
    ['another scheme', 'ftp://app.centcom.test/login'],
  ])('refuses to start with WEB_LOGIN_URL holding %s', (_case, value) => {
    const error = configError(() => loadPkceConfig({ ...TEST_ENV, WEB_LOGIN_URL: value }));
    expect(error.issues.map((i) => i.key)).toEqual(['WEB_LOGIN_URL']);
  });

  it('never puts a value in the error', () => {
    const value = '{"centcom-web":["http://secret-host.test/cb"]}';
    const error = configError(() => loadPkceConfig({ ...TEST_ENV, AUTH_REDIRECT_URIS: value }));
    expect(error.message).not.toContain('secret-host');
  });
});

describe('redirectAllowlist', () => {
  const list = redirectAllowlist({
    'centcom-web': ['https://app.centcom.test/auth/callback'],
    'centcom-cli': [
      'http://127.0.0.1/callback',
      'http://[::1]/callback',
      'centcom://auth/callback',
    ],
    'centcom-tui': ['http://localhost:7000/callback'],
  });

  it.each([
    ['the exact URI', 'centcom-web', 'https://app.centcom.test/auth/callback', true],
    ['one character more', 'centcom-web', 'https://app.centcom.test/auth/callbacks', false],
    ['one character less', 'centcom-web', 'https://app.centcom.test/auth/callbac', false],
    ['one character changed', 'centcom-web', 'https://app.centcom.test/auth/callbaco', false],
    ['a trailing slash', 'centcom-web', 'https://app.centcom.test/auth/callback/', false],
    ['an added query', 'centcom-web', 'https://app.centcom.test/auth/callback?x=1', false],
    ['an empty query', 'centcom-web', 'https://app.centcom.test/auth/callback?', false],
    ['a fragment', 'centcom-web', 'https://app.centcom.test/auth/callback#x', false],
    ['another case', 'centcom-web', 'https://APP.centcom.test/auth/callback', false],
    [
      'an explicit default port',
      'centcom-web',
      'https://app.centcom.test:443/auth/callback',
      false,
    ],
    ['another client', 'centcom-cli', 'https://app.centcom.test/auth/callback', false],
    ['a loopback port', 'centcom-cli', 'http://127.0.0.1:53682/callback', true],
    ['the loopback without a port', 'centcom-cli', 'http://127.0.0.1/callback', true],
    ['an IPv6 loopback port', 'centcom-cli', 'http://[::1]:1/callback', true],
    ['the highest port', 'centcom-cli', 'http://127.0.0.1:65535/callback', true],
    ['port 0', 'centcom-cli', 'http://127.0.0.1:0/callback', false],
    ['a port too high', 'centcom-cli', 'http://127.0.0.1:65536/callback', false],
    ['a port with a leading zero', 'centcom-cli', 'http://127.0.0.1:080/callback', false],
    ['a loopback path changed', 'centcom-cli', 'http://127.0.0.1:5000/callback/', false],
    ['a loopback query', 'centcom-cli', 'http://127.0.0.1:5000/callback?x=1', false],
    ['localhost for an IP entry', 'centcom-cli', 'http://localhost:5000/callback', false],
    ['https for an http entry', 'centcom-cli', 'https://127.0.0.1:5000/callback', false],
    ['localhost on its port', 'centcom-tui', 'http://localhost:7000/callback', true],
    ['localhost on another port', 'centcom-tui', 'http://localhost:7001/callback', false],
    ['the desktop scheme where listed', 'centcom-cli', 'centcom://auth/callback', true],
    ['the desktop scheme elsewhere', 'centcom-web', 'centcom://auth/callback', false],
    ['an unknown client', 'evil-cli', 'https://app.centcom.test/auth/callback', false],
  ])('%s', (_case, clientId, uri, allowed) => {
    expect(list.allows(clientId, uri)).toBe(allowed);
  });

  it('refuses what is not a string or is too long', () => {
    expect(list.allows('centcom-web', undefined)).toBe(false);
    expect(list.allows('centcom-web', ['https://app.centcom.test/auth/callback'])).toBe(false);
    const long = `http://127.0.0.1:5000/${'a'.repeat(MAX_REDIRECT_URI_LENGTH)}`;
    expect(list.allows('centcom-cli', long)).toBe(false);
  });

  it('lets a client be left out of the map', () => {
    const read = readRedirectUris('{"centcom-web":["https://app.centcom.test/cb"]}');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(redirectAllowlist(read.value).allows('centcom-cli', 'http://127.0.0.1:5/callback')).toBe(
      false,
    );
  });
});
