/**
 * A fake admin API (B088 tests): the B087 routes the console calls, answering with fixtures typed
 * by the API's own bodies, with B087's rules (401 for an unknown token, 403 for non-staff and for
 * writes by support_ro, 422 without a reason) and a log of every request. Installed as the global
 * `fetch`, it sees every request the console makes, whatever the host.
 */
import type {
  AdminSession,
  AdminUser,
  AdminWorkspace,
  StaffAuditEntry,
  StaffRole,
} from '@centcom/api';
import type { Incident } from '../src/api/client.js';

export const API = 'https://admin-api.test';
export const BASE = `${API}/internal/admin/v1`;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let counter = 0;

/** A fresh CT-IDS-shaped id. */
export function id(prefix: string): string {
  counter += 1;
  let n = counter;
  let tail = '';
  for (let i = 0; i < 6; i += 1) {
    tail = (CROCKFORD[n % 32] ?? '0') + tail;
    n = Math.floor(n / 32);
  }
  return `${prefix}_01JA3Z8K2M5N7P9Q0R${tail.slice(-8).padStart(8, '0')}`;
}

const b64url = (value: unknown): string =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A token shaped like a staff access token for `userId`; `claims` add misleading extras. */
export function tokenFor(userId: string, claims: Record<string, unknown> = {}): string {
  return `${b64url({ alg: 'EdDSA', kid: 'k1' })}.${b64url({ sub: userId, scp: 'admin', ...claims })}.c2lnbmF0dXJl`;
}

/** One request as the fake API saw it. */
export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (status: number, body: unknown, requestId: string): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': requestId },
  });

const problem = (status: number, code: string, title: string, requestId: string): Response =>
  new Response(
    JSON.stringify({
      type: `https://centcom.dev/errors/${code}`,
      title,
      status,
      code,
      request_id: requestId,
    }),
    {
      status,
      headers: { 'content-type': 'application/problem+json', 'x-request-id': requestId },
    },
  );

const WRITE = new Set(['POST', 'PUT', 'DELETE']);

/** The fake admin API. */
export class FakeAdminApi {
  readonly requests: Recorded[] = [];
  readonly tokens = new Map<string, string>();
  readonly staff = new Map<string, StaffRole>();
  readonly users = new Map<string, AdminUser>();
  readonly workspaces = new Map<string, AdminWorkspace>();
  readonly sessions = new Map<string, AdminSession>();
  readonly flags = new Map<string, unknown>();
  readonly incidents = new Map<string, Incident>();
  readonly audit: StaffAuditEntry[] = [];
  flagRev = 0;
  /** Every call answers this problem (an outage, a dependency failure). */
  failWith: { status: number; code: string; title: string } | null = null;

  /** A user record; `email` and `name` are what the API would show. */
  addUser(over: Partial<AdminUser> = {}): AdminUser {
    const user: AdminUser = {
      id: id('usr'),
      email: 'alice@example.com',
      display_name: 'Alice Example',
      status: 'active',
      created_at: '2026-01-02T00:00:00.000Z',
      deletion_requested_at: null,
      login_disabled_at: null,
      staff_role: null,
      devices: [],
      memberships: [],
      ...over,
    };
    this.users.set(user.id, user);
    return user;
  }

  /** A staff member of `role` and their token. */
  addStaff(
    role: StaffRole,
    claims: Record<string, unknown> = {},
  ): { userId: string; token: string } {
    const user = this.addUser({
      email: 'staff@centcom.test',
      display_name: 'Sam Staff',
      staff_role: role,
    });
    this.staff.set(user.id, role);
    const token = tokenFor(user.id, claims);
    this.tokens.set(token, user.id);
    return { userId: user.id, token };
  }

  /** Changes (or, with null, removes) a staff member's role, as a superadmin would. */
  setRole(userId: string, role: StaffRole | null): void {
    if (role === null) this.staff.delete(userId);
    else this.staff.set(userId, role);
    const user = this.users.get(userId);
    if (user !== undefined) user.staff_role = role;
  }

  addWorkspace(members: AdminUser[]): AdminWorkspace {
    const ws: AdminWorkspace = {
      id: id('wsp'),
      name: 'Acme',
      slug: 'acme',
      created_at: '2026-01-04T00:00:00.000Z',
      deleted_at: null,
      member_count: members.length,
      members: members.map((u, i) => ({
        member: id('mem'),
        user: u.id,
        email: u.email,
        display_name: u.display_name,
        role: i === 0 ? 'owner' : 'member',
        joined_at: '2026-01-05T00:00:00.000Z',
      })),
      members_truncated: false,
      plan: 'team',
      subscription_status: 'active',
      entitlements: {
        rev: 4,
        limits: {
          relay_access: true,
          lan_multiplayer: true,
          max_seats: 10,
          max_session_members: 8,
          max_concurrent_sessions: 5,
          max_parallel_agents: 4,
          history_days: 30,
          queue_items_month: null,
          audit_log_days: 90,
          webhooks_max: 10,
          api_keys_max: 20,
          hosted_minutes_month: null,
        },
        period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
        grace_until: null,
      },
      usage: { seats: members.length, hosted_minutes_month: 120, queue_items_month: 40 },
    };
    this.workspaces.set(ws.id, ws);
    return ws;
  }

  addSession(workspace: string | null): AdminSession {
    const s: AdminSession = {
      id: id('ses'),
      workspace,
      state: 'live',
      region: 'eu',
      created_at: '2026-01-06T00:00:00.000Z',
      ended_at: null,
      member_count: 3,
      host_member: id('mem'),
    };
    this.sessions.set(s.id, s);
    return s;
  }

  /** The requests that changed something. */
  writes(): Recorded[] {
    return this.requests.filter((r) => WRITE.has(r.method));
  }

