/**
 * `POST /v1/sessions/{id}/join-token` (B054, CT-API-SESSIONS, CT-AUTH "Relay ticket"): a single-use
 * 60 s relay ticket for the calling user's device.
 *
 * In order:
 * 1. Users only, with a device: an API key is 403 (keys never become members); a token without
 *    `dev` is 403; a device that is unknown, another user's or revoked is 401 `device_revoked`.
 * 2. A session of a workspace the caller is not in (and not a member of it) is 404; an ended or
 *    expired one is 410 `session_ended`. No ticket either way. A workspace member whose role
 *    may not join (billing, an uninvited guest) learns only that they may not: 403 below.
 * 3. The member: the caller's live member row, with its role capped by the workspace role (a
 *    guest at most `viewer`; `billing` none: 403). Someone removed from the session (B051's kick)
 *    is 403 `not_a_member`. Without a row, the caller joins (`admit`):
 *    - B021 decides from the workspace role: owner, admin and member join as `editor`
 *      (`session.join.editor`); a guest only when invited (`session.join.viewer`, and no session
 *      invite exists yet, so never); anyone else 403 (audited);
 *    - a session the host locked takes no new members (403 `session_locked`);
 *    - B080: `relay_access` (403 `entitlement_required`) and `max_session_members` against the
 *      live members (403 `member_limit_reached`); entitlements that cannot be read are 503 (no
 *      row);
 *    - B031 assigns the slot (its hard cap of 50: 403 `session_full`), then the row is written
 *      under the session's lock (a concurrent join of the same user keeps the first row).
 * 4. B017 signs `{sid, mid, role, dev, caps}` (aud `centcom-relay`, 60 s, a fresh `jti`); a
 *    signing failure is 503 with `retry_after_s`, counted in `session_ticket_failures_total`.
 *    The `jti` is recorded for 60 s under `ticket:issued:{jti}` before the answer (no record, no
 *    ticket: 503). The relay refuses a second use with its own `relay:jti:{jti}` (B038), which
 *    this route must not write: the first use would fail.
 *
 * The body is `JoinToken`: `ticket`, `expires_in` 60, `relay_url`, `region`, `member`, `role`,
 * `caps`. `caps` are the requested capabilities, deduplicated (at most 16, each
 * `[a-z0-9._-]{1,32}`). The ticket is never logged and never in a URL.
 *
 * Owns: issuing tickets. Must not: mint for an API key, a revoked device, a removed member or an
 * ended session, or authorise from token claims.
 */
import { newId, type Api } from '@centcom/contracts';
import {
  AppError,
  isAppError,
  noopMetrics,
  validationFailed,
  type FieldError,
} from '@centcom/core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  RELAY_TICKET_TTL_S,
  type RelayTicketClaims,
} from '../../modules/auth/tokens/relay-ticket.js';
import type { CheckResult } from '../../modules/entitlements/enforcement.js';
import { refusal } from '../../plugins/entitlements.js';
import {
  callerOf,
  liveRole,
  notVisible,
  PRIVATE,
  SESSION_ROUTE_DETAILS,
  sessionIdOf,
  sessionOver,
  type Caller,
} from './access.js';
import type { SessionRouteDeps } from './index.js';
import type { AddMemberResult, Standing } from './store.js';

/** Where issued tickets are recorded (`{prefix}{jti}`, 60 s). */
export const JOIN_TICKET_RECORD_PREFIX = 'ticket:issued:';
/** The most capabilities a ticket carries (B017's limit). */
export const MAX_TICKET_CAPS = 16;
/** The slot cap (CT-WS-SESSION-EVENTS member slots 0-49; B031). */
export const MAX_SESSION_SLOTS = 50;
/** `retry_after_s` when tickets cannot be signed or recorded. */
const SIGNING_RETRY_AFTER_S = 5;
const CAP = /^[a-z0-9._-]{1,32}$/;

/** The caller's device, live and theirs: 403 without one, 401 `device_revoked` otherwise. */
export async function liveDevice(
  deps: Pick<SessionRouteDeps, 'store'>,
  caller: Caller,
): Promise<string> {
  if (caller.deviceId === null) {
    throw new AppError('forbidden', { detail: SESSION_ROUTE_DETAILS.deviceRequired });
  }
  const device = await deps.store.device(caller.deviceId);
  if (device === null || device.revoked || device.userId !== caller.userId) {
    throw new AppError('device_revoked', { detail: SESSION_ROUTE_DETAILS.deviceRevoked });
  }
  return caller.deviceId;
}

