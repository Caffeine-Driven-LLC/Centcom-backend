/**
 * The audit action of the admin API (B087): `staff.access`, one event per call, allowed, refused
 * or failed, reads as well as writes (support access to personal data is itself sensitive).
 *
 * CT-API-AUDIT's list of stable action names does not have it, and B036 keeps the built-in
 * AUDIT_ACTIONS equal to that list, so (like B082's `audit.export` and B083's flag actions) this
 * module extends the catalogue for its own emitter only.
 *
 * Meta: `method`, `route` (the route template, never the URL: a query can hold an e-mail
 * address), `status` (the HTTP status sent), `code` (the problem code of a refusal or failure),
 * `role` (the caller's staff role, when they are staff) and `flag` (the key, on flag routes). The
 * reason and ticket are free text, which meta must not hold: they go to `staff_audit_details`.
 *
 * Owns: the action and its meta allowlist.
 */
import { AUDIT_ACTIONS, defineAuditActions } from '@centcom/core';

export const STAFF_ACCESS_ACTION = 'staff.access';

/** B036's catalogue and `staff.access`. */
export const ADMIN_AUDIT_ACTIONS = defineAuditActions({
  ...AUDIT_ACTIONS,
  [STAFF_ACCESS_ACTION]: { meta: ['method', 'route', 'status', 'code', 'role', 'flag'] },
});

/** An action the admin module's emitter accepts. */
export type AdminAuditAction = keyof typeof ADMIN_AUDIT_ACTIONS;
