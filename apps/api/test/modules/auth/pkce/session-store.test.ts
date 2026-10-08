/**
 * Browser login sessions (B018; tests "session-store.test.ts"): the cookie's attributes, a new id
 * on every login that ends the old one (fixation), 30-day sliding expiry on a fake clock, ids kept
 * in Redis only as hashes, unreadable records, the LoginCompleter for B014 and B015, and a Redis
 * outage answered with 503.
 */
import { AppError, createMemoryRedis, unavailable } from '@centcom/core';
import { fastify } from 'fastify';
import { describe, expect, it } from 'vitest';
import { LOGIN_SESSION_COOKIE } from '../../../../src/modules/auth/web-session/cookies.js';
import {
  createLoginSessions,
  LOGIN_SESSION_TTL_MS,
  webLoginCompleter,
} from '../../../../src/modules/auth/web-session/store.js';
import { errorHandlerPlugin } from '../../../../src/plugins/error-handler.js';
import { captureLogger } from '../../../helpers.js';
import { testClock } from '../tokens/helpers.js';
import { cookieValue, failingKv, newId, recordingKv, setCookie } from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A tiny app over the sessions: login, whoami (sliding) and a login completer route. */
async function sessionApp(kvOverride?: Parameters<typeof createLoginSessions>[0]['kv']) {
  const clock = testClock();
  const kv = recordingKv(kvOverride ?? createMemoryRedis(clock.now).kv);
  const sessions = createLoginSessions({ kv, now: clock.now });
  const completer = webLoginCompleter(sessions);
  const app = fastify({ logger: false });
  await app.register(errorHandlerPlugin, { logger: captureLogger().logger });
  app.post('/login', async (request, reply) => {
    await sessions.establishLoginSession(reply, (request.body as { user_id: string }).user_id);
    return { ok: true };
  });
  app.post('/complete', async (request, reply) => {
    await completer.complete(
      reply,
      (request.body as { user_id: string }).user_id,
      'https://app.centcom.test/',
    );
    return reply;
  });
  app.get('/whoami', async (request, reply) => ({
    session: await sessions.getLoginSession(request, reply),
  }));
  app.get('/peek', async (request) => ({ session: await sessions.getLoginSession(request) }));
  await app.ready();
  const loginAs = async (userId: string, cookie?: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { user_id: userId },
      ...(cookie === undefined ? {} : { headers: { cookie } }),
    });
    return {
      res,
      cookie: `${LOGIN_SESSION_COOKIE}=${cookieValue(res, LOGIN_SESSION_COOKIE) ?? ''}`,
    };
  };
  const whoami = (cookie: string, path = '/whoami') =>
    app.inject({ method: 'GET', url: path, headers: { cookie } });
  return { app, clock, kv, sessions, loginAs, whoami };
}

