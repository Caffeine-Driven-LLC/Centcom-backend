/**
 * Probing (B068; tests "share-links.probing.test.ts", acceptance 4): an unknown, expired, revoked
 * or used-up token, a session that ended, and a workspace without `relay_access` all get the same
 * 404 problem body (only the request id differs), with a median time within 5 ms of each other.
 */
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { shareApp, T0 } from './helpers.js';

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

describe('uniform refusals', () => {
  it('unknown, expired, revoked, used up, ended and no relay: one 404 body, similar time', async () => {
    const env = await shareApp();
    const tokens: Record<string, string> = {};
    // Unknown.
    tokens['unknown'] = 'A'.repeat(43);
    // Revoked.
    const a = await env.session();
    const revoked: string = (await env.create(a.sid, a.host)).json().token;
    tokens['revoked'] = revoked;
    await env.revoke(a.sid, revoked, a.host);
    // Used up.
    const b = await env.session();
    const usedUp: string = (await env.create(b.sid, b.host, { max_uses: 1 })).json().token;
    tokens['used up'] = usedUp;
    await env.join(usedUp, { display_name: 'First' }, env.ip());
    // Expired (60 s link, clock moved past it).
    const c = await env.session();
    tokens['expired'] = (await env.create(c.sid, c.host, { expires_in_s: 60 })).json().token;
    // Ended session.
    const d = await env.session();
    tokens['ended'] = (await env.create(d.sid, d.host)).json().token;
    const row = env.world.sessions.get(d.sid);
    if (row !== undefined) row.row.state = 'ended';
    // No relay access (the plan lapsed after the link was made).
    const e = await env.session();
    tokens['no relay'] = (await env.create(e.sid, e.host)).json().token;
    const ws = env.world.workspaces.get(e.workspace);
    if (ws !== undefined) ws.plan = 'free';
    env.clock.advance(61_000);

    const bodies: Record<string, unknown>[] = [];
    const times: Record<string, number[]> = {};
    for (let round = 0; round < 15; round += 1) {
      for (const [name, token] of Object.entries(tokens)) {
        const started = performance.now();
        const res = await env.join(token, { display_name: 'Probe' }, `192.0.2.${round + 1}`);
        (times[name] ??= []).push(performance.now() - started);
        expect(res.statusCode, name).toBe(404);
        const body = res.json() as Record<string, unknown>;
        delete body['request_id'];
        if (round === 0) bodies.push(body);
      }
    }
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ code: 'not_found', status: 404 });
    const medians = Object.values(times).map(median);
    expect(Math.max(...medians) - Math.min(...medians)).toBeLessThan(5);
    expect(T0).toBeGreaterThan(0);
  });
});
