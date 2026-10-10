/**
 * `GET /v1/sessions` and `POST /v1/sessions` (B054, CT-API-SESSIONS, CT-PAGE).
 *
 * - **List** (`sessions:read`): `workspace`, `state` (`active`, the OpenAPI name for `live`; `live`
 *   is accepted too, as the card names it; `paused`, `ended`, `expired`), `mine`, `limit` (1-200,
 *   default 50; 201 is 422) and `cursor`, newest first (B053's keyset list). With `workspace`,
 *   the caller must be a member who may join its sessions (B021 `session.join.editor`: owner,
 *   admin, member); anyone else gets 403 (listSessions declares no 404). Without it the list is the caller's
 *   own sessions (`mine`), so it never spans workspaces they cannot see; a session whose
 *   workspace the caller has left, or may no longer join, is left out of the page.
 * - **Create** (`sessions:host`, `Idempotency-Key` accepted): B021 `session.create` (owner, admin,
 *   member; a non-member 404 `workspace_not_found`, another role 403); then B053 checks the name and the entitlements (`relay_access`,
 *   `max_concurrent_sessions`: 403 `entitlement_required`, no row). The caller's device hosts
 *   (slot 0). 201 `SessionCreated` with `region_hint`, `relay_url` and `host_member`, an ETag and
 *   a `Location`; audited `session.create`. `project` is accepted and ignored (B053 has no column
 *   for it).
 *
 * Owns: the HTTP side of list and create. Must not: list a session the caller may not see, or
 * create one for an API key (keys never become members, CT-AUTH).
 */
import { isId, type Api } from '@centcom/contracts';
import { AppError, parsePageQuery, validationFailed, type FieldError } from '@centcom/core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  SessionStateError,
  type SessionPolicyDefaults,
  type SessionState,
} from '../../modules/sessions/index.js';
import {
  callerOf,
  memberBody,
  PRIVATE,
  sessionBody,
  sessionEtag,
  SESSION_ROUTE_DETAILS,
  type Caller,
} from './access.js';
import type { SessionRouteDeps } from './index.js';
import { liveDevice } from './join-token.js';

const LIST_SPEC = { sorts: ['id'], defaultSort: 'id' } as const;
/** Denials answered with 404: the workspace is not the caller's business. */
const HIDDEN = new Set(['not_a_member', 'other_workspace', 'unknown_actor']);
const STATES: Readonly<Record<string, SessionState>> = {
  active: 'live',
  live: 'live',
  paused: 'paused',
  ended: 'ended',
  expired: 'expired',
};
const APPROVE = new Set(['ask', 'trusted', 'everyone']);
/** `session_policy.queue_limit`'s upper bound (B051's CHECK). */
const MAX_QUEUE_LIMIT = 100_000;

/** 409 for a transition B053's state machine refuses (no partial change: it threw first). */
export function stateConflict(err: unknown): never {
  if (err instanceof SessionStateError) {
    throw new AppError('conflict', { detail: SESSION_ROUTE_DETAILS.changed });
  }
  throw err;
}

/**
 * Lets the caller act in `workspaceId` for `action` (B021). A role that falls short is 403
 * (audited by the authorizer). A workspace the caller is not in is, for create, 404
 * `workspace_not_found` (createSession's code for it); the list declares no 404, so there it is
 * the authorizer's 403 `forbidden`.
 */
export async function workspaceGate(
  request: FastifyRequest,
  caller: Caller,
  workspaceId: string,
  action: 'session.create' | 'session.join.editor',
): Promise<void> {
  const { authorizer } = request.server.rbac;
  const decision = await authorizer.decide(caller.actor, action, { workspaceId });
  if (decision.allow) return;
  if (action === 'session.create' && HIDDEN.has(decision.reason)) {
    throw new AppError('workspace_not_found', { detail: 'That workspace does not exist.' });
  }
  await authorizer.authorize(caller.actor, action, { workspaceId });
}

