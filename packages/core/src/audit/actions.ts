/**
 * The audit action vocabulary (B036, CT-API-AUDIT): every audit event names one of these actions,
 * and each action lists the `meta` keys it may carry. Keys outside the list are dropped before
 * the write, so a call site cannot put content into the audit log by adding a field.
 *
 * Owns: the action names and their meta allowlists. Must not: rename an action (CT-API-AUDIT
 * calls the names stable), or allow a key whose values are content: meta holds ids, enums,
 * counts, flags and times only (no text, paths, branch names, URLs, addresses or secrets).
 */

/** What one action may carry. */
export interface AuditActionRule {
  /** The `meta` keys kept for this action; any other key is dropped. */
  readonly meta: readonly string[];
}

/** Action names to their rules. */
export type AuditCatalog<A extends string = string> = Readonly<Record<A, AuditActionRule>>;

/** `area.verb`, lower-case words with `_`: `member.role_change`, `auth.device_revoked`. */
const ACTION_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
/** Longest action name (the `action` column's CHECK allows 64 characters). */
export const MAX_AUDIT_ACTION_LENGTH = 64;
/** A meta key: a lower-case snake_case word. */
const META_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Checks and freezes a catalogue. Add actions by spreading the built-in one:
 * `defineAuditActions({ ...AUDIT_ACTIONS, 'project.create': { meta: ['plan'] } })`; the emitter
 * created with the result accepts the new names, in its types and at run time.
 *
 * Throws a TypeError for a malformed action name or meta key, or a key listed twice.
 */
export function defineAuditActions<const T extends Record<string, AuditActionRule>>(
  actions: T,
): AuditCatalog<keyof T & string> {
  const out: Record<string, AuditActionRule> = {};
  for (const [name, rule] of Object.entries(actions)) {
    if (!ACTION_NAME.test(name) || name.length > MAX_AUDIT_ACTION_LENGTH) {
      throw new TypeError(`defineAuditActions: "${name}" is not an area.verb action name`);
    }
    const meta = [...(rule.meta as unknown[])];
    for (const key of meta) {
      if (typeof key !== 'string' || !META_KEY.test(key)) {
        throw new TypeError(`defineAuditActions: ${name} lists a meta key that is not snake_case`);
      }
    }
    if (new Set(meta).size !== meta.length) {
      throw new TypeError(`defineAuditActions: ${name} lists a meta key twice`);
    }
    out[name] = Object.freeze({ meta: Object.freeze(meta as string[]) });
  }
  return Object.freeze(out) as AuditCatalog<keyof T & string>;
}

/**
 * CT-API-AUDIT's stable action names, with the meta each may carry. Targets (the `target` of an
 * event) and the workspace are columns of their own, so meta holds only what they do not say:
 *
 * - `*_role`, `role`: workspace or session roles; `user_id`, `session_id`, `owner_user_id`: ids;
 * - `fields`: the names of the fields a change touched, comma-separated (never their values);
 * - `code`, `reason`, `kind`, `via`, `mode`, `plan`, `interval`: enum values;
 * - `*_from`, `*_to` of `workspace.update`: a policy's old and new value (an enum, a flag or a
 *   number of days);
 * - counts (`seats`, `frames`, `blobs`), flags (`self`, `enabled`) and times (`until`).
 */
export const AUDIT_ACTIONS = defineAuditActions({
  'workspace.create': { meta: ['plan'] },
  // A settings change (B034) also names the old and new value of each policy it changed.
  'workspace.update': {
    meta: [
      'fields',
      'auto_approve_from',
      'auto_approve_to',
      'share_history_from',
      'share_history_to',
      'retention_days_from',
      'retention_days_to',
    ],
  },
  'workspace.delete': { meta: [] },
  'member.add': { meta: ['user_id', 'role', 'via'] },
  'member.remove': { meta: ['user_id', 'role', 'self'] },
  'member.role_change': { meta: ['user_id', 'from_role', 'to_role'] },
  'invite.create': { meta: ['role', 'kind'] },
  'invite.accept': { meta: ['user_id', 'role'] },
  'invite.revoke': { meta: [] },
  'session.create': { meta: ['mode'] },
  'session.end': { meta: ['reason'] },
  // CT-WS-CONTROL frames, accepted or refused; the target is the member, the host or the session.
  'control.kick': { meta: ['session_id', 'code'] },
  'control.mute': { meta: ['session_id', 'until'] },
  'control.unmute': { meta: ['session_id'] },
  'control.role': { meta: ['session_id', 'role'] },
  'control.transfer_host': { meta: ['session_id', 'code'] },
  'control.end': { meta: ['session_id', 'code'] },
  'control.policy': { meta: ['session_id', 'fields'] },
  'api_key.create': { meta: ['scopes', 'mode'] },
  'api_key.revoke': { meta: ['reason'] },
  'webhook.create': { meta: ['events', 'enabled'] },
  'webhook.update': { meta: ['fields', 'enabled'] },
  'webhook.delete': { meta: [] },
  'billing.checkout': { meta: ['plan', 'seats', 'interval'] },
  'billing.portal': { meta: ['plan'] },
  'billing.seats': { meta: ['from_seats', 'to_seats'] },
  'billing.coupon': { meta: ['plan'] },
  'auth.device_revoked': { meta: ['reason'] },
  // CT-RBAC rule 6: a refused privileged action (`attempted`, an RBAC action, and why).
  'permission.denied': { meta: ['attempted', 'reason', 'session_id', 'owner_user_id'] },
  'history.purge': { meta: ['frames', 'blobs'] },
});

/** A built-in audit action. */
export type AuditAction = keyof typeof AUDIT_ACTIONS;
