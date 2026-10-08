/**
 * Usage batch validation (B074, CT-API-USAGE `UsageBatch`): `{events: [...]}` with 1 to 500 events,
 * each `{id, type, qty, at, session_id?, agent_id?}`.
 *
 * - `id`: a `use_` ULID, once per batch.
 * - `type`: one of `agent_minutes`, `tokens_in`, `tokens_out`, `queue_items`, `relay_bytes`.
 * - `qty`: a whole number from 0 to the type's cap (USAGE_QTY_CAPS).
 * - `at`: an RFC 3339 date-time within the last 31 days and at most 60 s ahead of the server clock.
 * - `session_id`, `agent_id`: CT-IDS ids when present.
 *
 * One bad event fails the whole batch with 422, every problem listed with its pointer
 * (`/events/3/qty`): partial acceptance would break client retries. Unknown fields are ignored and
 * never stored.
 *
 * Owns: the rules above. Must not: trust the client's clock beyond the window.
 */
import { isId } from '@centcom/contracts';
import { validationFailed, type FieldError } from '@centcom/core';

/** The usage types. */
export const USAGE_TYPES = Object.freeze([
  'agent_minutes',
  'tokens_in',
  'tokens_out',
  'queue_items',
  'relay_bytes',
] as const);

/** A usage type. */
export type UsageType = (typeof USAGE_TYPES)[number];

/** The largest `qty` of one event, per type. */
export const USAGE_QTY_CAPS: Readonly<Record<UsageType, number>> = Object.freeze({
  agent_minutes: 1440,
  tokens_in: 2_000_000_000,
  tokens_out: 2_000_000_000,
  queue_items: 10_000,
  relay_bytes: 2 ** 40,
});

/** Events in one batch, at most. */
export const MAX_BATCH_EVENTS = 500;
/** Request body, at most (bytes). */
export const MAX_BATCH_BYTES = 1024 * 1024;
/** How far back `at` may be. */
export const MAX_EVENT_AGE_MS = 31 * 24 * 60 * 60 * 1000;
/** How far ahead of the server clock `at` may be. */
export const MAX_EVENT_SKEW_MS = 60 * 1000;

/** A validated usage event. */
export interface UsageEvent {
  id: string;
  type: UsageType;
  qty: number;
  at: Date;
  sessionId: string | null;
  agentId: string | null;
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isUsageType = (value: unknown): value is UsageType =>
  typeof value === 'string' && (USAGE_TYPES as readonly string[]).includes(value);

/** The events of a batch body at `now`; a 422 listing every problem otherwise. */
export function parseUsageBatch(body: unknown, now: Date): UsageEvent[] {
  const issues: FieldError[] = [];
  const fail = (): never => {
    throw validationFailed(issues, 'The usage batch is not valid; nothing was stored.');
  };
  if (!isRecord(body)) {
    issues.push({ pointer: '', code: 'invalid_type', detail: 'must be an object' });
    return fail();
  }
  const events = body['events'];
  if (!Array.isArray(events)) {
    issues.push({ pointer: '/events', code: 'invalid_type', detail: 'must be an array' });
    return fail();
  }
  if (events.length === 0 || events.length > MAX_BATCH_EVENTS) {
    issues.push({
      pointer: '/events',
      code: 'out_of_range',
      detail: `must hold 1 to ${MAX_BATCH_EVENTS} events`,
    });
    return fail();
  }
  const earliest = now.getTime() - MAX_EVENT_AGE_MS;
  const latest = now.getTime() + MAX_EVENT_SKEW_MS;
  const seen = new Set<string>();
  const out: UsageEvent[] = [];
  events.forEach((raw: unknown, i) => {
    const at = `/events/${i}`;
    if (!isRecord(raw)) {
      issues.push({ pointer: at, code: 'invalid_type', detail: 'must be an object' });
      return;
    }
    const before = issues.length;
    const id = raw['id'];
    if (!isId('use', id)) {
      issues.push({ pointer: `${at}/id`, code: 'invalid_format', detail: 'must be a use_ id' });
    } else if (seen.has(id)) {
      issues.push({ pointer: `${at}/id`, code: 'duplicate', detail: 'appears twice in the batch' });
    } else {
      seen.add(id);
    }
    const type = raw['type'];
    if (!isUsageType(type)) {
      issues.push({
        pointer: `${at}/type`,
        code: 'invalid_value',
        detail: `must be one of ${USAGE_TYPES.join(', ')}`,
      });
    }
    const qty = raw['qty'];
    if (typeof qty !== 'number' || !Number.isSafeInteger(qty)) {
      issues.push({ pointer: `${at}/qty`, code: 'invalid_type', detail: 'must be a whole number' });
    } else if (qty < 0 || (isUsageType(type) && qty > USAGE_QTY_CAPS[type])) {
      issues.push({
        pointer: `${at}/qty`,
        code: 'out_of_range',
        detail: isUsageType(type) ? `must be 0 to ${USAGE_QTY_CAPS[type]}` : 'must be 0 or more',
      });
    }
    const when = raw['at'];
    const time = typeof when === 'string' && DATE_TIME.test(when) ? Date.parse(when) : NaN;
    if (Number.isNaN(time)) {
      issues.push({
        pointer: `${at}/at`,
        code: 'invalid_format',
        detail: 'must be an RFC 3339 date-time',
      });
    } else if (time < earliest || time > latest) {
      issues.push({
        pointer: `${at}/at`,
        code: 'out_of_range',
        detail: 'must be within the last 31 days and at most 60 s ahead',
      });
    }
    const session = raw['session_id'];
    if (session !== undefined && session !== null && !isId('ses', session)) {
      issues.push({
        pointer: `${at}/session_id`,
        code: 'invalid_format',
        detail: 'must be a ses_ id',
      });
    }
    const agent = raw['agent_id'];
    if (agent !== undefined && agent !== null && !isId('agt', agent)) {
      issues.push({
        pointer: `${at}/agent_id`,
        code: 'invalid_format',
        detail: 'must be an agt_ id',
      });
    }
    if (issues.length > before) return;
    out.push({
      id: id as string,
      type: type as UsageType,
      qty: qty as number,
      at: new Date(time),
      sessionId: typeof session === 'string' ? session : null,
      agentId: typeof agent === 'string' ? agent : null,
    });
  });
  if (issues.length > 0) fail();
  return out;
}
