/**
 * Approval expiry (B060): at `expires_at` the relay sequences one server `approval.decision`
 * `{decision:'deny', scope:'once'}` per pending approval, exactly once.
 *
 * - The sweep reads each watched session's pending list from Redis, so a restarted relay re-arms
 *   every approval with its original `expires_at` as soon as it watches the session again.
 * - Before the deny it claims the approval's decision (`SET NX`, kept as long as the list): one
 *   sweeper wins even when several run, and an approval a member decided first is never denied.
 *   A deny that cannot be sequenced gives the claim back, so the next sweep tries again (when the
 *   failure left it unclear whether the deny went out, it may go out twice: server frames have no
 *   de-duplication key).
 * - An expired entry whose decision is held (a member's, or a deny whose tidy-up failed) is only
 *   tidied away, never denied, once `APPROVAL_KEY_GRACE_MS` past its expiry (a member's decision
 *   claimed just before expiry may still be on its way to the sequencer until then).
 * - A decision that arrives at or after `expires_at` is refused as expired (the router), so a
 *   lagging sweep never races a late member's decision.
 *
 * Owns: the timeout deny. Must not: decide anything else, or auto-approve.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import {
  APPROVAL_KEY_GRACE_MS,
  type ApprovalEmitter,
  type ApprovalStore,
  type DecisionClaim,
} from './ports.js';

/** The timeout's claim on a decision. */
export const EXPIRY_CLAIM: Readonly<DecisionClaim> = Object.freeze({
  by: 'srv',
  frameId: 'expiry',
});

/** What a sweep needs. */
export interface ExpiryDeps {
  store: ApprovalStore;
  emitter: ApprovalEmitter;
  logger?: Logger;
  metrics?: Metrics;
}

/** What one sweep of a session found. */
export interface SessionSweep {
  /** Pending approvals left in the session. */
  pending: number;
  /** Timeout denies sequenced. */
  denied: number;
}

/** Sweeps `sid` at `now`: sequences the timeout deny of every expired approval it wins. */
export async function sweepSession(
  deps: ExpiryDeps,
  sid: string,
  now: Date,
): Promise<SessionSweep> {
  const metrics = deps.metrics ?? noopMetrics;
  const list = await deps.store.list(sid);
  let denied = 0;
  for (const a of list) {
    if (Date.parse(a.expiresAt) > now.getTime()) continue;
    const claim = await deps.store.claim(sid, a.approvalId, {
      ...EXPIRY_CLAIM,
      at: now.getTime(),
      requestFrame: a.frameId,
      requester: a.requester,
      expiresAt: a.expiresAt,
    });
    if (claim !== true) {
      // Decided already (or another sweeper's deny is on its way): never a second decision.
      if (now.getTime() >= Date.parse(a.expiresAt) + APPROVAL_KEY_GRACE_MS) {
        await deps.store.remove(sid, [a.approvalId]).catch(() => undefined);
      }
      continue;
    }
    try {
      await deps.emitter.emitTimeout(sid, a.approvalId);
    } catch (err) {
      metrics.counter('relay_approval_emit_failures_total').inc();
      deps.logger?.warn(
        { sid, error: err instanceof Error ? err.name : 'unknown' },
        'approvals.timeout_failed',
      );
      await deps.store.release(sid, a.approvalId, EXPIRY_CLAIM).catch(() => undefined);
      continue;
    }
    denied += 1;
    metrics.counter('relay_approval_timeouts_total').inc();
    await deps.store.remove(sid, [a.approvalId]).catch(() => undefined);
  }
  return { pending: list.length - denied, denied };
}