/** `caps` of the body (`JoinTokenRequest`); an absent body is `{}`. */
function parseCaps(body: unknown): string[] {
  if (body === undefined || body === null) return [];
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw validationFailed([{ pointer: '', code: 'invalid_type', detail: 'must be an object' }]);
  }
  const caps = (body as Record<string, unknown>)['caps'];
  if (caps === undefined) return [];
  if (!Array.isArray(caps)) {
    throw validationFailed([
      { pointer: '/caps', code: 'invalid_type', detail: 'must be an array' },
    ]);
  }
  const errors: FieldError[] = [];
  caps.forEach((cap, i) => {
    if (typeof cap !== 'string' || !CAP.test(cap)) {
      errors.push({
        pointer: `/caps/${i}`,
        code: 'invalid',
        detail: 'must match [a-z0-9._-]{1,32}',
      });
    }
  });
  const unique = [...new Set(caps as string[])];
  if (errors.length === 0 && unique.length > MAX_TICKET_CAPS) {
    errors.push({
      pointer: '/caps',
      code: 'too_many',
      detail: `at most ${MAX_TICKET_CAPS} capabilities`,
    });
  }
  if (errors.length > 0) throw validationFailed(errors);
  return unique;
}

/** B080's check; a failure that is not already an answer is 503 (never an unchecked join). */
async function entitlement(
  deps: Pick<SessionRouteDeps, 'entitlements'>,
  workspaceId: string,
  key: 'relay_access' | 'max_session_members',
  current?: number,
): Promise<CheckResult> {
  try {
    return await deps.entitlements.check(workspaceId, key, current);
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new AppError('service_unavailable', {
      detail: SESSION_ROUTE_DETAILS.entitlements,
      retryAfterS: SIGNING_RETRY_AFTER_S,
    });
  }
}

/**
 * Makes the caller a member of the session they may see but are not in (step 3 of the header).
 * `ignoreLock`: claim-host lets an admin in to a locked session.
 */
export async function admit(
  request: FastifyRequest,
  deps: SessionRouteDeps,
  caller: Caller,
  deviceId: string,
  standing: Standing,
  opts: { ignoreLock?: boolean } = {},
): Promise<{ id: string; role: 'host' | 'editor' | 'viewer'; slot: number; added: boolean }> {
  const sid = standing.session.id;
  const workspaceId = standing.session.workspaceId;
  if (standing.removed) {
    throw new AppError('not_a_member', { detail: SESSION_ROUTE_DETAILS.removed });
  }
  if (workspaceId === null) throw notVisible();
  const { authorizer } = request.server.rbac;
  const editor = await authorizer.decide(caller.actor, 'session.join.editor', { workspaceId });
  if (!editor.allow) {
    // No session invites exist yet, so a guest is never invited (CT-RBAC "if invited").
    await authorizer.authorize(caller.actor, 'session.join.viewer', {
      workspaceId,
      invited: false,
    });
  }
  if (standing.session.locked && opts.ignoreLock !== true) {
    throw new AppError('session_locked', { detail: SESSION_ROUTE_DETAILS.locked });
  }
  const relay = await entitlement(deps, workspaceId, 'relay_access');
  if (!relay.allowed) throw refusal('relay_access', relay);
  const current = await deps.store.countMembers(sid);
  const room = await entitlement(deps, workspaceId, 'max_session_members', current);
  if (!room.allowed) throw refusal('max_session_members', room);
  const memberId = newId('mem');
  const slot = await deps.slots.assign(sid, memberId, MAX_SESSION_SLOTS);
  if (slot.kind === 'no_session') throw notVisible();
  if (slot.kind === 'full') {
    throw new AppError('session_full', { detail: SESSION_ROUTE_DETAILS.full });
  }
  const clock = deps.clock ?? Date.now;
  let added: AddMemberResult;
  try {
    added = await deps.store.addMember({
      sessionId: sid,
      memberId,
      userId: caller.userId,
      deviceId,
      role: 'editor',
      slot: slot.slot,
      at: new Date(clock()),
    });
  } catch (err) {
    await release(deps, sid, memberId);
    throw err;
  }
  // The slot was for a member who was not written: give it back (B031 never frees slots itself).
  if (added.kind !== 'added') await release(deps, sid, memberId);
  if (added.kind === 'gone') throw notVisible();
  if (added.kind === 'over') throw sessionOver();
  return { ...added.member, added: added.kind === 'added' };
}

