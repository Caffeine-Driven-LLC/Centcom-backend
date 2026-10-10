/**
 * Join tokens (B054; test "sessions.join-token.test.ts": claims, lifetime, single-use jti storage,
 * region hint; acceptance 4 and 5, the guardrails and the signing failure mode):
 *
 * - the ticket verifies against the API's JWKS (EdDSA), with `aud` centcom-relay, `exp - iat` 60,
 *   a fresh `jti` each call, and `sid`, `mid`, `role`, `dev`, `caps`;
 * - its `jti` is recorded for 60 s (`ticket:issued:{jti}`), never under the relay's own
 *   `relay:jti:` key; the ticket is never logged;
 * - the body carries the session's region and relay URL, the member and the role;
 * - a first call makes the caller a member (slot from B031, role editor); a second reuses it;
 * - a guest with a membership gets `viewer`; a guest without one, `billing`, a removed member, a
 *   revoked device, an ended session, a locked session, a full session and a plan without the
 *   relay or with too many members all get no ticket;
 * - signing failing is 503 with `retry_after_s` and `session_ticket_failures_total`.
 */
import { createLocalJWKSet, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { JOIN_TICKET_RECORD_PREFIX } from '../../../src/routes/sessions/index.js';
import { RELAYS, sessionsApp, World } from './helpers.js';

async function setup(plan: 'free' | 'pro' | 'team' = 'team') {
  const world = new World();
  const w = world.workspace(plan === 'free' ? 'team' : plan);
  const env = await sessionsApp({ world });
  const session = await env.create(w.owner, w.id, { region_preference: 'us' });
  if (plan === 'free') {
    const ws = world.workspaces.get(w.id);
    if (ws !== undefined) ws.plan = 'free';
  }
  const join = async (who: { user: string; device: string }, payload: object = {}) =>
    env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/join-token`,
      headers: await env.as(who),
      payload,
    });
  return { ...env, w, sid: session.id, join };
}

interface JoinBody {
  ticket: string;
  expires_in: number;
  relay_url: string;
  region: string;
  member: string;
  role: string;
  caps: string[];
}

describe('the ticket', () => {
  it('verifies against the JWKS with aud centcom-relay, 60 s and the claims', async () => {
    const env = await setup();
    const res = await env.join(env.w.member, { caps: ['resume', 'resume'] });
    expect(res.statusCode).toBe(200);
    const body = res.json<JoinBody>();
    const jwks = createLocalJWKSet(env.tokens.jwks() as Parameters<typeof createLocalJWKSet>[0]);
    const { payload, protectedHeader } = await jwtVerify(body.ticket, jwks, {
      audience: 'centcom-relay',
      issuer: 'https://api.centcom.dev',
      algorithms: ['EdDSA'],
      currentDate: new Date(env.clock.now()),
    });
    expect(protectedHeader.alg).toBe('EdDSA');
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(60);
    expect(payload['sid']).toBe(env.sid);
    expect(payload['mid']).toBe(body.member);
    expect(payload['role']).toBe('editor');
    expect(payload['dev']).toBe(env.w.member.device);
    expect(payload['caps']).toEqual(['resume']);
    expect(body).toMatchObject({
      expires_in: 60,
      region: 'us',
      relay_url: RELAYS.urls.us,
      role: 'editor',
      caps: ['resume'],
    });
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('has a fresh jti each call, each recorded for 60 s away from the relay’s own key', async () => {
    const env = await setup();
    const jtis: string[] = [];
    for (let i = 0; i < 3; i++) {
      const body = (await env.join(env.w.member)).json<JoinBody>();
      const claims = JSON.parse(
        Buffer.from(body.ticket.split('.')[1] ?? '', 'base64url').toString('utf8'),
      ) as { jti: string };
      jtis.push(claims.jti);
    }
    expect(new Set(jtis).size).toBe(3);
    for (const jti of jtis) {
      const record = env.issued.get(`${JOIN_TICKET_RECORD_PREFIX}${jti}`);
      expect(record?.ttlMs).toBe(60_000);
      expect(record?.value.startsWith(`${env.sid}:mem_`)).toBe(true);
    }
    expect([...env.issued.keys()].some((k) => k.startsWith('relay:jti:'))).toBe(false);
  });

  it('never logs the ticket', async () => {
    const env = await setup();
    const body = (await env.join(env.w.member)).json<JoinBody>();
    expect(env.captured.raw()).not.toContain(body.ticket);
    expect(env.captured.raw()).not.toContain(body.ticket.split('.')[2]);
  });
});

describe('membership', () => {
  it('makes a first caller a member with the next B031 slot, and reuses it after', async () => {
    const env = await setup();
    const first = (await env.join(env.w.member)).json<JoinBody>();
    const second = (await env.join(env.w.member)).json<JoinBody>();
    expect(second.member).toBe(first.member);
    const row = env.world.members.find((m) => m.id === first.member);
    expect(row).toMatchObject({ role: 'editor', slot: 1, userId: env.w.member.user });
    expect(env.world.slots.get(env.sid)?.get(first.member)).toBe(1);
  });

  it('gives the host role to the host and viewer to a guest member (capped)', async () => {
    const env = await setup();
    expect((await env.join(env.w.owner)).json<JoinBody>().role).toBe('host');
    env.world.addMember(env.sid, env.w.guest, 'editor');
    const res = await env.join(env.w.guest);
    expect(res.statusCode).toBe(200);
    const body = res.json<JoinBody>();
    expect(body.role).toBe('viewer');
    const claims = JSON.parse(
      Buffer.from(body.ticket.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { role: string };
    expect(claims.role).toBe('viewer');
  });

  it('refuses a guest without a membership, and billing, with 403 and no member row', async () => {
    const env = await setup();
    for (const who of [env.w.guest, env.w.billing]) {
      const res = await env.join(who);
      expect(res.statusCode).toBe(403);
      expect(env.world.members.some((m) => m.userId === who.user)).toBe(false);
    }
  });

  it('refuses a member removed from the session (403 not_a_member)', async () => {
    const env = await setup();
    const mid = env.world.addMember(env.sid, env.w.member, 'editor');
    const row = env.world.members.find((m) => m.id === mid);
    if (row !== undefined) row.leftAt = new Date(env.clock.now());
    const res = await env.join(env.w.member);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('not_a_member');
  });

  it('answers 404 to someone removed from the workspace, with no ticket', async () => {
    const env = await setup();
    env.world.addMember(env.sid, env.w.member, 'editor');
    env.world.memberships = env.world.memberships.filter((m) => m.userId !== env.w.member.user);
    const res = await env.join(env.w.member);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ ticket?: string }>().ticket).toBeUndefined();
  });

  it('refuses a revoked device (401 device_revoked)', async () => {
    const env = await setup();
    const headers = await env.as(env.w.member);
    const device = env.world.devices.get(env.w.member.device);
    if (device !== undefined) device.revoked = true;
    const res = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${env.sid}/join-token`,
      headers,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(env.issued.size).toBe(0);
  });

  it('gives no ticket on an ended session (410 session_ended), to the same user too', async () => {
    const env = await setup();
    const before = (await env.join(env.w.member)).json<JoinBody>();
    expect(before.ticket).toBeTruthy();
    const ended = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${env.sid}/end`,
      headers: await env.as(env.w.owner),
    });
    expect(ended.statusCode).toBe(200);
    const issued = env.issued.size;
    for (const who of [env.w.member, env.w.owner]) {
      const res = await env.join(who);
      expect(res.statusCode).toBe(410);
      expect(res.json<{ code: string; ticket?: string }>()).toMatchObject({
        code: 'session_ended',
      });
      expect(res.json<{ ticket?: string }>().ticket).toBeUndefined();
    }
    expect(env.issued.size).toBe(issued);
  });

  it('keeps new members out of a locked session (403 session_locked); members still join', async () => {
    const env = await setup();
    await env.join(env.w.admin);
    const patch = await env.app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${env.sid}`,
      headers: await env.as(env.w.owner),
      payload: { policy: { locked: true } },
    });
    expect(patch.statusCode).toBe(200);
    const res = await env.join(env.w.member);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('session_locked');
    expect((await env.join(env.w.admin)).statusCode).toBe(200);
  });
});

