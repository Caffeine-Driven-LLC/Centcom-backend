/**
 * Audit (B036, CT-API-AUDIT): the emitter every state-changing path writes audit events through,
 * transactionally (`emit(trx, event)`) or in the background (`emitDetached`), the action catalogue
 * with its meta allowlists, the table types, and the RBAC sink for refused privileged actions.
 * Rows are append-only: the table refuses UPDATE, DELETE and TRUNCATE, and retention deletes only
 * through `purge_audit_events` (migration 20260102000600_audit_events.sql).
 */
export {
  AUDIT_ACTIONS,
  defineAuditActions,
  MAX_AUDIT_ACTION_LENGTH,
  type AuditAction,
  type AuditActionRule,
  type AuditCatalog,
} from './actions.js';
export {
  AUDIT_META_MAX_BYTES,
  AUDIT_META_MAX_STRING,
  InvalidAuditActionError,
  InvalidAuditEventError,
  isSecretLike,
  sanitizeAuditMeta,
  toAuditRow,
  type AuditActor,
  type AuditActorType,
  type AuditEvent,
  type AuditMetaValue,
  type AuditOutcome,
  type AuditTarget,
} from './event.js';
export {
  AUDIT_BATCH_INTERVAL_MS,
  AUDIT_BATCH_MAX,
  AUDIT_DROP_LOG_INTERVAL_MS,
  AUDIT_LATENCY_BUCKETS_MS,
  AUDIT_QUEUE_MAX,
  AUDIT_RETRY_MAX_MS,
  createAuditEmitter,
  type AuditDb,
  type AuditEmitter,
  type AuditEmitterOptions,
} from './emitter.js';
export { deniedEvent, rbacAuditSink } from './rbac.js';
export type { AuditDatabase, AuditEventsTable, NewAuditRow } from './table.js';
