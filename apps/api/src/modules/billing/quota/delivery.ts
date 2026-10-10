/**
 * What a quota signal sends (B076), ids, enums and times only:
 *
 * - **The relay's notice** (CT-WS-SESSION-EVENTS "Notices"): `{code, level, params}` as JSON on
 *   the Redis channel `relay:notice:{wsp}`, which the fan-out engine (B044) delivers to every live
 *   hosted session of the workspace as `sys.notice`. `usage_warning` (level `warn`) carries
 *   `{pct: 80, resets_at}`, `quota_reached` (level `error`) `{resets_at}`; `resets_at` is the
 *   period's end, RFC 3339 UTC with milliseconds.
 * - **The owners' notification** (CT-NOTIF-PAYLOAD) through B063's dispatcher: `usage_warning
 *   {limit, pct: 80}` or `quota_reached {limit}`, to the workspace's owners only, opening billing;
 *   its dedupe key names the workspace, limit, period, level and claim time, so a retried send is
 *   dropped but a level re-armed and claimed again is not.
 * - **The webhook event** (CT-WEBHOOKS) through B081's emitter: `usage.threshold {limit, pct}`,
 *   pct 80 or 100.
 *
 * Owns: the payloads and the channel name. Must not: carry display text or usage numbers other
 * than the threshold.
 */
import { formatTimestamp } from '@centcom/contracts';
import type { NotificationEvent, PubSub, WebhookEventInput } from '@centcom/core';
import type { SignalLevel } from './levels.js';
import type { SignalRow } from './store.js';

/** The channel of a workspace's notices (`relay:notice:{wsp}`). */
export const noticeChannel = (workspaceId: string): string => `relay:notice:${workspaceId}`;

/** A `sys.notice` body. */
export type QuotaNotice =
  | { code: 'usage_warning'; level: 'warn'; params: { pct: 80; resets_at: string } }
  | { code: 'quota_reached'; level: 'error'; params: { resets_at: string } };

/** The notice of `level` for a period ending `periodEnd`. */
export function noticeOf(level: SignalLevel, periodEnd: Date): QuotaNotice {
  const resetsAt = formatTimestamp(periodEnd);
  return level === 'warn'
    ? { code: 'usage_warning', level: 'warn', params: { pct: 80, resets_at: resetsAt } }
    : { code: 'quota_reached', level: 'error', params: { resets_at: resetsAt } };
}

/** Where notices go. */
export interface NoticePort {
  publish(workspaceId: string, notice: QuotaNotice): Promise<void>;
}

/** Notices as JSON on `relay:notice:{wsp}` (B009's pub/sub). */
export const pubsubNotices = (pubsub: Pick<PubSub, 'publish'>): NoticePort => ({
  publish: (workspaceId, notice) =>
    pubsub.publish(noticeChannel(workspaceId), JSON.stringify(notice)),
});

/** B063's dispatcher, as quota signals use it. */
export interface QuotaNotifyPort {
  publish(event: NotificationEvent): Promise<string>;
}

/** B081's `emitWebhookEvent`. */
export type EmitWebhook = (input: WebhookEventInput) => Promise<unknown>;

/** The threshold a level stands for. */
export const pctOfLevel = (level: SignalLevel): 80 | 100 => (level === 'warn' ? 80 : 100);

/** The owners' notification of a signal. */
export function notificationOf(row: SignalRow): NotificationEvent {
  const period = row.periodStart.toISOString();
  return {
    category: row.level === 'warn' ? 'usage_warning' : 'quota_reached',
    recipients: { workspace: row.workspaceId, roles: ['owner'] },
    params: row.level === 'warn' ? { limit: row.limitKey, pct: 80 } : { limit: row.limitKey },
    priority: row.level === 'warn' ? 'normal' : 'high',
    dedupeKey: `quota:${row.workspaceId}:${row.limitKey}:${period}:${row.level}:${row.claimedAt.getTime()}`,
    action: { type: 'open_billing' },
  };
}

/** The webhook event of a signal. */
export function webhookOf(row: SignalRow): WebhookEventInput {
  return {
    type: 'usage.threshold',
    workspace: row.workspaceId,
    data: { limit: row.limitKey, pct: pctOfLevel(row.level) },
  };
}
