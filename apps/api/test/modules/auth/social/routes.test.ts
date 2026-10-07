/**
 * The browser routes (B015 interfaces, acceptance 2 and 8, failure modes): 302 to the provider
 * with the state cookie, a callback that hands over to the LoginCompleter and ends in 303, a
 * generic page (400, or 502 after a provider timeout) with one log line and no account change,
 * and 404 for a provider that is not configured.
 */
import { describe, expect, it } from 'vitest';
import { STATE_COOKIE } from '../../../../src/modules/auth/social/index.js';
import { APP, recordingCompleter, SETTINGS, socialApp, socialService } from './helpers.js';

/** The `name=value` of the state cookie a response set. */
const cookieOf = (setCookie: string | string[] | undefined): string => {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (header ?? '').split(';')[0] ?? '';
};

describe('GET /login/:provider', () => {
  it('sets the signed state cookie and answers 302 to the provider', async () => {
    const { service } = socialService();
    const { app } = await socialApp(service);
    const res = await app.inject({
      url: `/login/github?return_to=${encodeURIComponent(SETTINGS)}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(String(res.headers['set-cookie'])).toMatch(
      /^centcom_oauth=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/login; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/,
    );
    await app.close();
  });

  it('answers 404 for a provider that is off or unknown (failure mode)', async () => {
    const base = socialService();
    const { service } = socialService({
      config: { ...base.config, providers: { google: base.config.providers.google } } as never,
    });
    const { app } = await socialApp(service);
    expect((await app.inject({ url: '/login/github' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/login/github/callback?code=c&state=s' })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ url: '/login/facebook' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/login/google' })).statusCode).toBe(302);
    expect(service.enabledProviders()).toEqual(['google']);
    await app.close();
  });
});

describe('GET /login/:provider/callback', () => {
  it('signs in, hands over to the LoginCompleter and ends with 303 to return_to', async () => {
    const { service, providers, users } = socialService();
    const completer = recordingCompleter();
    const { app, lines } = await socialApp(service, completer);
    const start = await app.inject({
      url: `/login/google?return_to=${encodeURIComponent(SETTINGS)}`,
    });
    const location = new URL(String(start.headers['location']));
    providers.nonce = location.searchParams.get('nonce') ?? '';
    const res = await app.inject({
      url: `/login/google/callback?code=goog-code&state=${location.searchParams.get('state') ?? ''}`,
      headers: { cookie: cookieOf(start.headers['set-cookie']) },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers['location']).toBe(SETTINGS);
    expect(String(res.headers['set-cookie'])).toContain(`${STATE_COOKIE}=; Path=/login; Max-Age=0`);
    const user = users.users.get('gina@example.test');
    expect(completer.completed).toEqual([{ userId: user?.id, returnTo: SETTINGS }]);
    expect(lines().find((l) => l['msg'] === 'auth.social_login')).toMatchObject({
      provider: 'google',
      created: true,
    });
    await app.close();
  });

  it('redirects itself when the completer leaves the reply to it', async () => {
    const { service, providers } = socialService();
    const { app } = await socialApp(service, { complete: () => Promise.resolve() });
    const start = await app.inject({ url: '/login/github' });
    const state = new URL(String(start.headers['location'])).searchParams.get('state') ?? '';
    void providers;
    const res = await app.inject({
      url: `/login/github/callback?code=c&state=${state}`,
      headers: { cookie: cookieOf(start.headers['set-cookie']) },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers['location']).toBe(APP);
    await app.close();
  });

  it('answers a bad state with a generic 400 page, one log line and no user (acceptance 2)', async () => {
    const { service, users } = socialService();
    const completer = recordingCompleter();
    const { app, lines } = await socialApp(service, completer);
    const start = await app.inject({ url: '/login/github' });
    const res = await app.inject({
      url: '/login/github/callback?code=c&state=forged',
      headers: { cookie: cookieOf(start.headers['set-cookie']) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'");
    expect(res.body).toContain('Sign-in did not complete. Please start again.');
    expect(users.users.size).toBe(0);
    expect(completer.completed).toEqual([]);
    expect(lines().filter((l) => l['msg'] === 'auth.social_login_failed')).toEqual([
      expect.objectContaining({ provider: 'github', reason: 'state', status: 400, level: 'warn' }),
    ]);
    // No cookie at all is the same.
    expect((await app.inject({ url: '/login/github/callback?code=c&state=x' })).statusCode).toBe(
      400,
    );
    await app.close();
  });

  it('answers a provider timeout with a 502 page and a 502 log entry, creating nobody (acceptance 8)', async () => {
    const { service, providers, users, identities } = socialService({ timeoutMs: 50 });
    providers.hang.add('github.com');
    const { app, lines } = await socialApp(service);
    const start = await app.inject({ url: '/login/github' });
    const state = new URL(String(start.headers['location'])).searchParams.get('state') ?? '';
    const res = await app.inject({
      url: `/login/github/callback?code=c&state=${state}`,
      headers: { cookie: cookieOf(start.headers['set-cookie']) },
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain('GitHub did not answer in time');
    expect(lines().find((l) => l['msg'] === 'auth.social_login_failed')).toMatchObject({
      reason: 'provider',
      status: 502,
    });
    expect(users.users.size).toBe(0);
    expect(identities.rows.size).toBe(0);
    await app.close();
  });

  it('explains an account without a verified e-mail (failure mode: no email)', async () => {
    const { service, providers } = socialService();
    providers.github.emails = [];
    const { app } = await socialApp(service);
    const start = await app.inject({ url: '/login/github' });
    const state = new URL(String(start.headers['location'])).searchParams.get('state') ?? '';
    const res = await app.inject({
      url: `/login/github/callback?code=c&state=${state}`,
      headers: { cookie: cookieOf(start.headers['set-cookie']) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Your GitHub account has no verified e-mail address we can use.');
    await app.close();
  });
});
