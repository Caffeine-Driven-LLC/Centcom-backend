/**
 * Table types of the audit log (B036, migration 20260102000600_audit_events.sql). The audit
 * emitter in @centcom/core writes the table and owns its types; they are re-exported here beside
 * the other schema types for readers such as the audit API (B082).
 */
export type { AuditDatabase, AuditEventsTable } from '@centcom/core';
