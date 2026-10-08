/**
 * The internal admin API over HTTP (B087), on the admin listener with an in-memory store, real
 * B017 tokens, B083's FlagAdmin and B086's StatusAdmin:
 *
 * - the authz matrix: every route x every kind of caller (no token, a malformed header, an expired
 *   token, a relay ticket, an API key, a user without `admin`, `admin` without a staff row, a
 *   disabled staff row, and each staff role);
 * - audit completeness: every registered route (walked from the listener), called anonymously, as
 *   `support_ro` and as `superadmin`, writes exactly one `staff.access` event with the request's
 *   id, actor, target, outcome, reason and ticket;
 * - reasons and tickets, masking for `support_ro`, staff management (superadmin only, never
 *   oneself), session metadata only, the redaction scan, revoke-tokens then refresh, disable,
 *   flags reaching `GET /v1/flags`, dependency and audit failures, impersonation attempts, the
 *   rate limit, staff removed mid-session.
 */
import { newId, validate } from '@centcom/contracts';
import { fastify, type LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { StaffRole } from '@centcom/db';
import { FlagCache, FlagService } from '../../src/modules/flags/index.js';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.js';
import { requestContextPlugin } from '../../src/plugins/request-context.js';
import { flagRoutes } from '../../src/routes/flags.js';
import { until } from '../flags/helpers.js';
import { captureLogger } from '../helpers.js';
import { adminWorld, BASE, REASON, type AdminWorld, type AuditRow } from './helpers.js';

let w: AdminWorld;
afterEach(async () => {
  await w.close();
});

/** What every route is called on. */
interface Targets {
  user: string;
  email: string;
  workspace: string;
  session: string;
  invite: string;
  incident: string;
  staffUser: string;
}

/** One admin route: its template, the least role, its success status and a call to it. */
interface RouteCase {
  method: string;
  pattern: string;
  minRole: StaffRole;
  status: number;
  call: (w: AdminWorld, t: Targets) => Promise<{ path: string; body?: unknown }>;
}

const ROUTES: RouteCase[] = [
  {
    method: 'GET',
    pattern: '/users/:id',
    minRole: 'support_ro',
    status: 200,
    call: (_w, t) => Promise.resolve({ path: `users/${t.user}` }),
  },
  {
    method: 'GET',
    pattern: '/users',
    minRole: 'support_ro',
    status: 200,
    call: (_w, t) => Promise.resolve({ path: `users?email=${encodeURIComponent(t.email)}` }),
  },
  {
    method: 'GET',
    pattern: '/workspaces/:id',
    minRole: 'support_ro',
    status: 200,
    call: (_w, t) => Promise.resolve({ path: `workspaces/${t.workspace}` }),
  },
  {
    method: 'GET',
    pattern: '/sessions/:id',
    minRole: 'support_ro',
    status: 200,
    call: (_w, t) => Promise.resolve({ path: `sessions/${t.session}` }),
  },
  {
    method: 'GET',
    pattern: '/staff-audit',
    minRole: 'support_ro',
    status: 200,
    call: () => Promise.resolve({ path: 'staff-audit?limit=5' }),
  },
  {
    method: 'POST',
    pattern: '/users/:id/revoke-tokens',
    minRole: 'support_rw',
    status: 200,
    call: (_w, t) => Promise.resolve({ path: `users/${t.user}/revoke-tokens`, body: {} }),
  },
  {
    method: 'POST',
    pattern: '/users/:id/disable',
    minRole: 'support_rw',
    status: 200,
    call: (_w, t) => Promise.resolve({ path: `users/${t.user}/disable` }),
  },
  {
    method: 'POST',
    pattern: '/sessions/:id/end',
    minRole: 'support_rw',
    status: 200,
    call: (_w, t) => Promise.resolve({ path: `sessions/${t.session}/end` }),
  },
  {
    method: 'POST',
    pattern: '/invites/:id/resend',
    minRole: 'support_rw',
    status: 200,
    call: (_w, t) => Promise.resolve({ path: `invites/${t.invite}/resend` }),
  },
  {
    method: 'POST',
    pattern: '/workspaces/:id/promotions',
    minRole: 'support_rw',
    status: 200,
    call: (_w, t) =>
      Promise.resolve({
        path: `workspaces/${t.workspace}/promotions`,
        body: { promotion_code_id: 'promo_1Pq2Rs3Tu' },
      }),
  },
  {
    method: 'PUT',
    pattern: '/flags/:key',
    minRole: 'support_rw',
    status: 200,
    call: () =>
      Promise.resolve({
        path: 'flags/banner',
        body: { type: 'bool', value: true, default: false, public: true },
      }),
  },
  {
    method: 'DELETE',
    pattern: '/flags/:key',
    minRole: 'support_rw',
    status: 200,
    call: async (world) => {
      const key = `old.${newId('usr').slice(-8).toLowerCase()}`;
      await world.flagAdmin.setFlag(
        { key, type: 'bool', value: true, default: false },
        { kind: 'user', userId: newId('usr'), scopes: ['admin'] },
      );
      return { path: `flags/${key}` };
    },
  },
  {
    method: 'POST',
    pattern: '/incidents',
    minRole: 'support_rw',
    status: 201,
    call: () =>
      Promise.resolve({
        path: 'incidents',
        body: { title: 'Elevated latency', component_ids: ['api'], status: 'investigating' },
      }),
  },
  {
    method: 'POST',
    pattern: '/incidents/:id/updates',
    minRole: 'support_rw',
    status: 201,
    call: (_w, t) =>
      Promise.resolve({
        path: `incidents/${t.incident}/updates`,
        body: { text: 'We are looking into it.' },
      }),
  },
  {
    method: 'PUT',
    pattern: '/staff/:userId',
    minRole: 'superadmin',
    status: 200,
    call: (_w, t) =>
      Promise.resolve({ path: `staff/${t.staffUser}`, body: { role: 'support_ro' } }),
  },
  {
    method: 'DELETE',
    pattern: '/staff/:userId',
    minRole: 'superadmin',
    status: 200,
    call: (_w, t) => Promise.resolve({ path: `staff/${t.staffUser}` }),
  },
];

/** Seeds what the routes act on. */
async function seed(world: AdminWorld): Promise<Targets> {
  const owner = world.store.addUser({ email: 'alice@example.com', display_name: 'Alice' });
  world.store.addDevice(owner.id);
  const workspace = world.store.addWorkspace(owner.id, [
    { userId: world.store.addUser({ email: 'bob@example.org' }).id, role: 'member' },
  ]);
  const session = world.store.addSession(workspace);
  const incident = await world.call('POST', 'incidents', {
    token: (await world.staff('superadmin')).token,
    body: { title: 'Seed incident', component_ids: ['api'], status: 'investigating' },
  });
  const staffUser = world.store.addUser().id;
  world.store.addStaff(staffUser, 'support_ro');
  return {
    user: owner.id,
    email: 'ALICE@example.com',
    workspace,
    session: session.id,
    invite: newId('inv'),
    incident: (incident.json() as { id: string }).id,
    staffUser,
  };
}

const ROLE_ORDER: StaffRole[] = ['support_ro', 'support_rw', 'superadmin'];
const allows = (role: StaffRole, min: StaffRole): boolean =>
  ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);

