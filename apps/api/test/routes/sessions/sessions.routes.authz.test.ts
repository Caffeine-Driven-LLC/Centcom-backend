/**
 * Scope and role checks of the session routes (B054; test "sessions.routes.authz.test.ts": the
 * scope x role matrix of the CT-API-SESSIONS table; acceptance 1, 5, 6 and 8):
 *
 * - every route without its scope is 403 `forbidden` (create without `sessions:host` included);
 * - an API key (a machine principal) is 403 on every route, join-token and create included, even
 *   with every scope: keys never become members, so create never finds one (CT-AUTH);
 * - each workspace role (owner, admin, member, billing, guest) and an outsider on list, create,
 *   get, patch, end, join-token and members, by the table's Role column;
 * - a session the caller may not see is 404 (not 403), so its existence is not confirmed.
 */
import { describe, expect, it } from 'vitest';
import { sessionsApp, World } from './helpers.js';

type Who = 'owner' | 'admin' | 'member' | 'billing' | 'guest' | 'outsider';
const ROLES: Who[] = ['owner', 'admin', 'member', 'billing', 'guest', 'outsider'];

async function setup() {
  const world = new World();
  const w = world.workspace('team');
  const env = await sessionsApp({ world });
  const session = await env.create(w.owner, w.id);
  return { ...env, w, sid: session.id };
}

