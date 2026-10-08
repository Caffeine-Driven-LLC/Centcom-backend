/**
 * What the notification dispatcher (B063) needs from other lanes:
 *
 * - `PreferencesPort` (B066): a user's channel switches and quiet hours (CT-API-NOTIFY
 *   `NotificationPreferences`); null when the user never set any (the contract defaults apply).
 * - `QuietHoursPort`: whether quiet hours are on now (default `quietHours` in routing.ts).
 * - `PushSenderPort` (B064): queues a push of a payload to a user's subscriptions.
 * - `EmailPort` (B032's e-mail service behind it): queues a notification e-mail, one item or an
 *   hourly digest, to a user's address.
 * - `DispatchQueue`: the `notify.dispatch` BullMQ queue (@centcom/worker
 *   `createNotifyDispatchQueue`).
 * - `NotificationStorePort`: @centcom/db `createNotificationStore(db)`.
 *
 * Owns: the ports and the payload type.
 */
import type { Api } from '@centcom/contracts';
import type {
  NotificationActionType,
  NotificationCategory,
  NotificationPriority,
  NotifyDispatchJobData,
  notifyDispatchJobOptions,
} from '@centcom/core';
import type { NotificationStore } from '@centcom/db';

/** CT-NOTIF-PAYLOAD: keys, ids, enums and integers; never display text. */
export interface NotificationPayload {
  id: string;
  created_at: string;
  read_at: string | null;
  category: NotificationCategory;
  title_key: string;
  body_key: string;
  params: Record<string, string | number>;
  action?: { type: NotificationActionType; deeplink?: string };
  priority: NotificationPriority;
}

/** A user's notification preferences (CT-API-NOTIFY). */
export type UserNotificationPrefs = Api.NotificationPreferences;

/** B066's preferences. */
export interface PreferencesPort {
  get(userId: string): Promise<UserNotificationPrefs | null>;
}

/** Whether quiet hours are on. */
export interface QuietHoursPort {
  isQuiet(prefs: UserNotificationPrefs, now: Date): boolean;
}

/** B064's push sender. */
export interface PushSenderPort {
  enqueue(userId: string, payload: NotificationPayload): Promise<void>;
}

/** The e-mail templates notifications use. */
export type NotificationEmailTemplate = 'notification' | 'notification_digest';

/** Notification e-mails (B032's service maps the user to an address and renders the keys). */
export interface EmailPort {
  enqueue(
    userId: string,
    template: NotificationEmailTemplate,
    payload: { items: NotificationPayload[]; idempotencyKey: string },
  ): Promise<void>;
}

/** The `notify.dispatch` queue. */
export interface DispatchQueue {
  add(
    name: string,
    data: NotifyDispatchJobData,
    opts: ReturnType<typeof notifyDispatchJobOptions> & { jobId: string },
  ): Promise<unknown>;
}

/** The notification store. */
export type NotificationStorePort = NotificationStore;
