/**
 * The notification dispatcher (B063, CT-NOTIF-PAYLOAD): publishing events, dispatching them to
 * inbox, push and e-mail, and the hourly digest. The queue names and the event type are in
 * @centcom/core, the SQL in @centcom/db (`createNotificationStore`), the BullMQ jobs in
 * @centcom/worker (`notify-dispatch`, `notify-digest`). See README.md.
 */
export {
  buildPayload,
  DEDUPE_WINDOW_MS,
  DISPATCHER_DETAILS,
  NotificationDispatcher,
  type DispatchResult,
  type NotificationDispatcherOptions,
} from './dispatcher.js';
export { DIGEST_MAX_ITEMS, payloadOf, runDigest, type DigestDeps } from './digest.js';
export {
  checkEvent,
  eventIssues,
  MAX_EVENT_RECIPIENTS,
  NotificationEventError,
  PARAM_RULES,
  type EventIssue,
} from './params.js';
export type {
  DispatchQueue,
  EmailPort,
  NotificationEmailTemplate,
  NotificationPayload,
  NotificationStorePort,
  PreferencesPort,
  PushSenderPort,
  QuietHoursPort,
  UserNotificationPrefs,
} from './ports.js';
export { resolveRecipients, type RecipientDirectory } from './recipients.js';
export {
  decideChannels,
  defaultChannels,
  MANDATORY_CATEGORIES,
  quietHours,
  type RoutingInput,
} from './routing.js';
