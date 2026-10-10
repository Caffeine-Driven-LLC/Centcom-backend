/**
 * What every sessions route shares (B054): who calls, whether they may see the session, the
 * session's ETag, and the bodies.
 *
 * - **Callers** are users only: an API key gets 403 (CT-AUTH: keys are not members, cannot create
 *   relay tickets or join sessions; B021's matrix gives keys no session action). Without a caller
 *   it is 401. Routes that make the caller a member (create, join-token, claim-host) also need the
 *   token's device (`dev`).
 * - **Seeing a session** (the 404 rule, CT-API-SESSIONS guardrail): a live member of it, or a user
 *   whose workspace role may join its sessions (B021 `session.join.editor`: owner, admin,
 *   member). Anyone else gets 404 `session_not_found`, as for a session that does not exist.
 * - **Roles** shown and put in tickets are the stored session role capped by the workspace role,
 *   as the relay's live membership caps it (CT-RBAC: a guest at most `viewer`, `billing` none).
 * - **ETag:** a strong tag over the session's name, state, host, policy, region and end time, so
 *   any change a client can see changes it.
 *
 * Owns: these rules. Must not: authorise from token claims beyond the caller's identity, or
 * confirm a session to someone who may not see it.
 */
import { createHash } from 'node:crypto';
import { isId, type Api } from '@centcom/contracts';
import { AppError, type Actor } from '@centcom/core';
import type { FastifyRequest } from 'fastify';
import type { Session } from '../../modules/sessions/index.js';
import type { MemberView, Standing } from './store.js';

/** The details of the routes' own refusals (GUIDELINES §3.4). */
export const SESSION_ROUTE_DETAILS = Object.freeze({
  unauthenticated: 'Authentication is required.',
  usersOnly: 'Only a signed-in user can do this; API keys cannot join or host sessions.',
  deviceRequired: 'This needs a token issued to a registered device.',
  deviceRevoked: 'This device was revoked.',
  notFound: 'That session does not exist.',
  removed: 'You were removed from this session.',
  noRole: 'Your workspace role cannot join sessions.',
  locked: 'The host has locked this session to new members.',
  full: 'The session already has as many members as it can hold.',
  over: 'That session has ended.',
  adminOnly: 'Only a workspace owner or admin can claim the host.',
  hostPresent: 'The host is connected; they can transfer the host instead.',
  changed: 'The session changed while this was being done; try again.',
  stale: 'The session changed since you read it: read it again, then retry.',
  signing: 'Relay tickets cannot be issued right now. Try again shortly.',
  entitlements: 'Plan limits cannot be checked right now. Try again shortly.',
  relayUnknown: 'The session’s relay region is not available right now. Try again shortly.',
} as const);

/** The calling user (and the token's device, when it has one). */
export interface Caller {
  actor: Extract<Actor, { kind: 'user' }>;
  userId: string;
  deviceId: string | null;
}

/** The caller: 401 without one, 403 for an API key. */
export function callerOf(request: FastifyRequest): Caller {
  const actor = request.server.rbac.actor(request);
  if (actor === null) {
    throw new AppError('unauthorized', { detail: SESSION_ROUTE_DETAILS.unauthenticated });
  }
  if (actor.kind !== 'user') {
    throw new AppError('forbidden', { detail: SESSION_ROUTE_DETAILS.usersOnly });
  }
  const device = request.principal?.deviceId ?? null;
  return { actor, userId: actor.userId, deviceId: isId('dev', device) ? device : null };
}

/** The caller's device, or 403. */
export function deviceOf(caller: Caller): string {
  if (caller.deviceId === null) {
    throw new AppError('forbidden', { detail: SESSION_ROUTE_DETAILS.deviceRequired });
  }
  return caller.deviceId;
}

/** The `ses_` id of the route; 404 for anything that is not one. */
export function sessionIdOf(request: FastifyRequest): string {
  const id = (request.params as Record<string, unknown>)['id'];
  if (!isId('ses', id)) throw notVisible();
  return id;
}

