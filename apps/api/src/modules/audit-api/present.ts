/**
 * Audit rows as CT-API-AUDIT `AuditEvent`s (B082), for the list and for exports.
 *
 * - `actor`: `user`, `api_key` and `system` as stored (a system actor's id is its service name,
 *   `retention`). The contract has no device actor, so a device's event shows as `user` with the
 *   device's `dev_` id, nor a staff one (B087), shown as `system`.
 * - `result`: `allowed` for a `success`, `denied` for a `denied`; a `failed` event has none.
 * - `metadata`: the event's meta cut to its action's allowlist again (B036's catalogue and
 *   `audit.export`), so a row can only show ids, enums, counts, flags and times. An action outside
 *   the catalogue shows none.
 *
 * Owns: the mapping. Must not: show a field the contract does not define, an IP address, a user
 * agent, an e-mail address or free text (B082 guardrail).
 */
import type { Api } from '@centcom/contracts';
import { sanitizeAuditMeta, type AuditActorType, type AuditOutcome } from '@centcom/core';
import { AUDIT_API_ACTIONS } from './actions.js';

/** The columns of `audit_events` the API reads. */
export interface AuditRow {
  id: string;
  workspace_id: string;
  actor_type: AuditActorType;
  actor_id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome: AuditOutcome;
  meta: unknown;
  created_at: Date;
}

/** The contract's event. */
export type AuditEventBody = Api.AuditEvent;

const ACTOR_TYPES: Readonly<Record<AuditActorType, AuditEventBody['actor']['type']>> = {
  user: 'user',
  api_key: 'api_key',
  system: 'system',
  device: 'user',
  // Centcom staff (B087): not a workspace member, so shown as the system acting.
  staff: 'system',
};

/** The allowlisted meta of `row`, or none when its action is unknown or its meta unreadable. */
function metadataOf(row: AuditRow): Record<string, unknown> {
  if (!Object.hasOwn(AUDIT_API_ACTIONS, row.action)) return {};
  const rule = (AUDIT_API_ACTIONS as Readonly<Record<string, { meta: readonly string[] }>>)[
    row.action
  ];
  if (rule === undefined) return {};
  try {
    return sanitizeAuditMeta(row.meta, rule.meta);
  } catch {
    return {};
  }
}

/** One row as an `AuditEvent`. */
export function presentEvent(row: AuditRow): AuditEventBody {
  const result: AuditEventBody['result'] =
    row.outcome === 'success' ? 'allowed' : row.outcome === 'denied' ? 'denied' : undefined;
  return {
    id: row.id,
    workspace: row.workspace_id,
    at: row.created_at.toISOString(),
    actor: { type: ACTOR_TYPES[row.actor_type], id: row.actor_id },
    action: row.action,
    ...(row.target_type === null || row.target_id === null
      ? {}
      : { target: { type: row.target_type, id: row.target_id } }),
    ...(result === undefined ? {} : { result }),
    metadata: metadataOf(row),
  };
}
