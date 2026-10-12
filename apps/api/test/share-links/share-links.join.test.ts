/**
 * Joining (B068; tests "share-links.join.test.ts", acceptance 3 and 9): a ticket with `role`
 * `viewer`, `aud` `centcom-relay`, 60 s, a fresh `jti` (recorded for 60 s), no `dev` and no caps;
 * whatever the body says, a guest never gets another role (a fast-check property); the E2E key
 * (`k`) is refused; a guest's ticket cannot call the REST API; a ticket that cannot be signed
 * is 503 and spends no use.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { shareApp, T0 } from './helpers.js';

describe('a guest join', () => {
  it('answers a viewer ticket: relay audience, 60 s, fresh jti, no dev, no caps', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host)).json();
    const res = await env.join(token, { display_name: 'Ada' }, env.ip());
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toMatchObject({
      expires_in: 60,
      relay_url: 'wss://eu.relay.centcom.dev',
      region: 'eu',
      role: 'viewer',
      caps: [],
    });
    expect(body.member).toMatch(/^mem_[0-9A-HJKMNP-TV-Z]{26}$/);
    const claims = env.claims(body.ticket);
    expect(claims).toMatchObject({
      sid: s.sid,
      mid: body.member,
      role: 'viewer',
      aud: 'centcom-relay',
      caps: [],
    });
    expect(claims).not.toHaveProperty('dev');
    expect((claims['exp'] as number) - (claims['iat'] as number)).toBe(60);
    expect(claims['iat']).toBe(T0 / 1000);
    expect(env.issued.get(`ticket:issued:${String(claims['jti'])}`)).toEqual({
      value: `${s.sid}:${body.member}`,
      ttlMs: 60_000,
    });
    const second = env.claims(
      (await env.join(token, { display_name: 'Bob' }, env.ip())).json().ticket,
    );
    expect(second['jti']).not.toBe(claims['jti']);
    expect(env.store.guests.map((g) => g.name)).toEqual(['Ada', 'Bob']);
  });

  it('property: no body ever gets a guest any role but viewer', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host, { max_uses: 50 })).json();
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          role: fc.constantFrom('host', 'editor', 'viewer', 'owner', 'admin'),
          caps: fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }),
          dev: fc.constant('dev_01JA3Z8K2M5N7P9Q0R1S2T3V4W'),
          mid: fc.constant('mem_01JA3Z8K2M5N7P9Q0R1S2T3V4W'),
        }),
        async (extra) => {
          const res = await env.join(token, { display_name: 'Guest', ...extra }, env.ip());
          if (res.statusCode !== 200) return; // used up
          const body = res.json();
          expect(body.role).toBe('viewer');
          const claims = env.claims(body.ticket);
          expect(claims['role']).toBe('viewer');
          expect(claims).not.toHaveProperty('dev');
          expect(claims['caps']).toEqual([]);
          expect(claims['mid']).not.toBe(extra.mid);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('refuses the E2E key (`k`) and bad names', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host)).json();
    for (const body of [
      { display_name: 'Guest', k: 'c2VjcmV0' },
      { display_name: 'bad\u0007name' },
      { display_name: '' },
      { display_name: 'x'.repeat(41) },
      {},
    ]) {
      const res = await env.join(token, body, env.ip());
      expect(res.statusCode).toBe(422);
    }
    expect(env.store.guests).toEqual([]);
  });

  it('a guest ticket cannot call the REST API', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host)).json();
    const { ticket } = (await env.join(token, { display_name: 'Guest' }, env.ip())).json();
    const res = await env.app.inject({
      method: 'GET',
      url: `/v1/sessions/${s.sid}`,
      headers: { authorization: `Bearer ${ticket}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('a ticket that cannot be signed: 503, and the use is not spent', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host, { max_uses: 1 })).json();
    env.shareFlags.failSigning = true;
    const res = await env.join(token, { display_name: 'Guest' }, env.ip());
    expect(res.statusCode).toBe(503);
    expect(res.json().retry_after_s).toBe(5);
    expect(env.store.guests).toEqual([]);
    env.shareFlags.failSigning = false;
    expect((await env.join(token, { display_name: 'Guest' }, env.ip())).statusCode).toBe(200);
  });
});