/** The rows written since `before`. */
const newRows = (world: AdminWorld, before: number): AuditRow[] => world.store.rows().slice(before);

/** A JSON body's code. */
const codeOf = (res: LightMyRequestResponse): unknown => (res.json() as { code?: unknown }).code;

describe('routes', () => {
  it('serves exactly the card routes (and staff management) under /internal/admin/v1', async () => {
    w = await adminWorld();
    const registered = w.app.adminRoutes
      .filter((r) => r.method !== 'HEAD')
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(registered).toEqual(ROUTES.map((r) => `${r.method} ${BASE}${r.pattern}`).sort());
  });
});

describe('authz matrix (acceptance 1, 4)', () => {
  it('refuses every caller but staff of the right role, on every route, with no data', async () => {
    w = await adminWorld();
    // An expired token first: the clock then moves past its 15 minutes.
    const expired = (await w.staff('superadmin')).token;
    w.clock.advance(16 * 60 * 1000);
    const t = await seed(w);
    const disabledStaff = await w.staff('superadmin');
    w.store.addStaff(disabledStaff.userId, 'superadmin', true);
    const callers: {
      name: string;
      headers: Record<string, string>;
      status: number;
      code: string;
    }[] = [
      { name: 'no token', headers: {}, status: 401, code: 'unauthorized' },
      {
        name: 'malformed',
        headers: { authorization: 'Basic YWRtaW4=' },
        status: 401,
        code: 'unauthorized',
      },
      {
        name: 'expired',
        headers: { authorization: `Bearer ${expired}` },
        status: 401,
        code: 'token_expired',
      },
      {
        name: 'relay ticket',
        headers: { authorization: `Bearer ${await w.relayTicket()}` },
        status: 401,
        code: 'token_invalid',
      },
      {
        name: 'api key',
        headers: { authorization: `Bearer ${w.apiKey()}` },
        status: 403,
        code: 'forbidden',
      },
      {
        name: 'user without admin',
        headers: {
          authorization: `Bearer ${(await w.userToken(['profile', 'workspaces:read'])).token}`,
        },
        status: 403,
        code: 'forbidden',
      },
      {
        name: 'admin without staff row',
        headers: { authorization: `Bearer ${(await w.userToken(['admin'])).token}` },
        status: 403,
        code: 'forbidden',
      },
      {
        name: 'disabled staff',
        headers: { authorization: `Bearer ${disabledStaff.token}` },
        status: 403,
        code: 'forbidden',
      },
    ];
    for (const route of ROUTES) {
      for (const caller of callers) {
        const { path, body } = await route.call(w, t);
        const before = w.store.rows().length;
        const res = await w.call(route.method, path, {
          headers: caller.headers,
          ...(body === undefined ? {} : { body }),
        });
        const where = `${route.method} ${route.pattern} as ${caller.name}`;
        expect(res.statusCode, where).toBe(caller.status);
        expect(res.headers['content-type'], where).toBe('application/problem+json');
        expect(Object.keys(res.json() as object).sort(), where).toEqual(
          ['code', 'detail', 'instance', 'request_id', 'status', 'title', 'type'].sort(),
        );
        expect(codeOf(res), where).toBe(caller.code);
        const rows = newRows(w, before);
        expect(rows, where).toHaveLength(1);
        expect(rows[0]?.outcome, where).toBe('denied');
      }
      for (const role of ROLE_ORDER) {
        const staff = await w.staff(role);
        const { path, body } = await route.call(w, t);
        const before = w.store.rows().length;
        const res = await w.call(route.method, path, {
          token: staff.token,
          ticket: 'SUP-1234',
          ...(body === undefined ? {} : { body }),
        });
        const where = `${route.method} ${route.pattern} as ${role}`;
        const rows = newRows(w, before);
        expect(rows, where).toHaveLength(1);
        if (allows(role, route.minRole)) {
          expect(res.statusCode, `${where}: ${res.body}`).toBe(route.status);
          expect(rows[0]?.outcome, where).toBe('success');
        } else {
          expect(res.statusCode, where).toBe(403);
          expect(codeOf(res), where).toBe('forbidden');
          expect(rows[0]?.outcome, where).toBe('denied');
        }
        expect(rows[0], where).toMatchObject({
          actor_type: 'staff',
          actor_id: staff.userId,
          reason: REASON,
          ticket: 'SUP-1234',
        });
      }
    }
  });
});

