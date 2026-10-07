/**
 * Membership announcements (B028): after a change commits, each `MembershipEvent` is published on
 * `centcom:membership` (the relay re-checks the member's live role), and RBAC caches drop the
 * member's role (`rbac:invalidate`). A publish that fails is retried 3 times with jitter; then it
 * is logged and counted (`membership_event_publish_failed_total`): the relay still converges
 * through its live membership checks (at most 2 s old, CT-RBAC rule 2).
 *
 * Owns: publishing and its retries. Must not: publish before the commit, or log the message.
 */
import { setTimeout as sleepFor } from 'node:timers/promises';
import {
  MEMBERSHIP_EVENTS_CHANNEL,
  noopMetrics,
  publishInvalidation,
  RBAC_INVALIDATE_CHANNEL,
  type Logger,
  type MembershipEvent,
  type Metrics,
  type PubSub,
} from '@centcom/core';

/** Retries after a failed publish. */
export const PUBLISH_RETRIES = 3;
/** The first retry waits between half and all of this; each later one twice as long. */
export const PUBLISH_RETRY_BASE_MS = 20;

/** What announcing needs. */
export interface AnnounceDeps {
  events: PubSub;
  logger?: Logger;
  metrics?: Metrics;
  /** Waits between retries; default a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source; default Math.random. */
  random?: () => number;
}

/** Publishes `message` on `channel`, retrying; resolves to whether it went out. */
async function publishWithRetries(
  deps: AnnounceDeps,
  channel: string,
  send: () => Promise<void>,
): Promise<boolean> {
  const sleep = deps.sleep ?? ((ms: number) => sleepFor(ms).then(() => undefined));
  const random = deps.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      await send();
      return true;
    } catch {
      if (attempt >= PUBLISH_RETRIES) break;
      const ceiling = PUBLISH_RETRY_BASE_MS * 2 ** attempt;
      await sleep(Math.round(ceiling / 2 + (random() * ceiling) / 2));
    }
  }
  (deps.metrics ?? noopMetrics).counter('membership_event_publish_failed_total', { channel }).inc();
  return false;
}

/**
 * Announces committed membership changes: each event on `centcom:membership`, then a role cache
 * invalidation per member. Never throws; failures are logged and counted.
 */
export async function announceMembershipChanges(
  deps: AnnounceDeps,
  events: readonly MembershipEvent[],
): Promise<void> {
  for (const event of events) {
    const sent = await publishWithRetries(deps, MEMBERSHIP_EVENTS_CHANNEL, () =>
      deps.events.publish(MEMBERSHIP_EVENTS_CHANNEL, JSON.stringify(event)),
    );
    if (!sent) {
      deps.logger?.error(
        { workspace_id: event.wsp, member_id: event.mem, type: event.type },
        'membership.publish_failed',
      );
    }
    const dropped = await publishWithRetries(deps, RBAC_INVALIDATE_CHANNEL, () =>
      publishInvalidation(deps.events, { workspaceId: event.wsp, userId: event.user }),
    );
    if (!dropped) {
      deps.logger?.error({ workspace_id: event.wsp }, 'membership.invalidate_failed');
    }
  }
}