  readonly fetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const method = (init.method ?? 'GET').toUpperCase();
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, url: url.href, headers, body });
    const requestId = id('req');
    if (url.origin !== API || !url.pathname.startsWith('/internal/admin/v1/')) {
      return problem(404, 'not_found', 'Not the admin API.', requestId);
    }
    const userId = this.tokens.get((headers['authorization'] ?? '').replace(/^Bearer /, ''));
    if (userId === undefined) return problem(401, 'token_invalid', 'Token not valid', requestId);
    const role = this.staff.get(userId);
    if (role === undefined) return problem(403, 'forbidden', 'Forbidden', requestId);
    const reason = headers['x-admin-reason'] ?? '';
    if (reason.length < 10 || reason.length > 500) {
      return problem(422, 'validation_failed', 'Validation failed', requestId);
    }
    if (WRITE.has(method) && role === 'support_ro') {
      return problem(403, 'forbidden', 'Forbidden', requestId);
    }
    if (this.failWith !== null) {
      return problem(this.failWith.status, this.failWith.code, this.failWith.title, requestId);
    }
    this.audit.unshift({
      id: id('aud'),
      at: new Date(Date.UTC(2026, 9, 8, 12, this.audit.length)).toISOString(),
      actor: { type: 'staff', id: userId },
      outcome: 'success',
      method,
      route: url.pathname,
      status: 200,
      code: null,
      target: null,
      flag: null,
      reason,
      ticket: headers['x-admin-ticket'] ?? null,
    });
    return this.#route(method, url, body, requestId);
  };

  #route(method: string, url: URL, body: unknown, requestId: string): Response {
    const path = url.pathname.slice('/internal/admin/v1'.length);
    const parts = path.split('/').filter((p) => p !== '');
    const missing = () => problem(404, 'not_found', 'Not found', requestId);
    const [first, second, third] = parts;
    if (method === 'GET' && first === 'users' && second === undefined) {
      const email = (url.searchParams.get('email') ?? '').toLowerCase();
      const found = [...this.users.values()].filter((u) => u.email.toLowerCase() === email);
      return json(
        200,
        {
          data: found.map(({ id: uid, email: e, display_name, status, created_at }) => ({
            id: uid,
            email: e,
            display_name,
            status,
            created_at,
          })),
        },
        requestId,
      );
    }
    if (first === 'users' && second !== undefined) {
      const user = this.users.get(decodeURIComponent(second));
      if (user === undefined) return missing();
      if (method === 'GET' && third === undefined) return json(200, user, requestId);
      if (method === 'POST' && third === 'revoke-tokens') {
        const device = (body as { device?: string } | undefined)?.device ?? null;
        return json(
          200,
          { user: user.id, device, revoked_count: device === null ? 2 : null },
          requestId,
        );
      }
      if (method === 'POST' && third === 'disable') {
        user.login_disabled_at = '2026-10-08T12:00:00.000Z';
        return json(
          200,
          { user: user.id, login_disabled_at: user.login_disabled_at, revoked_count: 2 },
          requestId,
        );
      }
    }
    if (first === 'workspaces' && second !== undefined) {
      const ws = this.workspaces.get(decodeURIComponent(second));
      if (ws === undefined) return missing();
      if (method === 'GET' && third === undefined) return json(200, ws, requestId);
      if (method === 'POST' && third === 'promotions') {
        return json(
          200,
          {
            workspace: ws.id,
            subscription: {
              id: id('sub'),
              workspace: ws.id,
              plan: 'pro',
              status: 'active',
              seats: 1,
              current_period_end: '2026-11-01T00:00:00.000Z',
            },
          },
          requestId,
        );
      }
    }
    if (first === 'sessions' && second !== undefined) {
      const s = this.sessions.get(decodeURIComponent(second));
      if (s === undefined) return missing();
      if (method === 'GET' && third === undefined) return json(200, s, requestId);
      if (method === 'POST' && third === 'end') {
        s.state = 'ended';
        s.ended_at = '2026-10-08T12:00:00.000Z';
        return json(200, s, requestId);
      }
    }
    if (method === 'GET' && first === 'staff-audit') {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const page = this.audit.slice(start, start + limit);
      const next = start + limit < this.audit.length ? String(start + limit) : null;
      return json(200, { data: page, next_cursor: next, has_more: next !== null }, requestId);
    }
    if (first === 'flags' && second !== undefined) {
      const key = decodeURIComponent(second);
      if (method === 'PUT') {
        this.flags.set(key, body);
        this.flagRev += 1;
        return json(200, { key, rev: this.flagRev }, requestId);
      }
      if (method === 'DELETE') {
        if (!this.flags.delete(key)) return missing();
        this.flagRev += 1;
        return json(200, { key, rev: this.flagRev }, requestId);
      }
    }
    if (first === 'incidents') {
      if (method === 'POST' && second === undefined) {
        const input = body as {
          title: string;
          component_ids: string[];
          status: Incident['status'];
        };
        const incident: Incident = {
          id: id('inc'),
          title: input.title,
          status: input.status,
          started_at: '2026-10-08T12:00:00.000Z',
          resolved_at: null,
          component_ids: input.component_ids,
          updates: [],
        };
        this.incidents.set(incident.id, incident);
        return json(201, incident, requestId);
      }
      if (method === 'POST' && second !== undefined && third === 'updates') {
        const incident = this.incidents.get(decodeURIComponent(second));
        if (incident === undefined) return missing();
        const input = body as { text: string; status?: Incident['status'] };
        incident.updates.push({ at: '2026-10-08T12:05:00.000Z', text: input.text });
        if (input.status !== undefined) incident.status = input.status;
        return json(201, incident, requestId);
      }
    }
    return missing();
  }
}