describe('audit completeness (acceptance 3)', () => {
  it('writes exactly one event per call on every registered route, whoever calls', async () => {
    w = await adminWorld();
    const t = await seed(w);
    const routes = w.app.adminRoutes;
    expect(routes.length).toBeGreaterThan(ROUTES.length); // HEAD twins of the GET routes too
    for (const registered of routes) {
      const method = registered.method === 'HEAD' ? 'GET' : registered.method;
      const route = ROUTES.find(
        (r) => r.method === method && `${BASE}${r.pattern}` === registered.url,
      );
      expect(route, `${registered.method} ${registered.url}`).toBeDefined();
      if (route === undefined) continue;
      for (const as of ['anonymous', 'support_ro', 'superadmin'] as const) {
        const staff = as === 'anonymous' ? undefined : await w.staff(as);
        const { path, body } = await route.call(w, t);
        const before = w.store.rows().length;
        const res = await w.call(registered.method, path, {
          ...(staff === undefined ? {} : { token: staff.token }),
          ticket: 'OPS-77',
          ...(body === undefined || registered.method === 'HEAD' ? {} : { body }),
        });
        const where = `${registered.method} ${registered.url} as ${as}`;
        const rows = newRows(w, before);
        expect(rows, where).toHaveLength(1);
        const row = rows[0] as AuditRow;
        expect(row.action).toBe('staff.access');
        expect(row.request_id, where).toBe(res.headers['x-request-id']);
        expect(row.meta, where).toMatchObject({
          method: registered.method,
          route: registered.url,
          status: res.statusCode,
        });
        expect(row.reason, where).toBe(REASON);
        expect(row.ticket, where).toBe('OPS-77');
        expect(row.outcome, where).toBe(
          res.statusCode < 400 ? 'success' : res.statusCode === 404 ? 'failed' : 'denied',
        );
        if (as === 'anonymous') {
          expect(row, where).toMatchObject({ actor_type: 'system', actor_id: 'admin-api' });
        } else {
          expect(row, where).toMatchObject({ actor_type: 'staff', actor_id: staff?.userId });
        }
        if (
          res.statusCode < 400 &&
          route.pattern.includes(':') &&
          !route.pattern.includes('flags')
        ) {
          expect(row.target_id, where).not.toBeNull();
        }
      }
    }
  });

  it('records refusals Fastify itself makes, and unknown routes, with the caller', async () => {
    w = await adminWorld();
    const staff = await w.staff('support_rw');
    const user = w.store.addUser();
    let before = w.store.rows().length;
    const malformed = await w.app.inject({
      method: 'POST',
      url: `${BASE}/users/${user.id}/revoke-tokens`,
      headers: {
        authorization: `Bearer ${staff.token}`,
        'x-admin-reason': REASON,
        'content-type': 'application/json',
      },
      payload: '{"device":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(newRows(w, before)).toEqual([
      expect.objectContaining({
        actor_type: 'staff',
        actor_id: staff.userId,
        outcome: 'denied',
        meta: expect.objectContaining({ status: 400, code: 'invalid_request' }) as unknown,
      }),
    ]);

    before = w.store.rows().length;
    const unknown = await w.call('GET', 'nothing/here', { token: staff.token });
    expect(unknown.statusCode).toBe(404);
    expect(newRows(w, before)).toEqual([
      expect.objectContaining({
        actor_type: 'staff',
        outcome: 'denied',
        meta: expect.objectContaining({ route: '(unmatched)', status: 404 }) as unknown,
      }),
    ]);

    before = w.store.rows().length;
    const outside = await w.app.inject({ method: 'GET', url: '/v1/me' });
    expect(outside.statusCode).toBe(404);
    expect(newRows(w, before)).toHaveLength(1);
  });

  it('records a missing target as a failed call (404)', async () => {
    w = await adminWorld();
    const staff = await w.staff('support_rw');
    for (const path of [`users/${newId('usr')}`, `sessions/${newId('ses')}`, `users/not-an-id`]) {
      const before = w.store.rows().length;
      const res = await w.call('GET', path, { token: staff.token });
      expect(res.statusCode).toBe(404);
      expect(newRows(w, before)).toEqual([
        expect.objectContaining({
          outcome: 'failed',
          meta: expect.objectContaining({ code: 'not_found' }) as unknown,
        }),
      ]);
    }
  });
});