/** Removes a member row and slot written for a join that did not go through; never throws. */
export async function release(
  deps: Pick<SessionRouteDeps, 'store' | 'logger'>,
  sid: string,
  memberId: string,
): Promise<void> {
  try {
    await deps.store.releaseMember(sid, memberId);
  } catch (err) {
    deps.logger?.warn(
      { session: sid, error: err instanceof Error ? err.name : typeof err },
      'session.member_release_failed',
    );
  }
}

export const joinTokenRoutes: FastifyPluginAsync<SessionRouteDeps> = async (app, deps) => {
  const clock = deps.clock ?? Date.now;
  const metrics = deps.metrics ?? noopMetrics;

  app.post(
    '/v1/sessions/:id/join-token',
    { config: { auth: { scopes: ['sessions:write'] } } },
    async (request, reply) => {
      const caller = callerOf(request);
      const sid = sessionIdOf(request);
      const caps = parseCaps(request.body);
      const deviceId = await liveDevice(deps, caller);
      const standing = await deps.store.standing(sid, caller.userId);
      // Members of the session's workspace may know it exists (a refusal below is 403);
      // anyone else gets 404.
      const inWorkspace = standing?.session.workspaceId != null;
      if (
        standing === null ||
        (inWorkspace ? standing.workspaceRole === null : liveRole(standing) === null)
      ) {
        throw notVisible();
      }
      const state = standing.session.state;
      if (state === 'ended' || state === 'expired') throw sessionOver();
      let member: { id: string; role: 'host' | 'editor' | 'viewer' };
      if (standing.member !== null) {
        const role = liveRole(standing);
        if (role === null) {
          throw new AppError('forbidden', { detail: SESSION_ROUTE_DETAILS.noRole });
        }
        member = { id: standing.member.id, role };
      } else {
        const added = await admit(request, deps, caller, deviceId, standing);
        member = { id: added.id, role: added.role };
      }
      const region = await regionOf(deps, sid);
      const relayUrl = deps.relays.urls[region];
      if (relayUrl === undefined) {
        throw new AppError('service_unavailable', {
          detail: SESSION_ROUTE_DETAILS.relayUnknown,
          retryAfterS: 30,
        });
      }
      const claims: RelayTicketClaims = {
        sid,
        mid: member.id,
        role: member.role,
        dev: deviceId,
        caps,
      };
      let ticket: string;
      try {
        ticket = await deps.tickets.mintRelayTicket(claims);
      } catch (err) {
        metrics.counter('session_ticket_failures_total', { reason: 'signing' }).inc();
        deps.logger?.error(
          { session: sid, error: err instanceof Error ? err.name : typeof err },
          'session.ticket_signing_failed',
        );
        throw new AppError('service_unavailable', {
          detail: SESSION_ROUTE_DETAILS.signing,
          retryAfterS: SIGNING_RETRY_AFTER_S,
        });
      }
      const jti = jtiOf(ticket);
      try {
        if (jti === null) throw new Error('the ticket has no jti');
        await deps.issued.set(`${JOIN_TICKET_RECORD_PREFIX}${jti}`, `${sid}:${member.id}`, {
          ttlMs: RELAY_TICKET_TTL_S * 1000,
        });
      } catch (err) {
        metrics.counter('session_ticket_failures_total', { reason: 'record' }).inc();
        deps.logger?.error(
          { session: sid, error: err instanceof Error ? err.name : typeof err },
          'session.ticket_record_failed',
        );
        throw new AppError('service_unavailable', {
          detail: SESSION_ROUTE_DETAILS.signing,
          retryAfterS: SIGNING_RETRY_AFTER_S,
        });
      }
      deps.logger?.info({ session: sid, member: member.id, at: clock() }, 'session.ticket_issued');
      reply.header('cache-control', PRIVATE);
      const body: Api.JoinToken = {
        ticket,
        expires_in: RELAY_TICKET_TTL_S,
        relay_url: relayUrl,
        region,
        member: member.id as Api.JoinToken['member'],
        role: member.role,
        caps,
      };
      return body;
    },
  );
};

/** The session's region (B053's row). */
async function regionOf(deps: SessionRouteDeps, sid: string): Promise<string> {
  const session = await deps.service.get(sid);
  if (session === null) throw notVisible();
  return session.region;
}

/** The `jti` claim of a JWT the API just signed; null when it has none. */
function jtiOf(jwt: string): string | null {
  const payload = jwt.split('.')[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    const jti = (claims as Record<string, unknown> | null)?.['jti'];
    return typeof jti === 'string' && jti !== '' ? jti : null;
  } catch {
    return null;
  }
}