/** A SessionPolicy (all fields optional); pointer errors under `base`. */
export function parsePolicy(value: unknown, base: string): Partial<SessionPolicyDefaults> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validationFailed([{ pointer: base, code: 'invalid_type', detail: 'must be an object' }]);
  }
  const v = value as Record<string, unknown>;
  const out: Partial<SessionPolicyDefaults> = {};
  const errors: FieldError[] = [];
  const flag = (key: 'share_history' | 'locked' | 'auto_failover'): void => {
    if (v[key] === undefined) return;
    if (typeof v[key] === 'boolean') out[key] = v[key];
    else
      errors.push({ pointer: `${base}/${key}`, code: 'invalid_type', detail: 'must be a boolean' });
  };
  if (v['auto_approve'] !== undefined) {
    if (typeof v['auto_approve'] === 'string' && APPROVE.has(v['auto_approve'])) {
      out.auto_approve = v['auto_approve'] as SessionPolicyDefaults['auto_approve'];
    } else {
      errors.push({
        pointer: `${base}/auto_approve`,
        code: 'invalid_value',
        detail: 'must be ask, trusted or everyone',
      });
    }
  }
  flag('share_history');
  flag('locked');
  flag('auto_failover');
  if (v['queue_limit'] !== undefined) {
    const n = v['queue_limit'];
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_QUEUE_LIMIT) {
      out.queue_limit = n;
    } else {
      errors.push({
        pointer: `${base}/queue_limit`,
        code: 'out_of_range',
        detail: `must be a whole number from 1 to ${MAX_QUEUE_LIMIT}`,
      });
    }
  }
  if (errors.length > 0) throw validationFailed(errors);
  return out;
}

/** The body of `POST /v1/sessions` (unknown fields ignored, CT-API rule). */
function parseCreate(body: unknown): {
  workspace: string;
  name: string;
  policy?: Partial<SessionPolicyDefaults>;
  regionPreference?: string;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationFailed([{ pointer: '', code: 'invalid_type', detail: 'must be an object' }]);
  }
  const b = body as Record<string, unknown>;
  const errors: FieldError[] = [];
  if (!isId('wsp', b['workspace'])) {
    errors.push({ pointer: '/workspace', code: 'invalid', detail: 'must be a workspace id' });
  }
  if (typeof b['name'] !== 'string') {
    errors.push({ pointer: '/name', code: 'invalid_type', detail: 'must be a string' });
  }
  if (b['project'] !== undefined && !isId('prj', b['project'])) {
    errors.push({ pointer: '/project', code: 'invalid', detail: 'must be a project id' });
  }
  if (b['region_preference'] !== undefined && typeof b['region_preference'] !== 'string') {
    errors.push({
      pointer: '/region_preference',
      code: 'invalid_type',
      detail: 'must be a string',
    });
  }
  if (errors.length > 0) throw validationFailed(errors);
  return {
    workspace: b['workspace'] as string,
    name: b['name'] as string,
    ...(b['policy'] === undefined ? {} : { policy: parsePolicy(b['policy'], '/policy') }),
    ...(typeof b['region_preference'] === 'string'
      ? { regionPreference: b['region_preference'] }
      : {}),
  };
}

/** The list's own filters. */
function parseFilters(q: Record<string, unknown>): {
  workspace?: string;
  state?: SessionState;
  mine: boolean;
} {
  const errors: FieldError[] = [];
  const workspace = q['workspace'];
  if (workspace !== undefined && !isId('wsp', workspace)) {
    errors.push({ pointer: '/workspace', code: 'invalid', detail: 'must be a workspace id' });
  }
  const state = q['state'];
  if (state !== undefined && (typeof state !== 'string' || STATES[state] === undefined)) {
    errors.push({
      pointer: '/state',
      code: 'invalid_value',
      detail: 'must be active, paused, ended or expired',
    });
  }
  const mine = q['mine'];
  if (mine !== undefined && mine !== 'true' && mine !== 'false') {
    errors.push({ pointer: '/mine', code: 'invalid_type', detail: 'must be true or false' });
  }
  if (errors.length > 0) throw validationFailed(errors);
  return {
    ...(workspace === undefined ? {} : { workspace: workspace as string }),
    ...(state === undefined ? {} : { state: STATES[state as string] as SessionState }),
    mine: mine === 'true',
  };
}

