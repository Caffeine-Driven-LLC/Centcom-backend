/**
 * One admin API call (B087) as its audit event will record it: who (filled in as the access checks
 * learn it), what (method and route template), on what (the target), why (reason and ticket), and
 * whether it was refused (a 401, 403 or 429, or any problem before the work began: outcome
 * `denied`) or failed doing it (`failed`). The card's outcome `error` is `failed`, the audit
 * table's name for it.
 *
 * Owns: the call record and its event. Must not: put the URL, a header value or a body in it.
 */
import type { AuditActor, AuditEvent, AuditOutcome, AuditTarget } from '@centcom/core';
import { isId } from '@centcom/contracts';
import type { StaffRole } from '@centcom/db';
import { STAFF_ACCESS_ACTION, type AdminAuditAction } from './actions.js';
import type { CallDetails } from './repository.js';

/** The actor of a call made without a usable credential. */
export const ANONYMOUS_ACTOR: AuditActor = Object.freeze({ type: 'system', id: 'admin-api' });

/** A staff member making a call. */
export interface StaffMember {
  userId: string;
  role: StaffRole;
}

/** A call in progress. */
export interface AdminCall {
  readonly requestId: string;
  readonly method: string;
  /** The route template (`/internal/admin/v1/users/:id`), or `(unmatched)`. */
  route: string;
  actor: AuditActor;
  staff: StaffMember | null;
  phase: 'access' | 'work';
  target: AuditTarget | null;
  /** The flag key, on flag routes. */
  flag: string | null;
  /** A valid X-Admin-Reason, else null. */
  reason: string | null;
  /** A valid X-Admin-Ticket, else null. */
  ticket: string | null;
  /** The access checks ran (the caller was looked up, whatever came of it). */
  checked: boolean;
  /** The call's event committed, or writing it was given up on: nothing more is written. */
  recorded: boolean;
}

/** A new call: anonymous until the access checks say otherwise. */
export function newCall(requestId: string, method: string, route: string): AdminCall {
  return {
    requestId,
    method,
    route,
    actor: ANONYMOUS_ACTOR,
    staff: null,
    phase: 'access',
    target: null,
    flag: null,
    reason: null,
    ticket: null,
    checked: false,
    recorded: false,
  };
}

/** Statuses that are refusals wherever they come from. */
const REFUSALS: ReadonlySet<number> = new Set([401, 403, 429]);

/** The outcome of a call answered with `status`. */
export function outcomeOf(call: AdminCall, status: number): AuditOutcome {
  if (status < 400) return 'success';
  return REFUSALS.has(status) || call.phase === 'access' ? 'denied' : 'failed';
}

/** The call's `staff.access` event. */
export function callEvent(
  call: AdminCall,
  outcome: AuditOutcome,
  status: number,
  code: string | null,
): AuditEvent<AdminAuditAction> {
  return {
    workspaceId: null,
    actor: call.actor,
    action: STAFF_ACCESS_ACTION,
    ...(call.target === null ? {} : { target: call.target }),
    outcome,
    ...(isId('req', call.requestId) ? { requestId: call.requestId } : {}),
    meta: {
      method: call.method,
      route: call.route,
      status,
      code,
      role: call.staff?.role ?? null,
      flag: call.flag,
    },
  };
}

/** The call's reason and ticket. */
export const callDetails = (call: AdminCall): CallDetails => ({
  reason: call.reason,
  ticket: call.ticket,
});
