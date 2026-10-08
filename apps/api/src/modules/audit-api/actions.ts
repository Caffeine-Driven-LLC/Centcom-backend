/**
 * The audit API's own action (B082): `audit.export`, written when an export is requested (CT-API-AUDIT:
 * every state-changing endpoint audits; scope_in: "audit event for the export request itself").
 *
 * CT-API-AUDIT's list of stable action names does not have it, and B036 keeps the built-in
 * AUDIT_ACTIONS equal to that list. So this module extends the catalogue for its own emitter only,
 * the way B036 provides (`defineAuditActions({...AUDIT_ACTIONS, ...})`); the request emitter and
 * every other writer are unchanged. Adding `audit.export` to the contract's list is a follow-up.
 *
 * Meta: `format` (`csv`, `json`), `gzip` (a flag) and `filters`, the names of the filters the
 * export was given, comma-separated (`action,from`), never their values.
 *
 * Owns: the action and its meta allowlist. Must not: allow a key whose values are content.
 */
import { AUDIT_ACTIONS, defineAuditActions } from '@centcom/core';

/** The export request's action. */
export const AUDIT_EXPORT_ACTION = 'audit.export';

/** B036's catalogue and `audit.export`. */
export const AUDIT_API_ACTIONS = defineAuditActions({
  ...AUDIT_ACTIONS,
  [AUDIT_EXPORT_ACTION]: { meta: ['format', 'gzip', 'filters'] },
});

/** An action the audit API's emitter accepts. */
export type AuditApiAction = keyof typeof AUDIT_API_ACTIONS;