export const listCreateRoutes: FastifyPluginAsync<SessionRouteDeps> = async (app, deps) => {
  const clock = deps.clock ?? Date.now;

  app.get(
    '/v1/sessions',
    { config: { auth: { scopes: ['sessions:read'] } } },
    async (request, reply) => {
      const caller = callerOf(request);
      const query = (request.query ?? {}) as Record<string, unknown>;
      const page = parsePageQuery(query, LIST_SPEC);
      const filters = parseFilters(query);
      if (filters.workspace !== undefined) {
        await workspaceGate(request, caller, filters.workspace, 'session.join.editor');
      }
      const mine = filters.mine || filters.workspace === undefined;
      const result = await deps.service.list({
        ...(filters.workspace === undefined ? {} : { workspace: filters.workspace }),
        ...(filters.state === undefined ? {} : { state: filters.state }),
        ...(mine ? { mineUserId: caller.userId } : {}),
        limit: page.limit,
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      });
      // A member's own sessions in a workspace they left (or may no longer join) are not theirs
      // to see: B021 decides per workspace, from the records.
      const allowed = new Map<string, boolean>();
      const data: Api.Session[] = [];
      for (const session of result.data) {
        if (mine && filters.workspace === undefined && session.workspace !== '') {
          let ok = allowed.get(session.workspace);
          if (ok === undefined) {
            const decision = await request.server.rbac.authorizer.decide(
              caller.actor,
              'session.join.viewer',
              { workspaceId: session.workspace, invited: true },
            );
            ok = decision.allow;
            allowed.set(session.workspace, ok);
          }
          if (!ok) continue;
        }
        data.push(sessionBody(session));
      }
      reply.header('cache-control', PRIVATE);
      const body: Api.SessionPage = {
        data,
        next_cursor: result.next_cursor,
        has_more: result.has_more,
      };
      return body;
    },
  );

  app.post(
    '/v1/sessions',
    {
      config: { auth: { scopes: ['sessions:host'] }, idempotency: 'accepted' },
      // Set before the handler so a replayed answer (B024 keeps no Cache-Control) has it too.
      onRequest: (_request, reply, done) => {
        void reply.header('cache-control', PRIVATE);
        done();
      },
    },
    async (request, reply) => {
      const caller = callerOf(request);
      const input = parseCreate(request.body);
      await workspaceGate(request, caller, input.workspace, 'session.create');
      const deviceId = await liveDevice(deps, caller);
      const preference = input.regionPreference;
      const region =
        preference !== undefined && deps.relays.urls[preference] !== undefined
          ? preference
          : deps.relays.defaultRegion;
      const relayUrl = deps.relays.urls[region];
      if (relayUrl === undefined) {
        throw new AppError('service_unavailable', {
          detail: SESSION_ROUTE_DETAILS.relayUnknown,
          retryAfterS: 30,
        });
      }
      const session = await deps.service
        .create({
          workspaceId: input.workspace,
          creatorUserId: caller.userId,
          creatorDeviceId: deviceId,
          name: input.name,
          region,
          ...(input.policy === undefined ? {} : { policy: input.policy }),
        })
        .catch(stateConflict);
      const host = session.host === null ? null : await deps.store.member(session.id, session.host);
      if (host === null) throw new Error('sessions: the new session has no host member');
      request.audit.detached({
        action: 'session.create',
        workspaceId: input.workspace,
        target: { type: 'session', id: session.id },
        meta: { mode: 'command_post' },
      });
      deps.logger?.info({ session: session.id, at: clock() }, 'session.created');
      reply
        .code(201)
        .header('location', `/v1/sessions/${session.id}`)
        .header('etag', sessionEtag(session));
      const body: Api.SessionCreated = {
        ...sessionBody(session),
        region_hint: region,
        relay_url: relayUrl,
        host_member: memberBody(host, true),
      };
      return body;
    },
  );
};
