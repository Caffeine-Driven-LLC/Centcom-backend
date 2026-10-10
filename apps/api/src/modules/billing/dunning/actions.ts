/**
 * Dunning's audit action (B078 scope: "Emit audit events"): `billing.status`, one event per status
 * change (`from`, `to`, and `reason` for a drop to `none`), written in the transaction of the
 * change, workspace-scoped, actor `system`/`dunning`, target the workspace.
 *
 * CT-API-AUDIT's list of stable action names has no billing status action, and B036 keeps the
 * built-in AUDIT_ACTIONS equal to that list. So, like B026, B082 and B083, this module extends
 * the catalogue for its own emitter only (`defineAuditActions({...AUDIT_ACTIONS, ...})`). Adding
 * it to the contract's list is a follow-up.
 *
 * Owns: the action and its meta allowlist. Must not: allow a key whose values are content.
 */
import { AUDIT_ACTIONS, defineAuditActions, type AuditEvent } from '@centcom/core';
import type { NoneReason, StatusTransition } from './machine.js';

/** The action of a status change. */
export const BILLING_STATUS_ACTION = 'billing.status';

/** B036's catalogue and the dunning action. */
export const DUNNING_AUDIT_ACTIONS = defineAuditActions({
  ...AUDIT_ACTIONS,
  [BILLING_STATUS_ACTION]: { meta: ['from', 'to', 'reason'] },
});

/** An action the dunning emitter accepts. */
export type DunningAuditAction = keyof typeof DUNNING_AUDIT_ACTIONS;

/** The audit event of `transition` (with the reason of a drop to `none`). */
export function statusAuditEvent(
  transition: StatusTransition,
  reason: NoneReason | null = null,
): AuditEvent<DunningAuditAction> {
  return {
    workspaceId: transition.workspace,
    actor: { type: 'system', id: 'dunning' },
    action: BILLING_STATUS_ACTION,
    target: { type: 'workspace', id: transition.workspace },
    outcome: 'success',
    meta: {
      from: transition.from,
      to: transition.to,
      ...(reason === null ? {} : { reason }),
    },
  };
}