describe('reason and ticket (acceptance 2)', () => {
  it('refuses a call without a reason of 10-500 characters, or with a bad ticket, with 422 and a denied event', async () => {
    w = await adminWorld();
    const staff = await w.staff('superadmin');
    const user = w.store.addUser();
    const cases: { reason: string | null; ticket?: string; ok: boolean }[] = [
      { reason: null, ok: false },
      { reason: 'too short', ok: false },
      { reason: '          ', ok: false },
      { reason: 'x'.repeat(501), ok: false },
      { reason: REASON, ticket: 'has spaces in it', ok: false },
      { reason: REASON, ticket: 'x'.repeat(65), ok: false },
      { reason: '0123456789', ok: true },
      { reason: 'x'.repeat(500), ticket: 'JIRA-42/ops#3', ok: true },
    ];
    for (const c of cases) {
      const before = w.store.rows().length;
      const res = await w.call('GET', `users/${user.id}`, {
        token: staff.token,
        reason: c.reason,
        ...(c.ticket === undefined ? {} : { ticket: c.ticket }),
      });
      const rows = newRows(w, before);
      expect(rows).toHaveLength(1);
      if (c.ok) {
        expect(res.statusCode).toBe(200);
        expect(rows[0]).toMatchObject({ outcome: 'success', reason: c.reason?.trim() });
      } else {
        expect(res.statusCode).toBe(422);
        expect(codeOf(res)).toBe('validation_failed');
        expect(res.json()).not.toHaveProperty('email');
        expect(rows[0]).toMatchObject({
          outcome: 'denied',
          actor_type: 'staff',
          target_id: user.id,
          meta: expect.objectContaining({ code: 'validation_failed', status: 422 }) as unknown,
        });
      }
    }
  });
});

