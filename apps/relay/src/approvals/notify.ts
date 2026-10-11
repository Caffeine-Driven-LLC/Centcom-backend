/**
 * The approval notification through B063's dispatcher (CT-NOTIF-PAYLOAD): one `approval_needed`
 * event per approval, `params {agent, session, risk}` (ids and enums only), for the session
 * members who may decide it now (`mayDecide`: the host, policy approvers, the roles the request's
 * `approver` names; never the requester unless the host), `priority` high for a high risk, deduped
 * by the approval id, opening the session.
 *
 * `approvalNeeded` never blocks or fails the request: the event is published in the background,
 * and a failure (the members cannot be read, the dispatcher refuses) is counted
 * (`relay_approval_notify_failures_total`) and logged. Once published, the dispatcher's queue
 * retries delivery.
 *
 * Owns: the event. Must not: carry the summary, command, cwd or anything else from `ct`.
 */
import { noopMetrics, type Logger, type Metrics, type NotificationEvent } from '@centcom/core';
import type { ApprovalNotice, Decider, NotifyPort } from './ports.js';
import { mayDecide } from './router.js';

/** B063's `NotificationDispatcher.publish`. */
export interface NotificationPublisher {
  publish(event: NotificationEvent): Promise<string>;
}

/** A current session member with its live roles. */
export type SessionDecider = Pick<Decider, 'role' | 'workspaceRole'> & { memberId: string };

/** What the adapter needs. */
export interface DispatcherNotifyDeps {
  publisher: NotificationPublisher;
  /** The session's current members (live roles). */
  members(sid: string): Promise<SessionDecider[]>;
  /** `control.policy.approvers` of the session. */
  approvers(sid: string): Promise<readonly string[]>;
  logger?: Logger;
  metrics?: Metrics;
}

/** The `approval_needed` event of `a` for `to`. */
export function approvalNeededEvent(
  sid: string,
  a: ApprovalNotice,
  to: readonly string[],
): NotificationEvent {
  return {
    category: 'approval_needed',
    recipients: { session: sid, members: [...to] },
    params: { agent: a.agentId, session: sid, risk: a.risk },
    priority: a.risk === 'high' ? 'high' : 'normal',
    dedupeKey: `approval:${a.approvalId}`,
    action: { type: 'open_session' },
  };
}

/** A NotifyPort that publishes to B063's dispatcher. */
export function dispatcherNotify(deps: DispatcherNotifyDeps): NotifyPort {
  const metrics = deps.metrics ?? noopMetrics;
  return {
    approvalNeeded(sid, a) {
      void (async () => {
        const [members, approvers] = await Promise.all([deps.members(sid), deps.approvers(sid)]);
        const to = members
          .filter((m) => mayDecide(m, m.memberId, a, approvers))
          .map((m) => m.memberId);
        if (to.length === 0) return;
        await deps.publisher.publish(approvalNeededEvent(sid, a, to));
      })().catch((err: unknown) => {
        metrics.counter('relay_approval_notify_failures_total').inc();
        deps.logger?.warn(
          { sid, error: err instanceof Error ? err.name : 'unknown' },
          'approvals.notify_failed',
        );
      });
    },
  };
}
