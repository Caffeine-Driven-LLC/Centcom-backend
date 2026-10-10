/**
 * `POST /v1/sessions/{id}/claim-host` (B054, CT-API-SESSIONS, CT-WS-CONTROL "Host failover"): a
 * workspace owner or admin takes the host role while the host is gone.
 *
 * - A session the caller may not see is 404; a caller whose workspace role is not owner or admin
 *   is 403 `role_insufficient` (the denial is audited, CT-RBAC rule 6). CT-RBAC has no row for
 *   claiming the host, so the role is read from the records here, as B053's `end` does for
 *   owners and admins.
 * - An ended or expired session is 410 `session_ended`; while the host holds a relay connection
 *   (B053's `host_connected`) it is 409 `conflict`, and nothing changes.
 * - A caller who is not yet a member joins first (`admit`, as join-token does; a locked session
 *   does not stop an admin), with their token's device.
 * - Then, in one transaction with the session locked (`store.claimHost`): the old host becomes
 *   `editor`, the caller `host`, `sessions.host_member_id` moves (with a fresh 10 min grace to
 *   connect), a `control.host_changed` (`code: failover`) row is queued, and one
 *   `control.transfer_host` audit event is written. The caller already being the host changes
 *   nothing.
 * - After the commit the queued row goes to the relay (`HostChangeNotifier`). A notifier that is
 *   down leaves it queued and the answer is still 200; `deliverHostChanges(deps, now)` retries it
 *   with backoff. Only the next claim on the same session calls it today: a periodic sweep (the
 *   worker, beside B053's) is wiring a later lane adds.
 * - A claim that is refused or fails removes the membership `admit` added for it.
 *
 * 200 with the `Session` (its `host` the caller's member).
 *
 * Owns: claiming the host. Must not: claim while the host is connected, or notify before the
 * commit.
 */
import { isId } from '@centcom/contracts';
import { AppError, noopMetrics } from '@centcom/core';
import type { FastifyPluginAsync } from 'fastify';
import {
  callerOf,
  maySee,
  notVisible,
  sessionBody,
  sessionEtag,
  SESSION_ROUTE_DETAILS,
  sessionIdOf,
  sessionOver,
} from './access.js';
import type { SessionRouteDeps } from './index.js';
import { admit, liveDevice, release } from './join-token.js';
import { HOST_OUTBOX_BASE_DELAY_MS, HOST_OUTBOX_MAX_DELAY_MS, type ClaimResult } from './store.js';

/** Host changes one delivery run sends at most. */
export const HOST_OUTBOX_BATCH = 200;

/**
 * Delivers queued host changes due at `nowMs` (of `sessionId` only, when given); the number
 * delivered. Each carries the session's current host. Never throws for a failed send.
 */
export async function deliverHostChanges(
  deps: Pick<SessionRouteDeps, 'store' | 'hostNotifier' | 'logger' | 'metrics'>,
  nowMs: number,
  sessionId?: string,
): Promise<number> {
  const metrics = deps.metrics ?? noopMetrics;
  const now = new Date(nowMs);
  const rows = await deps.store.pendingHostChanges(now, HOST_OUTBOX_BATCH, sessionId);
  let delivered = 0;
  for (const row of rows) {
    let sent = row.host === null;
    if (!sent && row.host !== null) {
      try {
        await deps.hostNotifier.hostChanged(row.sessionId, row.host, row.code);
        sent = true;
      } catch {
        metrics.counter('session_host_outbox_failed_total').inc();
      }
    }
    const attempts = row.attempts + 1;
    const retryAt = sent
      ? null
      : new Date(
          nowMs + Math.min(HOST_OUTBOX_MAX_DELAY_MS, HOST_OUTBOX_BASE_DELAY_MS * 2 ** row.attempts),
        );
    try {
      await deps.store.settleHostChange(row.id, retryAt, attempts);
    } catch (err) {
      deps.logger?.warn(
        { error: err instanceof Error ? err.name : typeof err },
        'session.host_outbox_settle_failed',
      );
    }
    if (sent) delivered += 1;
    else deps.logger?.warn({ session: row.sessionId, attempts }, 'session.host_outbox_retry');
  }
  return delivered;
}

export const claimHostRoutes: FastifyPluginAsync<SessionRouteDeps> = async (app, deps) => {
  const clock = deps.clock ?? Date.now;

  app.post(
    '/v1/sessions/:id/claim-host',
    { config: { auth: { scopes: ['sessions:host'] } } },
    async (request, reply) => {
      const caller = callerOf(request);
      const sid = sessionIdOf(request);
      const standing = await deps.store.standing(sid, caller.userId);
      if (standing === null || !(await maySee(request, caller, standing))) throw notVisible();
      const workspaceId = standing.session.workspaceId;
      const role = standing.workspaceRole;
      if (workspaceId === null || (role !== 'owner' && role !== 'admin')) {
        request.audit.detached({
          action: 'permission.denied',
          workspaceId,
          target: { type: 'session', id: sid },
          outcome: 'denied',
          meta: { attempted: 'session.claim_host', reason: 'role', session_id: sid },
        });
        throw new AppError('role_insufficient', { detail: SESSION_ROUTE_DETAILS.adminOnly });
      }
      if (standing.session.state === 'ended' || standing.session.state === 'expired') {
        throw sessionOver();
      }
      if (standing.session.hostConnected) {
        throw new AppError('conflict', { detail: SESSION_ROUTE_DETAILS.hostPresent });
      }
      const deviceId = await liveDevice(deps, caller);
      const claimant =
        standing.member === null
          ? await admit(request, deps, caller, deviceId, standing, { ignoreLock: true })
          : { ...standing.member, added: false };
      let result: ClaimResult;
      try {
        result = await deps.store.claimHost(sid, claimant.id, new Date(clock()), (trx) =>
          request
            .audit(trx, {
              action: 'control.transfer_host',
              workspaceId,
              target: { type: 'session_member', id: claimant.id },
              meta: { session_id: sid, code: 'failover' },
            })
            .then(() => undefined),
        );
      } catch (err) {
        if (claimant.added) await release(deps, sid, claimant.id);
        throw err;
      }
      if (claimant.added && result.kind !== 'claimed' && result.kind !== 'already') {
        // A refused claim leaves the session as it was: not even the admin's new membership.
        await release(deps, sid, claimant.id);
      }
      switch (result.kind) {
        case 'gone':
          throw notVisible();
        case 'over':
          throw sessionOver();
        case 'host_present':
          throw new AppError('conflict', { detail: SESSION_ROUTE_DETAILS.hostPresent });
        case 'not_member':
          throw new AppError('conflict', { detail: SESSION_ROUTE_DETAILS.changed });
        case 'claimed':
          try {
            await deliverHostChanges(deps, clock(), sid);
          } catch (err) {
            // Queued: the sweep delivers it; the claim stands.
            deps.logger?.warn(
              { error: err instanceof Error ? err.name : typeof err },
              'session.host_outbox_read_failed',
            );
          }
          break;
        case 'already':
          break;
      }
      const session = await deps.service.get(sid);
      if (session === null || !isId('mem', session.host)) throw notVisible();
      reply.header('etag', sessionEtag(session)).header('cache-control', 'private, no-cache');
      return sessionBody(session);
    },
  );
};
