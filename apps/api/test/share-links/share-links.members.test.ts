/**
 * A guest reads the members' public keys (B104; tests "share-links.members.test.ts"): the link
 * token is the credential; the answer is the live members with their device keys and nothing
 * private (no user id, no e-mail); a revoked, expired or unknown link, an ended session and a
 * workspace without the relay are all the same 404; its own rate limit; paging by join order.
 */
import { describe, expect, it } from 'vitest';
import { shareApp } from './helpers.js';

const ALLOWED = [
  'id',
  'display_name',
  'device',
  'role',
  'slot',
  'join_order',
  'device_keys',
  'joined_at',
];

describe('guest members', () => {
  it('lists the live members with their device keys, and nothing else', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host)).json();
    const res = await env.guestMembers(token, env.ip());
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();
    expect(body.data.map((m: { role: string }) => m.role).sort()).toEqual(['editor', 'host']);
    for (const m of body.data) {
      expect(Object.keys(m).every((k) => ALLOWED.includes(k))).toBe(true);
      expect(m).not.toHaveProperty('user');
      expect(m.device_keys).toMatchObject({ device: m.device, revoked: false });
      expect(m.device_keys.x25519).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(m.device_keys.ed25519).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(JSON.stringify(body)).not.toMatch(/@|usr_/);
  });

  it('does not spend a use of the link, so a guest can read again after joining', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host, { max_uses: 1 })).json();
    await env.guestMembers(token, env.ip());
    expect((await env.join(token, { display_name: 'Ada' }, env.ip())).statusCode).toBe(200);
    expect((await env.guestMembers(token, env.ip())).statusCode).toBe(200);
  });

  it('a revoked, expired or unknown link is the same 404', async () => {
    const env = await shareApp();
    const s = await env.session();
    const revoked = (await env.create(s.sid, s.host)).json().token;
    await env.revoke(s.sid, revoked, s.host);
    const expiring = (await env.create(s.sid, s.host, { expires_in_s: 60 })).json().token;
    env.clock.advance(61_000);
    const bodies = new Set<string>();
    for (const token of [revoked, expiring, 'A'.repeat(43), 'short']) {
      const res = await env.guestMembers(token, env.ip());
      expect(res.statusCode, token).toBe(404);
      bodies.add(JSON.stringify({ ...res.json(), instance: undefined, request_id: undefined }));
    }
    expect(bodies.size).toBe(1);
  });

  it('an ended session and a workspace without the relay are 404 too', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host)).json();
    const ws = env.world.workspaces.get(s.workspace);
    if (ws === undefined) throw new Error('no workspace');
    ws.plan = 'free';
    expect((await env.guestMembers(token, env.ip())).statusCode).toBe(404);
    ws.plan = 'team';
    expect((await env.guestMembers(token, env.ip())).statusCode).toBe(200);
    await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${s.sid}/end`,
      headers: await env.as(s.host),
    });
    expect((await env.guestMembers(token, env.ip())).statusCode).toBe(404);
  });

  it('members who left are not listed', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host)).json();
    const row = env.world.members.find((m) => m.sessionId === s.sid && m.role === 'editor');
    if (row === undefined) throw new Error('no editor');
    row.leftAt = new Date(env.clock.now());
    const body = (await env.guestMembers(token, env.ip())).json();
    expect(body.data.map((m: { role: string }) => m.role)).toEqual(['host']);
  });

  it('pages by join order with a signed cursor', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host)).json();
    const ip = env.ip();
    const first = (await env.guestMembers(token, ip, '?limit=1')).json();
    expect(first.data).toHaveLength(1);
    expect(first.has_more).toBe(true);
    const second = (
      await env.guestMembers(token, ip, `?limit=1&cursor=${first.next_cursor}`)
    ).json();
    expect(second.data).toHaveLength(1);
    expect(second.data[0].join_order).toBeGreaterThan(first.data[0].join_order);
    expect(
      (await env.guestMembers(token, ip, '?cursor=not-a-cursor')).statusCode,
    ).toBeGreaterThanOrEqual(400);
  });

  it('has its own rate limit: the 61st read from one address in a minute is 429', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host)).json();
    for (let i = 0; i < 60; i += 1)
      expect((await env.guestMembers(token, '203.0.113.90')).statusCode).toBe(200);
    const res = await env.guestMembers(token, '203.0.113.90');
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect((await env.join(token, { display_name: 'Ada' }, '203.0.113.91')).statusCode).toBe(200);
  });
});
