/**
 * Settings request bodies (B034, CT-API-WORKSPACES `WorkspaceSettingsUpdate`): `auto_approve`
 * (`ask`, `trusted` or `everyone`: exactly CT-WS-QUEUE rule 3 / `control.policy`), `share_history`
 * (a boolean) and `history_retention_days` (null, or whole days from 0; the plan's cap is checked
 * by the service). At least one of them; unknown fields are ignored (CT-VER) and never stored. A
 * bad value is a 422 `validation_failed` pointing at the field, without echoing it.
 *
 * Owns: parsing the body. Must not: accept a value outside the contract's enums.
 */
import type { ValidationIssue } from '@centcom/contracts';
import { validationFailed } from '@centcom/core';
import type { AutoApprove } from '@centcom/db';

/** The auto-approve levels (CT-WS-QUEUE rule 3, `control.policy.auto_approve`). */
export const AUTO_APPROVE_LEVELS: readonly AutoApprove[] = Object.freeze([
  'ask',
  'trusted',
  'everyone',
]);

/** The longest retention override the body accepts, in days, before the plan's cap applies. */
export const MAX_RETENTION_DAYS = 36_500;

/** The detail of a 422 on a settings body (GUIDELINES §3.4: one message table). */
export const INVALID_SETTINGS_DETAIL = 'Some settings are not valid.';

/** Workspace settings as the API shows them (CT-API-WORKSPACES `WorkspaceSettings`). */
export interface WorkspaceSettings {
  auto_approve: AutoApprove;
  share_history: boolean;
  history_retention_days: number | null;
}

/** The policies, by their wire names, in the order changes list them. */
export const SETTINGS_KEYS = ['auto_approve', 'share_history', 'history_retention_days'] as const;
/** One policy. */
export type SettingsKey = (typeof SETTINGS_KEYS)[number];

/** A checked `WorkspaceSettingsUpdate`: the policies the body names. */
export type SettingsPatch = Partial<WorkspaceSettings>;

/** Checks a `WorkspaceSettingsUpdate`; pointers are relative to it. Never throws. */
export function checkSettingsPatch(
  body: unknown,
): { value: SettingsPatch; issues?: undefined } | { issues: ValidationIssue[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { issues: [{ pointer: '', code: 'invalid_type', detail: 'must be an object' }] };
  }
  const input = body as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  const patch: SettingsPatch = {};
  const level = input['auto_approve'];
  if (level !== undefined) {
    if (typeof level === 'string' && (AUTO_APPROVE_LEVELS as readonly string[]).includes(level)) {
      patch.auto_approve = level as AutoApprove;
    } else {
      issues.push({
        pointer: '/auto_approve',
        code: 'invalid_value',
        detail: 'must be ask, trusted or everyone',
      });
    }
  }
  const share = input['share_history'];
  if (share !== undefined) {
    if (typeof share === 'boolean') patch.share_history = share;
    else
      issues.push({ pointer: '/share_history', code: 'invalid_type', detail: 'must be a boolean' });
  }
  const days = input['history_retention_days'];
  if (days !== undefined) {
    if (days === null) {
      patch.history_retention_days = null;
    } else if (typeof days !== 'number' || !Number.isInteger(days)) {
      issues.push({
        pointer: '/history_retention_days',
        code: 'invalid_type',
        detail: 'must be a whole number of days or null',
      });
    } else if (days < 0 || days > MAX_RETENTION_DAYS) {
      issues.push({
        pointer: '/history_retention_days',
        code: 'out_of_range',
        detail: `must be between 0 and ${MAX_RETENTION_DAYS}`,
      });
    } else {
      patch.history_retention_days = days;
    }
  }
  if (issues.length > 0) return { issues };
  if (Object.keys(patch).length === 0) {
    return {
      issues: [
        { pointer: '', code: 'too_few', detail: 'must name at least one setting to change' },
      ],
    };
  }
  return { value: patch };
}

/** Checks a `/settings` PATCH body, or throws its 422. */
export function parseSettingsPatch(body: unknown): SettingsPatch {
  const checked = checkSettingsPatch(body);
  if (checked.issues !== undefined) throw validationFailed(checked.issues, INVALID_SETTINGS_DETAIL);
  return checked.value;
}