describe('roles and masking (acceptance 4)', () => {
  it('masks e-mail addresses for support_ro only', async () => {
    w = await adminWorld();
    const t = await seed(w);
    const ro = await w.staff('support_ro');
    const rw = await w.staff('support_rw');
    const asRo = await w.call('GET', `users/${t.user}`, { token: ro.token });
    expect((asRo.json() as { email: string }).email).toBe('a***@e***.com');
    const asRw = await w.call('GET', `users/${t.user}`, { token: rw.token });
    expect((asRw.json() as { email: string }).email).toBe('alice@example.com');

    const lookup = await w.call('GET', `users?email=${encodeURIComponent(t.email)}`, {
      token: ro.token,
    });
    expect(lookup.json()).toEqual({
      data: [expect.objectContaining({ id: t.user, email: 'a***@e***.com' }) as unknown],
    });
    const none = await w.call('GET', 'users?email=nobody%40example.com', { token: ro.token });
    expect(none.json()).toEqual({ data: [] });

    const ws = (await w.call('GET', `workspaces/${t.workspace}`, { token: ro.token })).json() as {
      members: { email: string }[];
    };
    expect(ws.members.map((m) => m.email)).toEqual(['a***@e***.com', 'b***@e***.org']);
    const wsRw = (await w.call('GET', `workspaces/${t.workspace}`, { token: rw.token })).json() as {
      members: { email: string }[];
    };
    expect(wsRw.members.map((m) => m.email)).toEqual(['alice@example.com', 'bob@example.org']);
  });

  it('lets only a superadmin add staff or change roles, and never about themselves', async () => {
    w = await adminWorld();
    const rw = await w.staff('support_rw');
    const boss = await w.staff('superadmin');
    const target = w.store.addUser();
    const put = (token: string, userId: string, role: string) =>
      w.call('PUT', `staff/${userId}`, { token, body: { role } });

    expect((await put(rw.token, target.id, 'support_ro')).statusCode).toBe(403);
    expect((await put(rw.token, rw.userId, 'superadmin')).statusCode).toBe(403);
    expect(w.store.state.staff.get(target.id)).toBeUndefined();
    expect(w.store.state.staff.get(rw.userId)?.role).toBe('support_rw');

    const added = await put(boss.token, target.id, 'support_rw');
    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({
      user: target.id,
      role: 'support_rw',
      added_by: boss.userId,
      disabled_at: null,
    });
    const self = await put(boss.token, boss.userId, 'support_ro');
    expect(self.statusCode).toBe(403);
    expect(codeOf(self)).toBe('forbidden');
    const selfDelete = await w.call('DELETE', `staff/${boss.userId}`, { token: boss.token });
    expect(selfDelete.statusCode).toBe(403);
    expect(w.store.state.staff.get(boss.userId)).toMatchObject({
      role: 'superadmin',
      disabled_at: null,
    });
    expect((await put(boss.token, target.id, 'owner')).statusCode).toBe(422);
    expect((await put(boss.token, newId('usr'), 'support_ro')).statusCode).toBe(404);

    const removed = await w.call('DELETE', `staff/${target.id}`, { token: boss.token });
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as { disabled_at: string | null }).disabled_at).not.toBeNull();
  });

  it('needs a superadmin to revoke or disable the account of an active staff member', async () => {
    w = await adminWorld();
    const rw = await w.staff('support_rw');
    const boss = await w.staff('superadmin');
    const colleague = await w.staff('support_ro');
    const refused = await w.call('POST', `users/${colleague.userId}/disable`, { token: rw.token });
    expect(refused.statusCode).toBe(403);
    expect(w.store.state.users.get(colleague.userId)?.login_disabled_at).toBeNull();
    const allowed = await w.call('POST', `users/${colleague.userId}/revoke-tokens`, {
      token: boss.token,
      body: {},
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('denies a staff member removed mid-session within 5 s', async () => {
    w = await adminWorld();
    const staff = await w.staff('support_rw');
    const user = w.store.addUser();
    expect((await w.call('GET', `users/${user.id}`, { token: staff.token })).statusCode).toBe(200);
    w.store.addStaff(staff.userId, 'support_rw', true);
    w.clock.advance(5_000);
    const res = await w.call('GET', `users/${user.id}`, { token: staff.token });
    expect(res.statusCode).toBe(403);
    expect(w.store.rows().at(-1)).toMatchObject({ outcome: 'denied', actor_type: 'user' });
  });
});

describe('what responses may hold (acceptance 5)', () => {
  it('answers GET /sessions/{id} with metadata fields only', async () => {
    w = await adminWorld();
    const session = w.store.addSession(newId('wsp'));
    const staff = await w.staff('support_ro');
    const res = await w.call('GET', `sessions/${session.id}`, { token: staff.token });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: session.id,
      workspace: session.workspace_id,
      state: 'live',
      region: 'eu',
      created_at: session.created_at.toISOString(),
      ended_at: null,
      member_count: 3,
      host_member: session.host_member,
    });
    const ended = await w.call('POST', `sessions/${session.id}/end`, {
      token: (await w.staff('support_rw')).token,
    });
    expect(ended.json()).toMatchObject({ state: 'ended', ended_at: expect.any(String) as unknown });
  });

  it('finds no content field, secret field or credential value in any response', async () => {
    w = await adminWorld();
    const t = await seed(w);
    // A careless display name: still never sent as it is.
    const leaky = w.store.addUser({ display_name: `cen_live_${'A'.repeat(32)}` });
    const forbiddenNames = /^(ct|p|secret|token|key_bundle)$|secret|token/i;
    const scan = (value: unknown, path: string): string[] => {
      if (typeof value === 'string') {
        return /^cen_live_|^eyJ|^(cus|sub|in|pi)_[A-Za-z0-9]{12,}$/.test(value) &&
          !/^(sub|in)_[0-9A-Z]{26}$/.test(value)
          ? [`${path}=${value}`]
          : [];
      }
      if (Array.isArray(value)) return value.flatMap((v, i) => scan(v, `${path}[${i}]`));
      if (typeof value !== 'object' || value === null) return [];
      return Object.entries(value).flatMap(([k, v]) => [
        ...(forbiddenNames.test(k) ? [`${path}.${k}`] : []),
        ...scan(v, `${path}.${k}`),
      ]);
    };
    const bodies: unknown[] = [];
    for (const role of ROLE_ORDER) {
      const staff = await w.staff(role);
      for (const route of ROUTES) {
        const { path, body } = await route.call(w, t);
        const res = await w.call(route.method, path, {
          token: staff.token,
          ...(body === undefined ? {} : { body }),
        });
        bodies.push(res.json());
      }
      bodies.push((await w.call('GET', `users/${leaky.id}`, { token: staff.token })).json());
    }
    expect(bodies.flatMap((b, i) => scan(b, `#${i}`))).toEqual([]);
    const promo = bodies.find(
      (b) => typeof b === 'object' && b !== null && 'subscription' in b,
    ) as { subscription: Record<string, unknown> };
    expect(promo.subscription['latest_invoice']).toBe('in_****zPMv');
  });
});

