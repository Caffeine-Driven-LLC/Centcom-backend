/**
 * The account lifecycle's audit actions (B026; CT-API-AUDIT: every state-changing endpoint
 * audits). CT-API-AUDIT's list of stable names has no account actions, and B036 keeps the
 * built-in AUDIT_ACTIONS equal to that list, so this module extends the catalogue for its own
 * emitter only, the way B082 does for `audit.export`. Adding them to the contract is a follow-up.
 *
 * All four are account-level events (no workspace) with the user as the target:
 * `account.delete_request` (meta `scheduled_for`, an ISO time), `account.restore`,
 * `account.export` (target the `exp_` export) and `account.purge` (meta `outcome`: `deleted` or
 * `scrubbed`, written by the system actor `account-purge` after the user's id is pseudonymised).
 *
 * Owns: the actions and their meta allowlists. Must not: allow a key whose values are content.
 */
import { AUDIT_ACTIONS, defineAuditActions } from '@centcom/core';

/** The audit action of each lifecycle step. */
export const ACCOUNT_ACTIONS = Object.freeze({
  deleteRequest: 'account.delete_request',
  restore: 'account.restore',
  export: 'account.export',
  purge: 'account.purge',
} as const);

/** B036's catalogue and the account actions. */
export const ACCOUNT_LIFECYCLE_ACTIONS = defineAuditActions({
  ...AUDIT_ACTIONS,
  [ACCOUNT_ACTIONS.deleteRequest]: { meta: ['scheduled_for'] },
  [ACCOUNT_ACTIONS.restore]: { meta: [] },
  [ACCOUNT_ACTIONS.export]: { meta: [] },
  [ACCOUNT_ACTIONS.purge]: { meta: ['outcome'] },
});

/** An action the account lifecycle's emitter accepts. */
export type AccountLifecycleAction = keyof typeof ACCOUNT_LIFECYCLE_ACTIONS;