describe('slots', () => {
  it('gives the B031 slot back when the member row is not written', async () => {
    const world = new World();
    const w = world.workspace('team');
    const base = await sessionsApp({ world });
    const { id: sid } = await base.create(w.owner, w.id);
    const store = world.store();
    let raced = false;
    const env = await sessionsApp({
      world,
      deps: {
        store: {
          ...store,
          // A concurrent first join of the same user won the session lock.
          addMember: async (input) => {
            if (!raced) {
              raced = true;
              world.addMember(sid, w.member, 'editor');
            }
            return store.addMember(input);
          },
        },
      },
    });
    const res = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sid}/join-token`,
      headers: await env.as(w.member),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(world.released).toHaveLength(1);
    const slots = world.slots.get(sid);
    expect(slots?.has(world.released[0] ?? '')).toBe(false);
    // The owner's 0 and the racing row's 2 stay; the released 1 is gone.
    expect([...(slots?.values() ?? [])].sort()).toEqual([0, 2]);
  });
});

describe('plan limits', () => {
  it('refuses a workspace without relay access (403 entitlement_required)', async () => {
    const env = await setup('free');
    const res = await env.join(env.w.member);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('entitlement_required');
  });

  it('refuses a member past max_session_members (403 member_limit_reached)', async () => {
    const env = await setup('pro'); // 4 members
    for (const who of [env.w.admin, env.w.member]) {
      expect((await env.join(who)).statusCode).toBe(200);
    }
    const fourth = env.world.person('Fourth');
    env.world.memberships.push({ workspaceId: env.w.id, userId: fourth.user, role: 'member' });
    expect((await env.join(fourth)).statusCode).toBe(200);
    const fifth = env.world.person('Fifth');
    env.world.memberships.push({ workspaceId: env.w.id, userId: fifth.user, role: 'member' });
    const res = await env.join(fifth);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('member_limit_reached');
  });

  it('refuses when B031 has no slot left (403 session_full)', async () => {
    const env = await setup();
    const slots = env.world.slots.get(env.sid);
    for (let i = 1; i < 50; i++) slots?.set(`mem_FILLER${String(i).padStart(22, '0')}`, i);
    const res = await env.join(env.w.member);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('session_full');
  });

  it('answers 503 when the entitlements cannot be read, with no member row', async () => {
    const env = await setup();
    env.flags.entitlements.mode = 'fail';
    const res = await env.join(env.w.member);
    expect(res.statusCode).toBe(503);
    expect(env.world.members.some((m) => m.userId === env.w.member.user)).toBe(false);
  });
});

describe('failures', () => {
  it('answers 503 with retry_after_s and counts it when the signing key is unavailable', async () => {
    const env = await setup();
    env.flags.failSigning = true;
    const res = await env.join(env.w.member);
    expect(res.statusCode).toBe(503);
    const body = res.json<{ code: string; retry_after_s: number; ticket?: string }>();
    expect(body.code).toBe('service_unavailable');
    expect(body.retry_after_s).toBeGreaterThan(0);
    expect(body.ticket).toBeUndefined();
    expect(env.recorded.count('session_ticket_failures_total', { reason: 'signing' })).toBe(1);
    expect(env.issued.size).toBe(0);
  });

  it('answers 503 and gives no ticket when the jti cannot be recorded', async () => {
    const env = await setup();
    env.flags.failRecord = true;
    const res = await env.join(env.w.member);
    expect(res.statusCode).toBe(503);
    expect(res.json<{ ticket?: string }>().ticket).toBeUndefined();
    expect(env.recorded.count('session_ticket_failures_total', { reason: 'record' })).toBe(1);
  });

  it('refuses malformed caps with 422 at the cap', async () => {
    const env = await setup();
    const res = await env.join(env.w.member, { caps: ['ok', 'Not OK'] });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ errors: { pointer: string }[] }>().errors[0]?.pointer).toBe('/caps/1');
    const many = await env.join(env.w.member, {
      caps: Array.from({ length: 17 }, (_, i) => `c${i}`),
    });
    expect(many.statusCode).toBe(422);
  });
});
