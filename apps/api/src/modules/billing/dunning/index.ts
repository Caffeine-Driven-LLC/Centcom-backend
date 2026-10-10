/**
 * Dunning (B078): the payment-failure lifecycle, its state machine, repository, audit action,
 * reminder email, drop notice and configuration. B072's handlers call `applyBillingEvent`; the
 * worker's `dunning` queue runs `expire`, `remind` and `windDown`. See docs/billing/dunning.md.
 */
export {
  BILLING_STATUS_ACTION,
  DUNNING_AUDIT_ACTIONS,
  statusAuditEvent,
  type DunningAuditAction,
} from './actions.js';
export { dunningEnvSchema, loadDunningConfig, WINDDOWN_MIN, type DunningConfig } from './config.js';
export {
  current,
  decide,
  decideExpiry,
  droppedRow,
  DUNNING_EVENT_TYPES,
  dueReminders,
  expiry,
  REMINDER_DAYS,
  reminderBit,
  reminderDueAt,
  type BillingEvent,
  type Decision,
  type DunningRow,
  type NoneReason,
  type ReminderDay,
  type Status,
  type StatusTransition,
  type SubscriptionNow,
} from './machine.js';
export { PAYMENT_FAILED_TEMPLATE, PAYMENT_FAILED_TEMPLATE_ID } from './mail.js';
export { dunningNoticeChannel, PLAN_CHANGED_NOTICE, publishPlanChanged } from './notice.js';
export {
  createDunningRepository,
  type AlignedSubscription,
  type AuditOf,
  type DunningRepository,
} from './repository.js';
export {
  DUNNING_BATCH,
  DUNNING_MAX_BATCHES,
  DunningService,
  type DunningScheduler,
  type DunningServiceDeps,
  type ExpireReport,
  type SessionEnder,
} from './service.js';
