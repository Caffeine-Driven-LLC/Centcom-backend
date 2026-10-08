/**
 * Notification names (B063, CT-NOTIF-PAYLOAD) shared by the API, which publishes notification
 * events, and the worker, which dispatches them: the categories, channels and priorities, the
 * event a producing lane publishes, the BullMQ queues (`notify.dispatch`, its dead-letter queue
 * `notify.dispatch.dlq`, and the hourly `notify.digest`) and their job options.
 *
 * Owns: the names, the event and job shapes, and the job options. Must not: carry display text,
 * or anything but ids, enums and integers, in an event.
 */
import type { WorkspaceRole } from '../rbac/actions.js';

/** CT-NOTIF-PAYLOAD categories. */
export const NOTIFICATION_CATEGORIES = Object.freeze([
  'trial_ending',
  'approval_needed',
  'queue_turn',
  'mention',
  'member_joined',
  'member_left',
  'agent_done',
  'ci_failed',
  'pr_merged',
  'usage_warning',
  'quota_reached',
  'billing_issue',
  'invite_received',
  'update_available',
  'security_alert',
] as const);
/** A notification category. */
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Where a notification can go (`os` is rendered by clients from inbox and push). */
export const NOTIFICATION_CHANNELS = Object.freeze(['inbox', 'push', 'email', 'os'] as const);
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Notification priorities. */
export const NOTIFICATION_PRIORITIES = Object.freeze(['low', 'normal', 'high'] as const);
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

/** CT-NOTIF-PAYLOAD `action.type`. */
export const NOTIFICATION_ACTIONS = Object.freeze([
  'open_session',
  'open_billing',
  'open_invite',
  'open_update',
  'none',
] as const);
export type NotificationActionType = (typeof NOTIFICATION_ACTIONS)[number];

/** Who a notification event is for. */
export type NotificationRecipients =
  | { users: string[] }
  | { workspace: string; roles: WorkspaceRole[] }
  | { session: string; members: string[] };

/** What a producing lane publishes. */
export interface NotificationEvent {
  category: NotificationCategory;
  recipients: NotificationRecipients;
  /** Ids, enums and integers only, by the category's allow-list. */
  params: Record<string, string | number>;
  /** Default `normal`. */
  priority?: NotificationPriority;
  /** Events of one key for one user within 10 minutes make one notification. */
  dedupeKey?: string;
  action?: { type: NotificationActionType; deeplink?: string };
}

/** The queue notification events are dispatched from. */
export const NOTIFY_DISPATCH_QUEUE = 'notify.dispatch';
/** Where a dispatch that failed every attempt is kept. */
export const NOTIFY_DISPATCH_DLQ = 'notify.dispatch.dlq';
/** The hourly e-mail digest queue. */
export const NOTIFY_DIGEST_QUEUE = 'notify.digest';
/** How often the digest runs. */
export const NOTIFY_DIGEST_EVERY_MS = 60 * 60 * 1000;
/** Attempts of a dispatch job, the first included, before it is dead-lettered. */
export const NOTIFY_DISPATCH_ATTEMPTS = 5;
/** The first retry waits between half and all of this; each later one twice as long. */
export const NOTIFY_DISPATCH_BACKOFF_BASE_MS = 5_000;
/** Completed and failed jobs are kept this long, in seconds (7 days). */
export const NOTIFY_FAILED_RETENTION_S = 7 * 24 * 60 * 60;

/** A dispatch job: the event, under the id that makes its dispatch idempotent. */
export interface NotifyDispatchJobData {
  eventId: string;
  event: NotificationEvent;
  /** RFC 3339. */
  publishedAt: string;
}

/** Options of a dispatch job: 5 attempts, exponential backoff with jitter, failures kept 7 days. */
export function notifyDispatchJobOptions(): {
  attempts: number;
  backoff: { type: 'exponential'; delay: number; jitter: number };
  removeOnComplete: true;
  removeOnFail: { age: number };
} {
  return {
    attempts: NOTIFY_DISPATCH_ATTEMPTS,
    backoff: { type: 'exponential', delay: NOTIFY_DISPATCH_BACKOFF_BASE_MS, jitter: 0.5 },
    removeOnComplete: true,
    removeOnFail: { age: NOTIFY_FAILED_RETENTION_S },
  };
}