describe('revocation (acceptance 6)', () => {
  it('makes the next refresh fail with token_revoked, revokes access tokens, and announces it', async () => {
    w = await adminWorld();
    const target = w.store.addUser();
    const deviceId = newId('dev');
    w.tokenStore.devices.set(deviceId, { userId: target.id, revoked: false });
    const issued = await w.tokens.issueTokens({ userId: target.id, deviceId, scopes: ['profile'] });
    const other = await w.tokens.issueTokens({
      userId: target.id,
      deviceId: null,
      scopes: ['profile'],
    });
    const staff = await w.staff('support_rw');

    const res = await w.call('POST', `users/${target.id}/revoke-tokens`, {
      token: staff.token,
      body: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: target.id, device: null, revoked_count: 2 });

    for (const refreshToken of [issued.refresh_token, other.refresh_token]) {
      await expect(
        w.tokens.refresh({ refreshToken, clientId: 'centcom-cli' }),
      ).rejects.toMatchObject({ code: 'token_revoked', status: 401 });
    }
    await expect(w.tokens.verifyAccessToken(issued.access_token)).rejects.toMatchObject({
      code: 'token_revoked',
    });
    // Announced at once, for the relay to close the user's sockets with 4401.
    await until(() => w.announced.length === 1);
    expect(w.announced.map((m) => JSON.parse(m) as unknown)).toEqual([
      { type: 'user.tokens_revoked', user: target.id, at: new Date(w.clock.now()).toISOString() },
    ]);
    // A new sign-in afterwards works.
    w.clock.advance(1000);
    const again = await w.tokens.issueTokens({
      userId: target.id,
      deviceId: null,
      scopes: ['profile'],
    });
    await expect(w.tokens.verifyAccessToken(again.access_token)).resolves.toMatchObject({
      sub: target.id,
    });
  });

  it('revokes one device when asked, and only the user’s own', async () => {
    w = await adminWorld();
    const target = w.store.addUser();
    const device = w.store.addDevice(target.id);
    w.tokenStore.devices.set(device.id, { userId: target.id, revoked: false });
    const issued = await w.tokens.issueTokens({
      userId: target.id,
      deviceId: device.id,
      scopes: ['profile'],
    });
    const staff = await w.staff('support_rw');
    const strangers = await w.call('POST', `users/${target.id}/revoke-tokens`, {
      token: staff.token,
      body: { device: newId('dev') },
    });
    expect(strangers.statusCode).toBe(404);
    const res = await w.call('POST', `users/${target.id}/revoke-tokens`, {
      token: staff.token,
      body: { device: device.id },
    });
    expect(res.json()).toEqual({ user: target.id, device: device.id, revoked_count: null });
    await expect(w.tokens.verifyAccessToken(issued.access_token)).rejects.toMatchObject({
      code: 'device_revoked',
    });
    await until(() => w.announced.length === 1);
    expect(w.announced.map((m) => JSON.parse(m) as unknown)).toEqual([
      expect.objectContaining({
        type: 'device.revoked',
        user: target.id,
        dev: device.id,
      }) as unknown,
    ]);
  });

  it('disables a sign-in: no new tokens, no refresh', async () => {
    w = await adminWorld();
    const target = w.store.addUser();
    const issued = await w.tokens.issueTokens({
      userId: target.id,
      deviceId: null,
      scopes: ['profile'],
    });
    const staff = await w.staff('support_rw');
    const res = await w.call('POST', `users/${target.id}/disable`, { token: staff.token });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: target.id, revoked_count: 1 });
    await expect(
      w.tokens.issueTokens({ userId: target.id, deviceId: null, scopes: ['profile'] }),
    ).rejects.toMatchObject({ code: 'access_denied', status: 403 });
    await expect(
      w.tokens.refresh({ refreshToken: issued.refresh_token, clientId: 'centcom-cli' }),
    ).rejects.toMatchObject({ code: 'token_revoked' });
    const shown = await w.call('GET', `users/${target.id}`, { token: staff.token });
    expect((shown.json() as { login_disabled_at: string | null }).login_disabled_at).not.toBeNull();
  });
});