/** 404 `session_not_found`: the session does not exist, or the caller may not know it does. */
export const notVisible = (): AppError =>
  new AppError('session_not_found', { detail: SESSION_ROUTE_DETAILS.notFound });

/** 410 `session_ended`. */
export const sessionOver = (): AppError =>
  new AppError('session_ended', { detail: SESSION_ROUTE_DETAILS.over });

/** The session role a workspace role allows at most; null when it allows none (CT-RBAC). */
export function capRole(
  role: 'host' | 'editor' | 'viewer',
  workspaceRole: string | null,
  inWorkspace: boolean,
): 'host' | 'editor' | 'viewer' | null {
  if (!inWorkspace) return role;
  if (workspaceRole === null || workspaceRole === 'billing') return null;
  if (workspaceRole === 'guest') return 'viewer';
  return role;
}

/** The caller's live session role (capped), or null when they are not a live member. */
export function liveRole(standing: Standing): 'host' | 'editor' | 'viewer' | null {
  if (standing.member === null) return null;
  return capRole(
    standing.member.role,
    standing.workspaceRole,
    standing.session.workspaceId !== null,
  );
}

/**
 * Whether the caller may see the session: a live member, or a workspace role that may join its
 * sessions (B021 `session.join.editor`). Workspace roles are read by the authorizer from the
 * records, never from the token.
 */
export async function maySee(
  request: FastifyRequest,
  caller: Caller,
  standing: Standing,
): Promise<boolean> {
  if (liveRole(standing) !== null) return true;
  const workspaceId = standing.session.workspaceId;
  if (workspaceId === null) return false;
  const decision = await request.server.rbac.authorizer.decide(
    caller.actor,
    'session.join.editor',
    { workspaceId },
  );
  return decision.allow;
}

/** A strong ETag of what a client sees of `session`. */
export function sessionEtag(session: Session): string {
  const p = session.policy;
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        session.name,
        session.state,
        session.host,
        session.region,
        session.ended_at,
        [p.auto_approve, p.share_history, p.queue_limit, p.locked, p.auto_failover],
      ]),
    )
    .digest('base64url')
    .slice(0, 22);
  return `"s${digest}"`;
}

/** What an If-Match header accepts: any (`*`), or the listed strong tags; undefined without one. */
export function parseIfMatch(header: string | string[] | undefined): '*' | string[] | undefined {
  if (header === undefined) return undefined;
  const tags: string[] = [];
  for (const raw of (Array.isArray(header) ? header : [header]).flatMap((v) => v.split(','))) {
    const tag = raw.trim();
    if (tag === '*') return '*';
    // Weak tags never match (RFC 9110 §13.1.1: If-Match compares strongly).
    if (/^"[^"]*"$/.test(tag)) tags.push(tag);
  }
  return tags;
}

/** A session as CT-API-SESSIONS `Session`. */
export function sessionBody(session: Session): Api.Session {
  return {
    id: session.id as Api.Session['id'],
    workspace: session.workspace as Api.Session['workspace'],
    name: session.name,
    state: session.state,
    host: (session.host ?? '') as Api.Session['host'],
    policy: { ...session.policy },
    region: session.region,
    created_at: session.created_at,
    ended_at: session.ended_at,
  };
}

/** A member as CT-API-SESSIONS `SessionMember`; the role is capped by the workspace role. */
export function memberBody(m: MemberView, inWorkspace: boolean): Api.SessionMember {
  return {
    id: m.id as Api.SessionMember['id'],
    user: m.userId as NonNullable<Api.SessionMember['user']>,
    display_name: m.displayName,
    device: m.device.id as NonNullable<Api.SessionMember['device']>,
    role: capRole(m.role, m.workspaceRole, inWorkspace) ?? 'viewer',
    slot: m.slot,
    join_order: m.joinOrder,
    device_keys: {
      device: m.device.id as Api.DeviceKeys['device'],
      x25519: m.device.x25519,
      ed25519: m.device.ed25519,
      fingerprint: m.device.fingerprint,
      revoked: m.device.revoked,
    },
    joined_at: m.joinedAt.toISOString(),
  };
}

/** Never in shared caches. */
export const PRIVATE = 'private, no-store';
