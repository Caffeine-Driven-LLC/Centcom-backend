/**
 * Limits (B068; tests "share-links.limits.test.ts", acceptance 7 and 8): a locked session (403
 * `session_locked`); `max_session_members` with guests counted (403 `member_limit_reached`); the
 * 11th join from one address in a minute is 429 with Retry-After; 30 per token per minute; 20
 * links per user per minute; counters down: the public join fails closed (503), creating does
 * not; entitlements down: 503.
 */
import { describe, expect, it } from 'vitest';
import { planLimits } from '../routes/sessions/helpers.js';
import { shareApp } from './helpers.js';

describe('session limits', () => {
  it('a locked session takes no guest', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host)).json();
    const row = env.world.sessions.get(s.sid);
    if (row !== undefined) {
      row.policy = {
        auto_approve: 'ask',
        share_history: false,
        queue_limit: 20,
        locked: true,
        auto_failover: false,
      };
    }
    const res = await env.join(token, { display_name: 'Guest' }, env.ip());
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('session_locked');
  });

  it('guests count toward max_session_members', async () => {
    const env = await shareApp();
    const s = await env.session();
    const cap = planLimits('team')['max_session_members'] as number;
    const { token } = (await env.create(s.sid, s.host, { max_uses: 50 })).json();
    const room = cap - 2; // the host and the editor
    for (let i = 0; i < room; i += 1) {
      expect(
        (await env.join(token, { display_name: `G${i}` }, `198.51.100.${i + 1}`)).statusCode,
      ).toBe(200);
    }
    const res = await env.join(token, { display_name: 'One too many' }, '198.51.100.200');
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('member_limit_reached');
  });

  it('entitlements that cannot be read: 503, nothing spent', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host)).json();
    env.flags.entitlements.mode = 'fail';
    expect((await env.join(token, { display_name: 'Guest' }, env.ip())).statusCode).toBe(503);
    expect(env.store.guests).toEqual([]);
  });
});

describe('rate limits', () => {
  it('the 11th join from one address in a minute is 429 with Retry-After', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host, { max_uses: 50 })).json();
    for (let i = 0; i < 10; i += 1) {
      expect((await env.join(token, { display_name: `G${i}` }, '203.0.113.50')).statusCode).toBe(
        200,
      );
    }
    const res = await env.join(token, { display_name: 'Eleventh' }, '203.0.113.50');
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.json().code).toBe('rate_limited');
    // Another address is not affected (a new session: this one is full).
    const other = await env.session();
    const fresh = (await env.create(other.sid, other.host)).json().token;
    expect((await env.join(fresh, { display_name: 'Other' }, '203.0.113.51')).statusCode).toBe(200);
  });

  it('30 joins per token per minute, whatever the address', async () => {
    const env = await shareApp();
    const token = 'B'.repeat(43);
    for (let i = 0; i < 30; i += 1) {
      expect(
        (await env.join(token, { display_name: 'Probe' }, `192.0.2.${i + 1}`)).statusCode,
      ).toBe(404);
    }
    expect((await env.join(token, { display_name: 'Probe' }, '192.0.2.99')).statusCode).toBe(429);
  });

  it('20 links per user per minute', async () => {
    const env = await shareApp();
    const s = await env.session();
    for (let i = 0; i < 20; i += 1) expect((await env.create(s.sid, s.host)).statusCode).toBe(201);
    const res = await env.create(s.sid, s.host);
    expect(res.statusCode).toBe(429);
  });

  it('counters down: joining fails closed (503), creating does not', async () => {
    const env = await shareApp();
    const s = await env.session();
    env.redis.rateLimit.consume = () => Promise.reject(new Error('redis down'));
    expect((await env.create(s.sid, s.host)).statusCode).toBe(201);
    const res = await env.join('C'.repeat(43), { display_name: 'Guest' }, env.ip());
    expect(res.statusCode).toBe(503);
  });

  it('a guest name with control characters is 422', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host)).json();
    expect((await env.join(token, { display_name: 'a\u0000b' }, env.ip())).statusCode).toBe(422);
  });
});