describe('login sessions', () => {
  it('sets an HttpOnly, Secure, SameSite=Lax cookie for 30 days on the whole site', async () => {
    const s = await sessionApp();
    const { res } = await s.loginAs(newId('usr'));
    const header = setCookie(res, LOGIN_SESSION_COOKIE) ?? '';
    expect(cookieValue(res, LOGIN_SESSION_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(header.split('; ').slice(1)).toEqual([
      'Path=/',
      'Max-Age=2592000',
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
    ]);
    await s.app.close();
  });

  it('knows the user of a live session', async () => {
    const s = await sessionApp();
    const userId = newId('usr');
    const { cookie } = await s.loginAs(userId);
    expect((await s.whoami(cookie)).json()).toEqual({ session: { userId } });
    await s.app.close();
  });

  it('mints a new id on every login and ends the old one (fixation)', async () => {
    const s = await sessionApp();
    const planted = await s.loginAs(newId('usr'));
    const victim = newId('usr');
    const fresh = await s.loginAs(victim, planted.cookie);
    expect(fresh.cookie).not.toBe(planted.cookie);
    expect((await s.whoami(planted.cookie)).json()).toEqual({ session: null });
    expect((await s.whoami(fresh.cookie)).json()).toEqual({ session: { userId: victim } });
    await s.app.close();
  });

  it('slides 30 days forward on every use and ends after 30 idle days', async () => {
    const s = await sessionApp();
    const userId = newId('usr');
    const { cookie } = await s.loginAs(userId);
    s.clock.advance(29 * DAY_MS);
    const touched = await s.whoami(cookie);
    expect(touched.json()).toEqual({ session: { userId } });
    expect(setCookie(touched, LOGIN_SESSION_COOKIE)).toContain('Max-Age=2592000');
    s.clock.advance(29 * DAY_MS);
    expect((await s.whoami(cookie, '/peek')).json()).toEqual({ session: { userId } });
    s.clock.advance(LOGIN_SESSION_TTL_MS);
    expect((await s.whoami(cookie)).json()).toEqual({ session: null });
    await s.app.close();
  });

  it('renews the cookie only when given the reply', async () => {
    const s = await sessionApp();
    const { cookie } = await s.loginAs(newId('usr'));
    expect(setCookie(await s.whoami(cookie, '/peek'), LOGIN_SESSION_COOKIE)).toBeUndefined();
    await s.app.close();
  });

  it('knows nobody for a missing, malformed, unknown or unreadable session', async () => {
    const s = await sessionApp();
    expect((await s.app.inject({ method: 'GET', url: '/whoami' })).json()).toEqual({
      session: null,
    });
    for (const value of ['', 'short', 'x'.repeat(43), 'x'.repeat(42) + '+']) {
      expect((await s.whoami(`${LOGIN_SESSION_COOKIE}=${value}`)).json()).toEqual({
        session: null,
      });
    }
    const { cookie } = await s.loginAs(newId('usr'));
    const key = s.kv.writes.at(-1)?.key ?? '';
    for (const bad of ['not json', '{"usr":"nope","exp":1}', 'null']) {
      await s.kv.set(key, bad);
      expect((await s.whoami(cookie)).json()).toEqual({ session: null });
    }
    await s.app.close();
  });

  it('keeps session ids in Redis only as hashes', async () => {
    const s = await sessionApp();
    const { res } = await s.loginAs(newId('usr'));
    const id = cookieValue(res, LOGIN_SESSION_COOKIE) ?? '-';
    expect(s.kv.writes.length).toBeGreaterThan(0);
    for (const { key, value } of s.kv.writes) {
      expect(key).toMatch(/^auth:sid:[0-9a-f]{64}$/);
      expect(key).not.toContain(id);
      expect(value).not.toContain(id);
    }
    await s.app.close();
  });

  it('refuses to sign in something that is not a user id', async () => {
    const s = await sessionApp();
    const res = await s.app.inject({ method: 'POST', url: '/login', payload: { user_id: 'nope' } });
    expect(res.statusCode).toBe(500);
    await s.app.close();
  });

  it('completes a B014/B015 login: a session, then 303 to return_to', async () => {
    const s = await sessionApp();
    const userId = newId('usr');
    const res = await s.app.inject({
      method: 'POST',
      url: '/complete',
      payload: { user_id: userId },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers['location']).toBe('https://app.centcom.test/');
    expect(res.headers['cache-control']).toBe('no-store');
    const cookie = `${LOGIN_SESSION_COOKIE}=${cookieValue(res, LOGIN_SESSION_COOKIE) ?? ''}`;
    expect((await s.whoami(cookie)).json()).toEqual({ session: { userId } });
    await s.app.close();
  });

  it.each([
    ['an outage error', () => new Error('ECONNREFUSED')],
    ['a 503 from the backend', () => unavailable()],
  ])('answers 503 with retry_after_s when Redis fails (%s), with no fallback', async (_c, err) => {
    const s = await sessionApp(failingKv(err));
    const res = await s.whoami(`${LOGIN_SESSION_COOKIE}=${'a'.repeat(43)}`);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      code: 'service_unavailable',
      retry_after_s: expect.any(Number),
    });
    expect(res.body).not.toContain('ECONNREFUSED');
    const login = await s.app.inject({
      method: 'POST',
      url: '/login',
      payload: { user_id: newId('usr') },
    });
    expect(login.statusCode).toBe(503);
    expect(login.headers['set-cookie']).toBeUndefined();
    await s.app.close();
  });

  it('passes other AppErrors through', async () => {
    const s = await sessionApp(failingKv(() => new AppError('rate_limited')));
    const res = await s.whoami(`${LOGIN_SESSION_COOKIE}=${'a'.repeat(43)}`);
    expect(res.statusCode).toBe(429);
    await s.app.close();
  });
});
