/**
 * The audit actions of flag changes (B083 guardrail: "audit every flag mutation with actor and
 * previous value hash"): `flag.set` and `flag.delete`.
 *
 * CT-API-AUDIT's list of stable action names does not have them, and B036 keeps the built-in
 * AUDIT_ACTIONS equal to that list. So, like B082's `audit.export`, this module extends the
 * catalogue for its own emitter only (`defineAuditActions({...AUDIT_ACTIONS, ...})`). Adding them
 * to the contract's list is a follow-up.
 *
 * Meta: `flag` (the flag's key: `[a-z0-9_.-]`, never a value), `rev` (the revision the change
 * made), `prev_hash` (hex SHA-256 of the previous definition, null for a new flag), `created`
 * (set) and `kill` (the kill switch after a set). Events are outside any workspace.
 *
 * Owns: the actions and their meta allowlists. Must not: allow a key whose values are flag values.
 */
import { AUDIT_ACTIONS, defineAuditActions } from '@centcom/core';

export const FLAG_SET_ACTION = 'flag.set';
export const FLAG_DELETE_ACTION = 'flag.delete';

/** B036's catalogue and the flag actions. */
export const FLAG_AUDIT_ACTIONS = defineAuditActions({
  ...AUDIT_ACTIONS,
  [FLAG_SET_ACTION]: { meta: ['flag', 'rev', 'prev_hash', 'created', 'kill'] },
  [FLAG_DELETE_ACTION]: { meta: ['flag', 'rev', 'prev_hash'] },
});

/** An action the flags module's emitter accepts. */
export type FlagAuditAction = keyof typeof FLAG_AUDIT_ACTIONS;
