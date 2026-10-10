/**
 * PATCH and end (B054, acceptance 6; failure mode "SessionStateError: 409, no partial change"):
 *
 * - the ETag of GET is accepted by If-Match; a stale one is 412 `precondition_failed`, nothing
 *   changed; two PATCHes with the same ETag: one 200, one 412;
 * - an editor is 403; a name of 81 characters is 422 with `errors[0].pointer` `/name`;
 * - PATCH changes the name and policy, returns a new ETag, and is audited `control.policy`;
 * - a stale If-Match writes nothing (name, policy and audit are one transaction);
 * - a transition B053's state machine refuses (end) is 409 `conflict`;
 * - end: 200 with state `ended`, audited `session.end` once; ending again returns it as is.
 */
import { describe, expect, it } from 'vitest';
import { SessionStateError } from '../../../src/modules/sessions/index.js';
import { sessionsApp, World } from './helpers.js';

async function setup() {
  const world = new World();
  const w = world.workspace('team');
  const env = await sessionsApp({ world });
  const session = await env.create(w.owner, w.id);
  const get = async () =>
    env.app.inject({
      method: 'GET',
      url: `/v1/sessions/${session.id}`,
      headers: await env.as(w.owner),
    });
  const patch = async (
    payload: Record<string, unknown>,
    headers: Record<string, string> = {},
    who: { user: string; device: string } = w.owner,
  ) =>
    env.app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${session.id}`,
      headers: { ...(await env.as(who)), ...headers },
      payload,
    });
  return { ...env, w, sid: session.id, get, patch };
}

describe('PATCH /v1/sessions/{id}', () => {
  it('applies with the current ETag and answers a new one; a stale one is 412', async () => {
    const env = await setup();
    const etag = String((await env.get()).headers['etag']);
    expect(etag).toMatch(/^"s[A-Za-z0-9_-]{22}"$/);
    const ok = await env.patch(
      { name: 'Renamed', policy: { auto_approve: 'trusted', queue_limit: 5 } },
      { 'if-match': etag },
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      name: 'Renamed',
      policy: { auto_approve: 'trusted', queue_limit: 5, locked: false },
    });
    const next = String(ok.headers['etag']);
    expect(next).not.toBe(etag);
    expect((await env.get()).headers['etag']).toBe(next);
    const stale = await env.patch({ name: 'Again' }, { 'if-match': etag });
    expect(stale.statusCode).toBe(412);
    expect(stale.json<{ code: string }>().code).toBe('precondition_failed');
    expect(env.world.sessions.get(env.sid)?.row.name).toBe('Renamed');
    expect((await env.patch({ name: 'Weak' }, { 'if-match': `W/${next}` })).statusCode).toBe(412);
    expect((await env.patch({ name: 'Any' }, { 'if-match': '*' })).statusCode).toBe(200);
  });

  it('lets one of two PATCHes with the same ETag through', async () => {
    const env = await setup();
    const etag = String((await env.get()).headers['etag']);
    const results = await Promise.all([
      env.patch({ name: 'First' }, { 'if-match': etag }),
      env.patch({ name: 'Second' }, { 'if-match': etag }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 412]);
  });

  it('refuses an editor with 403', async () => {
    const env = await setup();
    env.world.addMember(env.sid, env.w.member, 'editor');
    const res = await env.patch({ name: 'Mine now' }, {}, env.w.member);
    expect(res.statusCode).toBe(403);
    const denied = (await env.detached()).filter((r) => r['action'] === 'permission.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ outcome: 'denied' });
    expect(env.world.sessions.get(env.sid)?.row.name).toBe('Release train');
  });

  it('refuses a name of 81 characters with 422 at /name, and bad bodies', async () => {
    const env = await setup();
    const res = await env.patch({ name: 'x'.repeat(81) });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ errors: { pointer: string }[] }>().errors[0]?.pointer).toBe('/name');
    expect((await env.patch({})).statusCode).toBe(422);
    const policy = await env.patch({ policy: { queue_limit: 0 } });
    expect(policy.statusCode).toBe(422);
    expect(policy.json<{ errors: { pointer: string }[] }>().errors[0]?.pointer).toBe(
      '/policy/queue_limit',
    );
    expect((await env.patch({ name: 'x'.repeat(80) })).statusCode).toBe(200);
  });

  it('audits control.policy with the fields sent', async () => {
    const env = await setup();
    await env.patch({ name: 'Audited', policy: { locked: true } });
    // Written in the PATCH's transaction, with the change.
    const rows = env.world.audit.filter((r) => r['action'] === 'control.policy');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).toContain('name,policy');
    expect(JSON.stringify(rows[0])).not.toContain('Audited');
  });

  it('writes nothing, and no audit event, when the If-Match is stale (one transaction)', async () => {
    const env = await setup();
    const res = await env.patch(
      { name: 'Half', policy: { locked: true } },
      { 'if-match': '"sAAAAAAAAAAAAAAAAAAAAAA"' },
    );
    expect(res.statusCode).toBe(412);
    expect(env.world.sessions.get(env.sid)).toMatchObject({
      row: { name: 'Release train' },
      policy: null,
    });
    expect(env.world.audit.filter((r) => r['action'] === 'control.policy')).toHaveLength(0);
  });

  it('answers 410 on an ended session', async () => {
    const env = await setup();
    await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${env.sid}/end`,
      headers: await env.as(env.w.owner),
    });
    const res = await env.patch({ name: 'Too late' });
    expect(res.statusCode).toBe(410);
  });

  it('maps a SessionStateError from end to 409 conflict with nothing changed', async () => {
    const world = new World();
    const w = world.workspace('team');
    const base = await sessionsApp({ world });
    const session = await base.create(w.owner, w.id);
    const env = await sessionsApp({
      world,
      deps: {
        service: {
          get: (id) => base.service.get(id),
          list: (q) => base.service.list(q),
          create: (i) => base.service.create(i),
          setPolicyDefaults: (id, p, by) => base.service.setPolicyDefaults(id, p, by),
          rename: () => Promise.reject(new SessionStateError('ended', 'end')),
          end: () => Promise.reject(new SessionStateError('expired', 'end')),
        },
      },
    });
    const end = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/end`,
      headers: await env.as(w.owner),
    });
    expect(end.statusCode).toBe(409);
    expect(world.sessions.get(session.id)?.row).toMatchObject({
      name: 'Release train',
      state: 'live',
    });
  });
});

describe('POST /v1/sessions/{id}/end', () => {
  it('ends the session once, audited once; again returns it as it is', async () => {
    const env = await setup();
    const end = async () =>
      env.app.inject({
        method: 'POST',
        url: `/v1/sessions/${env.sid}/end`,
        headers: await env.as(env.w.owner),
      });
    const first = await end();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ state: 'ended' });
    expect((await end()).statusCode).toBe(200);
    const rows = (await env.detached()).filter((r) => r['action'] === 'session.end');
    expect(rows).toHaveLength(1);
  });
});
