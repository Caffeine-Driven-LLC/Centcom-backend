/**
 * Claiming the host (B054; test "sessions.claim-host.test.ts": admin only, host-present conflict,
 * audit; acceptance 7 and the relay-notifier failure mode):
 *
 * - a workspace member (not admin) is 403 (`role_insufficient`, the denial audited); an outsider
 *   404;
 * - while the host is connected: 409, nothing changed;
 * - the host gone: 200, the caller's member is host, the old host an editor, exactly one
 *   `control.transfer_host` audit event, one `control.host_changed` (failover) to the relay;
 * - an admin not yet in the session joins first (slot from B031) and becomes host;
 * - the relay notifier down: the change is committed, the notification stays queued, the answer
 *   is still 200, and a later delivery sends it with the current host;
 * - an ended session: 410.
 */
import { describe, expect, it } from 'vitest';
import { deliverHostChanges } from '../../../src/routes/sessions/index.js';
import { sessionsApp, World } from './helpers.js';

async function setup() {
  const world = new World();
  const w = world.workspace('team');
  const env = await sessionsApp({ world });
  const session = await env.create(w.owner, w.id);
  const claim = async (who: { user: string; device: string }) =>
    env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/claim-host`,
      headers: await env.as(who),
    });
  const hostOf = () => env.world.sessions.get(session.id)?.row.host_member_id;
  const roleOf = (mid: string | null | undefined) =>
    env.world.members.find((m) => m.id === mid)?.role;
  return { ...env, w, sid: session.id, oldHost: String(session['host']), claim, hostOf, roleOf };
}

describe('claim-host', () => {
  it('refuses a workspace member who is not an admin (403, audited) and outsiders (404)', async () => {
    const env = await setup();
    env.world.addMember(env.sid, env.w.member, 'editor');
    const res = await env.claim(env.w.member);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('role_insufficient');
    expect((await env.claim(env.w.outsider)).statusCode).toBe(404);
    expect(env.hostOf()).toBe(env.oldHost);
    const denied = (await env.detached()).filter((r) => r['action'] === 'permission.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ outcome: 'denied' });
  });

  it('answers 409 while the host is connected, changing nothing', async () => {
    const env = await setup();
    const s = env.world.sessions.get(env.sid);
    if (s !== undefined) s.row.host_connected = true;
    const res = await env.claim(env.w.admin);
    expect(res.statusCode).toBe(409);
    expect(env.hostOf()).toBe(env.oldHost);
    expect(env.world.audit).toHaveLength(0);
    expect(env.hostChanges).toHaveLength(0);
    expect(env.world.members.some((m) => m.userId === env.w.admin.user)).toBe(false);
  });

  it('makes the admin host and the old host an editor, with one audit event and one notification', async () => {
    const env = await setup();
    const mid = env.world.addMember(env.sid, env.w.admin, 'editor');
    const res = await env.claim(env.w.admin);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ host: string }>().host).toBe(mid);
    expect(env.hostOf()).toBe(mid);
    expect(env.roleOf(mid)).toBe('host');
    expect(env.roleOf(env.oldHost)).toBe('editor');
    const audits = env.world.audit.filter((r) => r['action'] === 'control.transfer_host');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ target_type: 'session_member', target_id: mid });
    expect(env.hostChanges).toEqual([{ sid: env.sid, host: mid, code: 'failover' }]);
  });

  it('lets an owner who is not yet in the session join, then claim', async () => {
    const env = await setup();
    // The owner created it; an admin of the same workspace who never joined claims it.
    const res = await env.claim(env.w.admin);
    expect(res.statusCode).toBe(200);
    const row = env.world.members.find((m) => m.userId === env.w.admin.user);
    expect(row).toMatchObject({ role: 'host', slot: 1, deviceId: env.w.admin.device });
    expect(env.roleOf(env.oldHost)).toBe('editor');
  });

  it('changes nothing when the caller already is the host', async () => {
    const env = await setup();
    const res = await env.claim(env.w.owner);
    expect(res.statusCode).toBe(200);
    expect(env.world.audit).toHaveLength(0);
    expect(env.hostChanges).toHaveLength(0);
  });

  it('commits and answers 200 with the relay notifier down; the queued change goes out later', async () => {
    const env = await setup();
    env.flags.failNotifier = true;
    const res = await env.claim(env.w.admin);
    expect(res.statusCode).toBe(200);
    const mid = env.hostOf();
    expect(env.roleOf(mid)).toBe('host');
    expect(env.hostChanges).toHaveLength(0);
    expect(env.world.hostOutbox).toHaveLength(1);
    expect(env.world.hostOutbox[0]).toMatchObject({ attempts: 1 });
    expect(env.recorded.count('session_host_outbox_failed_total')).toBe(1);
    // Not due yet: the retry waits 5 s.
    env.flags.failNotifier = false;
    expect(await deliverHostChanges(env.deps, env.clock.now())).toBe(0);
    expect(await deliverHostChanges(env.deps, env.clock.now() + 5_000)).toBe(1);
    expect(env.hostChanges).toEqual([{ sid: env.sid, host: mid, code: 'failover' }]);
    expect(env.world.hostOutbox).toHaveLength(0);
    expect(await deliverHostChanges(env.deps, env.clock.now() + 60_000)).toBe(0);
  });

  it('demotes every live host, also one a relay-side transfer left out of host_member_id', async () => {
    const env = await setup();
    // B051's control.transfer_host swaps roles without moving sessions.host_member_id.
    const b = env.world.addMember(env.sid, env.w.member, 'editor');
    const owner = env.world.members.find((m) => m.id === env.oldHost);
    const bRow = env.world.members.find((m) => m.id === b);
    if (owner === undefined || bRow === undefined) throw new Error('no rows');
    owner.role = 'editor';
    bRow.role = 'host';
    const res = await env.claim(env.w.admin);
    expect(res.statusCode).toBe(200);
    const hosts = env.world.members.filter((m) => m.sessionId === env.sid && m.role === 'host');
    expect(hosts.map((m) => m.userId)).toEqual([env.w.admin.user]);
    expect(env.roleOf(b)).toBe('editor');
  });

  it('treats a stale host_member_id naming the claimant as a claim, not as already done', async () => {
    const env = await setup();
    // The owner handed the host to the member on the relay; the column still names the owner.
    const b = env.world.addMember(env.sid, env.w.member, 'editor');
    const owner = env.world.members.find((m) => m.id === env.oldHost);
    const bRow = env.world.members.find((m) => m.id === b);
    if (owner === undefined || bRow === undefined) throw new Error('no rows');
    owner.role = 'editor';
    bRow.role = 'host';
    const res = await env.claim(env.w.owner);
    expect(res.statusCode).toBe(200);
    expect(env.roleOf(env.oldHost)).toBe('host');
    expect(env.roleOf(b)).toBe('editor');
  });

  it('removes the membership it added when the claim is then refused', async () => {
    const world = new World();
    const w = world.workspace('team');
    const base = await sessionsApp({ world });
    const { id: sid } = await base.create(w.owner, w.id);
    const store = world.store();
    const env = await sessionsApp({
      world,
      deps: {
        store: {
          ...store,
          // The host connects between the route's check and the claim's lock.
          claimHost: () => Promise.resolve({ kind: 'host_present' }),
        },
      },
    });
    const res = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sid}/claim-host`,
      headers: await env.as(w.admin),
    });
    expect(res.statusCode).toBe(409);
    expect(world.members.some((m) => m.userId === w.admin.user)).toBe(false);
    expect([...(world.slots.get(sid)?.keys() ?? [])]).toHaveLength(1);
    expect(world.released).toHaveLength(1);
  });

  it('removes the membership it added when the claim throws', async () => {
    const world = new World();
    const w = world.workspace('team');
    const base = await sessionsApp({ world });
    const { id: sid } = await base.create(w.owner, w.id);
    const store = world.store();
    const env = await sessionsApp({
      world,
      deps: { store: { ...store, claimHost: () => Promise.reject(new Error('connection lost')) } },
    });
    const res = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sid}/claim-host`,
      headers: await env.as(w.admin),
    });
    expect(res.statusCode).toBe(500);
    expect(world.members.some((m) => m.userId === w.admin.user)).toBe(false);
    expect(world.released).toHaveLength(1);
  });

  it('answers 410 on an ended session', async () => {
    const env = await setup();
    await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${env.sid}/end`,
      headers: await env.as(env.w.owner),
    });
    const res = await env.claim(env.w.admin);
    expect(res.statusCode).toBe(410);
    expect(res.json<{ code: string }>().code).toBe('session_ended');
  });
});