describe('flags and status through the admin API', () => {
  it('sets a flag that GET /v1/flags then serves', async () => {
    w = await adminWorld();
    const captured = captureLogger();
    const cache = new FlagCache({
      repository: w.flagRepo,
      pubsub: w.redis.pubsub,
      clock: w.clock.now,
      logger: captured.logger,
    });
    await cache.start();
    const publicApp = fastify({ logger: false });
    await publicApp.register(requestContextPlugin, { logger: captured.logger });
    await publicApp.register(errorHandlerPlugin, { logger: captured.logger });
    await publicApp.register(flagRoutes, {
      flags: new FlagService({ cache, config: { ttlS: 60 } }),
      authenticate: (credential) => w.tokens.authenticate(credential),
      clock: w.clock.now,
    });
    try {
      const staff = await w.staff('support_rw');
      const put = await w.call('PUT', 'flags/banner', {
        token: staff.token,
        body: { type: 'bool', value: true, default: false, public: true },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ key: 'banner', rev: 1 });
      expect(w.store.rows().at(-1)?.meta).toMatchObject({ flag: 'banner', status: 200 });
      await until(async () => {
        const res = await publicApp.inject({ method: 'GET', url: '/v1/flags' });
        return (res.json() as { flags: Record<string, unknown> }).flags['banner'] === true;
      });
      const mismatch = await w.call('PUT', 'flags/banner', {
        token: staff.token,
        body: { key: 'other', type: 'bool', value: true, default: false },
      });
      expect(mismatch.statusCode).toBe(422);
      const deleted = await w.call('DELETE', 'flags/banner', { token: staff.token });
      expect(deleted.json()).toEqual({ key: 'banner', rev: 2 });
    } finally {
      await cache.stop();
      await publicApp.close();
    }
  });

  it('opens incidents and adds updates, naming the incident in the event', async () => {
    w = await adminWorld();
    const staff = await w.staff('support_rw');
    const created = await w.call('POST', 'incidents', {
      token: staff.token,
      body: { title: 'Relay errors', component_ids: ['api'], status: 'investigating' },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    expect(w.store.rows().at(-1)).toMatchObject({ target_type: 'incident', target_id: id });
    const updated = await w.call('POST', `incidents/${id}/updates`, {
      token: staff.token,
      body: { text: 'Fixed.', status: 'resolved' },
    });
    expect(updated.statusCode).toBe(201);
    expect(updated.json()).toMatchObject({ id, status: 'resolved' });
    const bad = await w.call('POST', 'incidents', {
      token: staff.token,
      body: { title: 'x', component_ids: ['nope'], status: 'investigating' },
    });
    expect(bad.statusCode).toBe(422);
    expect(w.store.rows().at(-1)).toMatchObject({ outcome: 'failed' });
  });

  it('answers 503 for actions whose service is not wired yet, audited', async () => {
    w = await adminWorld({ invites: false, promotions: false });
    const staff = await w.staff('support_rw');
    const resend = await w.call('POST', `invites/${newId('inv')}/resend`, { token: staff.token });
    expect(resend.statusCode).toBe(503);
    const promo = await w.call('POST', `workspaces/${newId('wsp')}/promotions`, {
      token: staff.token,
      body: { promotion_code_id: 'promo_1' },
    });
    expect(promo.statusCode).toBe(503);
    expect(
      w.store
        .rows()
        .slice(-2)
        .map((r) => r.outcome),
    ).toEqual(['failed', 'failed']);
  });
});

describe('failure paths', () => {
  it('answers 502 problem+json with a failed event when flags or status are down', async () => {
    w = await adminWorld();
    const t = await seed(w);
    const staff = await w.staff('support_rw');
    w.flagRepo.down = true;
    const flag = await w.call('PUT', 'flags/banner', {
      token: staff.token,
      body: { type: 'bool', value: true, default: false },
    });
    expect(flag.statusCode).toBe(502);
    expect(flag.headers['content-type']).toBe('application/problem+json');
    expect(codeOf(flag)).toBe('bad_gateway');
    expect(w.store.rows().at(-1)).toMatchObject({
      outcome: 'failed',
      meta: expect.objectContaining({
        code: 'bad_gateway',
        status: 502,
        flag: 'banner',
      }) as unknown,
    });
    w.statusRepo.down = true;
    const incident = await w.call('POST', `incidents/${t.incident}/updates`, {
      token: staff.token,
      body: { text: 'Still looking.' },
    });
    expect(incident.statusCode).toBe(502);
    expect(w.store.rows().at(-1)).toMatchObject({ outcome: 'failed', target_id: t.incident });
    expect(validate('problem', incident.json()).ok).toBe(true);
    w.entitlements.down = true;
    const ws = await w.call('GET', `workspaces/${t.workspace}`, { token: staff.token });
    expect(ws.statusCode).toBe(502);
    expect(w.captured.raw()).not.toContain('10.1.2.3');
  });

  it('fails closed when the audit store is down: 503, no data, no action', async () => {
    w = await adminWorld();
    const t = await seed(w);
    const staff = await w.staff('superadmin');

    w.store.auditFails = true;
    const read = await w.call('GET', `users/${t.user}`, { token: staff.token });
    expect(read.statusCode).toBe(503);
    expect(read.headers['content-type']).toBe('application/problem+json');
    expect(read.body).not.toContain('alice');
    expect(codeOf(read)).toBe('service_unavailable');

    const flag = await w.call('PUT', 'flags/never', {
      token: staff.token,
      body: { type: 'bool', value: true, default: false },
    });
    expect(flag.statusCode).toBe(503);
    expect(w.flagRepo.rows.has('never')).toBe(false);

    const disable = await w.call('POST', `users/${t.user}/disable`, { token: staff.token });
    expect(disable.statusCode).toBe(503);
    expect(w.store.state.users.get(t.user)?.login_disabled_at).toBeNull();

    const refused = await w.call('GET', `users/${t.user}`, { token: staff.token, reason: null });
    expect(refused.statusCode).toBe(503);

    w.store.auditFails = false;
    w.store.down = true;
    const down = await w.call('GET', `users/${t.user}`, { token: staff.token });
    expect(down.statusCode).toBe(503);
    expect(down.body).not.toContain('alice');
    expect(w.recorded.count('admin_audit_failures_total')).toBeGreaterThanOrEqual(5);
  });
});

describe('impersonation (negative)', () => {
  it('refuses a workspace or user to act as, in a header, the query or the body', async () => {
    w = await adminWorld();
    const staff = await w.staff('superadmin');
    const user = w.store.addUser();
    const attempts: { headers?: Record<string, string>; query?: string }[] = [
      { headers: { 'x-centcom-workspace': newId('wsp') } },
      { headers: { 'x-workspace-id': newId('wsp') } },
      { headers: { 'x-act-as': user.id } },
      { headers: { 'x-impersonate-user': user.id } },
      { headers: { 'x-on-behalf-of': user.id } },
      { headers: { 'x-forwarded-user': user.id } },
      { query: `workspace=${newId('wsp')}` },
      { query: `impersonate=${user.id}` },
      { query: `as_user=${user.id}` },
      { query: 'email=a%40b.c' },
    ];
    for (const a of attempts) {
      const before = w.store.rows().length;
      const res = await w.call(
        'GET',
        `users/${user.id}${a.query === undefined ? '' : `?${a.query}`}`,
        {
          token: staff.token,
          ...(a.headers === undefined ? {} : { headers: a.headers }),
        },
      );
      expect(res.statusCode, JSON.stringify(a)).toBe(400);
      expect(codeOf(res)).toBe('invalid_request');
      expect(newRows(w, before)).toEqual([expect.objectContaining({ outcome: 'denied' })]);
    }
    const body = await w.call('POST', `users/${user.id}/revoke-tokens`, {
      token: staff.token,
      body: { act_as: user.id },
    });
    expect(body.statusCode).toBe(422);
    expect(w.store.rows().at(-1)?.outcome).toBe('failed');
    // The audit holds the route template, never the query.
    expect(JSON.stringify(w.store.rows())).not.toContain('a@b.c');
  });
});

describe('rate limit (acceptance 8)', () => {
  it('answers 429 with Retry-After past 60 calls a minute per staff user', async () => {
    w = await adminWorld();
    const staff = await w.staff('support_ro');
    const other = await w.staff('support_ro');
    const user = w.store.addUser();
    for (let i = 0; i < 60; i += 1) {
      const res = await w.call('GET', `users/${user.id}`, { token: staff.token });
      expect(res.statusCode).toBe(200);
    }
    const limited = await w.call('GET', `users/${user.id}`, { token: staff.token });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(w.store.rows().at(-1)).toMatchObject({
      outcome: 'denied',
      actor_id: staff.userId,
      meta: expect.objectContaining({ code: 'rate_limited' }) as unknown,
    });
    expect((await w.call('GET', `users/${user.id}`, { token: other.token })).statusCode).toBe(200);
    w.clock.advance(61_000);
    expect((await w.call('GET', `users/${user.id}`, { token: staff.token })).statusCode).toBe(200);
  });
});

describe('staff audit', () => {
  it('lists staff calls newest first with reason and ticket, by page and filter', async () => {
    w = await adminWorld();
    const a = await w.staff('support_ro');
    const b = await w.staff('support_ro');
    const user = w.store.addUser();
    for (const s of [a, b, a]) {
      await w.call('GET', `users/${user.id}`, { token: s.token, ticket: 'SUP-9' });
      w.clock.advance(10);
    }
    const first = await w.call('GET', `staff-audit?limit=2&actor=${a.userId}`, { token: b.token });
    expect(first.statusCode).toBe(200);
    const page = first.json() as {
      data: {
        actor: { id: string };
        reason: string;
        ticket: string;
        route: string;
        target: unknown;
      }[];
      next_cursor: string | null;
      has_more: boolean;
    };
    expect(page.data).toHaveLength(2);
    expect(page.has_more).toBe(false);
    expect(page.data.every((e) => e.actor.id === a.userId)).toBe(true);
    expect(page.data[0]).toMatchObject({
      reason: REASON,
      ticket: 'SUP-9',
      route: `${BASE}/users/:id`,
      target: { type: 'user', id: user.id },
    });
    const all = (await w.call('GET', 'staff-audit?limit=2', { token: b.token })).json() as {
      next_cursor: string;
    };
    expect(all.next_cursor).toEqual(expect.any(String));
    const next = await w.call(
      'GET',
      `staff-audit?limit=2&cursor=${encodeURIComponent(all.next_cursor)}`,
      {
        token: b.token,
      },
    );
    expect(next.statusCode).toBe(200);
    const mismatched = await w.call(
      'GET',
      `staff-audit?limit=2&actor=${a.userId}&cursor=${encodeURIComponent(all.next_cursor)}`,
      { token: b.token },
    );
    expect(mismatched.statusCode).toBe(400);
    expect((await w.call('GET', 'staff-audit?limit=500', { token: b.token })).statusCode).toBe(422);
  });
});