describe('scopes', () => {
  const routes: {
    method: 'GET' | 'POST' | 'PATCH';
    url: (sid: string, ws: string) => string;
    scope: string;
    payload?: Record<string, unknown>;
  }[] = [
    { method: 'GET', url: (_s, ws) => `/v1/sessions?workspace=${ws}`, scope: 'sessions:read' },
    { method: 'POST', url: () => '/v1/sessions', scope: 'sessions:host' },
    { method: 'GET', url: (s) => `/v1/sessions/${s}`, scope: 'sessions:read' },
    {
      method: 'PATCH',
      url: (s) => `/v1/sessions/${s}`,
      scope: 'sessions:host',
      payload: { name: 'x' },
    },
    { method: 'POST', url: (s) => `/v1/sessions/${s}/end`, scope: 'sessions:host' },
    {
      method: 'POST',
      url: (s) => `/v1/sessions/${s}/join-token`,
      scope: 'sessions:write',
      payload: {},
    },
    { method: 'POST', url: (s) => `/v1/sessions/${s}/claim-host`, scope: 'sessions:host' },
    { method: 'GET', url: (s) => `/v1/sessions/${s}/members`, scope: 'sessions:read' },
  ];

  it('refuses every route without its scope with 403 forbidden', async () => {
    const env = await setup();
    for (const route of routes) {
      const others = ['sessions:read', 'sessions:write', 'sessions:host'].filter(
        (s) => s !== route.scope,
      );
      const res = await env.app.inject({
        method: route.method,
        url: route.url(env.sid, env.w.id),
        headers: await env.as(env.w.owner, others),
        ...(route.method === 'GET'
          ? {}
          : { payload: route.payload ?? { workspace: env.w.id, name: 'x' } }),
      });
      expect(res.statusCode, `${route.method} ${route.url('{id}', '{ws}')}`).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('forbidden');
    }
  });

  it('POST /v1/sessions without sessions:host is 403 forbidden and writes nothing', async () => {
    const env = await setup();
    const before = env.world.sessions.size;
    const res = await env.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: await env.as(env.w.member, ['sessions:read', 'sessions:write']),
      payload: { workspace: env.w.id, name: 'No scope' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('forbidden');
    expect(env.world.sessions.size).toBe(before);
  });

  it('refuses an API key on every route, even with every scope; keys never become members', async () => {
    const env = await setup();
    const headers = env.asKey(env.w.id);
    for (const route of routes) {
      const res = await env.app.inject({
        method: route.method,
        url: route.url(env.sid, env.w.id),
        headers,
        ...(route.method === 'GET'
          ? {}
          : { payload: route.payload ?? { workspace: env.w.id, name: 'Bot' } }),
      });
      expect(res.statusCode, `${route.method} ${route.url('{id}', '{ws}')}`).toBe(403);
    }
    // No session and no member came from the key.
    expect(env.world.sessions.size).toBe(1);
    expect(env.world.members).toHaveLength(1);
  });

  it('refuses an API key without the scope on create too', async () => {
    const env = await setup();
    const res = await env.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: env.asKey(env.w.id, ['sessions:read']),
      payload: { workspace: env.w.id, name: 'Bot' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('roles (CT-API-SESSIONS Role column)', () => {
  const expectStatus = async (
    env: Awaited<ReturnType<typeof setup>>,
    who: Who,
    req: { method: 'GET' | 'POST' | 'PATCH'; url: string; payload?: Record<string, unknown> },
  ) => {
    const res = await env.app.inject({
      method: req.method,
      url: req.url,
      headers: await env.as(env.w[who]),
      ...(req.payload === undefined ? {} : { payload: req.payload as object }),
    });
    return { status: res.statusCode, code: res.json<{ code?: string }>().code };
  };

  it('list ?workspace: member+ 200; anyone else 403 (listSessions declares no 404)', async () => {
    const env = await setup();
    const want: Record<Who, number> = {
      owner: 200,
      admin: 200,
      member: 200,
      billing: 403,
      guest: 403,
      outsider: 403,
    };
    for (const who of ROLES) {
      const got = await expectStatus(env, who, {
        method: 'GET',
        url: `/v1/sessions?workspace=${env.w.id}`,
      });
      expect(got.status, who).toBe(want[who]);
    }
  });

  it('create: member+ 201; billing and guest 403; outsider 404 workspace_not_found', async () => {
    const env = await setup();
    const want: Record<Who, number> = {
      owner: 201,
      admin: 201,
      member: 201,
      billing: 403,
      guest: 403,
      outsider: 404,
    };
    for (const who of ROLES) {
      const got = await expectStatus(env, who, {
        method: 'POST',
        url: '/v1/sessions',
        payload: { workspace: env.w.id, name: `By ${who}` },
      });
      expect(got.status, who).toBe(want[who]);
      if (who === 'outsider') expect(got.code).toBe('workspace_not_found');
    }
  });

  it('get: who may join or is in it 200; billing, an uninvited guest and outsiders 404', async () => {
    const env = await setup();
    const want: Record<Who, number> = {
      owner: 200,
      admin: 200,
      member: 200,
      billing: 404,
      guest: 404,
      outsider: 404,
    };
    for (const who of ROLES) {
      const got = await expectStatus(env, who, { method: 'GET', url: `/v1/sessions/${env.sid}` });
      expect(got.status, who).toBe(want[who]);
      if (got.status === 404) expect(got.code).toBe('session_not_found');
    }
    // A guest in the session (a viewer) sees it.
    env.world.addMember(env.sid, env.w.guest, 'viewer');
    expect(
      (await expectStatus(env, 'guest', { method: 'GET', url: `/v1/sessions/${env.sid}` })).status,
    ).toBe(200);
  });

  it('patch: the host only (403 host_required); outsiders 404', async () => {
    const env = await setup();
    env.world.addMember(env.sid, env.w.member, 'editor');
    const want: Record<Who, number> = {
      owner: 200,
      admin: 403,
      member: 403,
      billing: 404,
      guest: 404,
      outsider: 404,
    };
    for (const who of ROLES) {
      const got = await expectStatus(env, who, {
        method: 'PATCH',
        url: `/v1/sessions/${env.sid}`,
        payload: { name: `Renamed by ${who}` },
      });
      expect(got.status, who).toBe(want[who]);
      if (got.status === 403) expect(got.code).toBe('host_required');
    }
  });

  it('end: a member is 403 host_required; an admin may end it (B053)', async () => {
    const env = await setup();
    expect(
      (await expectStatus(env, 'member', { method: 'POST', url: `/v1/sessions/${env.sid}/end` }))
        .code,
    ).toBe('host_required');
    const denied = (await env.detached()).filter((r) => r['action'] === 'permission.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ outcome: 'denied' });
    expect(JSON.stringify(denied[0])).toContain('control.end');
    expect(
      (await expectStatus(env, 'outsider', { method: 'POST', url: `/v1/sessions/${env.sid}/end` }))
        .status,
    ).toBe(404);
    const ended = await expectStatus(env, 'admin', {
      method: 'POST',
      url: `/v1/sessions/${env.sid}/end`,
    });
    expect(ended.status).toBe(200);
  });

  it('join-token: member+ 200; billing and an uninvited guest 403; outsider 404', async () => {
    const env = await setup();
    const want: Record<Who, number> = {
      owner: 200,
      admin: 200,
      member: 200,
      billing: 403,
      guest: 403,
      outsider: 404,
    };
    for (const who of ROLES) {
      const got = await expectStatus(env, who, {
        method: 'POST',
        url: `/v1/sessions/${env.sid}/join-token`,
        payload: {},
      });
      expect(got.status, who).toBe(want[who]);
    }
  });

  it('members: live members 200; a workspace member not in it and outsiders 404 (not 403)', async () => {
    const env = await setup();
    const want: Record<Who, number> = {
      owner: 200,
      admin: 404,
      member: 404,
      billing: 404,
      guest: 404,
      outsider: 404,
    };
    for (const who of ROLES) {
      const got = await expectStatus(env, who, {
        method: 'GET',
        url: `/v1/sessions/${env.sid}/members`,
      });
      expect(got.status, who).toBe(want[who]);
      if (got.status === 404) expect(got.code).toBe('session_not_found');
    }
  });

  it('answers 404 for an id that is not a session id, and for an unknown session', async () => {
    const env = await setup();
    for (const url of ['/v1/sessions/nope', `/v1/sessions/ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W`]) {
      const res = await env.app.inject({ method: 'GET', url, headers: await env.as(env.w.owner) });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('session_not_found');
    }
  });

  it('audits refused privileged joins (CT-RBAC rule 6)', async () => {
    const env = await setup();
    await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${env.sid}/join-token`,
      headers: await env.as(env.w.billing),
      payload: {},
    });
    const rows = await env.detached();
    expect(rows.some((r) => r['action'] === 'permission.denied')).toBe(true);
  });
});
