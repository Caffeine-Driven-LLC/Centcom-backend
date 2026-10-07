/**
 * Audit events (B036): the shape callers hand the emitter, and the checks that turn one into a
 * row of `audit_events`.
 *
 * - The action must be in the emitter's catalogue (InvalidAuditActionError otherwise), and ids
 *   must be CT-IDS ids of the right kind: `wsp_` workspaces, `usr_`/`key_`/`dev_` actors (or a
 *   service name for `system`), any entity id as the target, a `req_` request id.
 * - `meta` keeps only the action's allowlisted keys. Values are strings, finite numbers, booleans
 *   or null; a string over 200 characters, or meta over 2 KiB serialised, is refused. A string
 *   that looks like a secret or personal data (an API key, a JWT, a `sha256:` digest, an e-mail
 *   or IP address) is stored as `[redacted]`.
 *
 * Owns: what may be stored. Must not: put a value into an error message (they name fields only),
 * or read any meta key that is not allowlisted.
 */
import { isId, parseId } from '@centcom/contracts';
import { REDACTED } from '../config/secret.js';
import { MAX_AUDIT_ACTION_LENGTH, type AuditAction, type AuditCatalog } from './actions.js';
import type { NewAuditRow } from './table.js';

/** Who acted: a user, an API key, a device, or the system (a service, by name). */
export type AuditActorType = 'user' | 'api_key' | 'system' | 'device';
/** How it ended: done, refused by policy, or failed. */
export type AuditOutcome = 'success' | 'denied' | 'failed';
/** A meta value: ids and enums (strings), counts, flags, or null. */
export type AuditMetaValue = string | number | boolean | null;

/** The actor of an event. */
export interface AuditActor {
  type: AuditActorType;
  /** A `usr_`, `key_` or `dev_` id; for `system`, the service's name (`relay`, `retention`). */
  id: string;
}

/** What an event acted on: an entity type and its CT-IDS id. */
export interface AuditTarget {
  /** snake_case: `membership`, `session`, `api_key`. */
  type: string;
  id: string;
}

/** One audit event, as callers describe it. */
export interface AuditEvent<A extends string = AuditAction> {
  /** The workspace acted in (`wsp_`); null for events outside any workspace. */
  workspaceId: string | null;
  actor: AuditActor;
  action: A;
  target?: AuditTarget;
  outcome: AuditOutcome;
  /** The `req_` id of the request the event comes from. */
  requestId?: string;
  /** Ids, enums, counts and flags; only the action's allowlisted keys are kept (AUDIT_ACTIONS). */
  meta?: Record<string, AuditMetaValue>;
}

/** Largest meta, in bytes of compact JSON. */
export const AUDIT_META_MAX_BYTES = 2048;
/** Longest meta string, in characters (code points). */
export const AUDIT_META_MAX_STRING = 200;

/** An event the emitter refuses to write; the message names the field, never its value. */
export class InvalidAuditEventError extends Error {
  override name = 'InvalidAuditEventError';
}

/** An action that is not in the emitter's catalogue (a caller outside the type system). */
export class InvalidAuditActionError extends InvalidAuditEventError {
  override name = 'InvalidAuditActionError';
}

const ACTOR_TYPES: ReadonlySet<string> = new Set(['user', 'api_key', 'system', 'device']);
const OUTCOMES: ReadonlySet<string> = new Set(['success', 'denied', 'failed']);
/** The id prefix of each actor type that has one. */
const ACTOR_PREFIX = { user: 'usr', api_key: 'key', device: 'dev' } as const;
/** A service acting on its own: `relay`, `retention`, `billing-webhooks`. */
const SYSTEM_ACTOR = /^[a-z][a-z0-9_.-]{0,39}$/;
const TARGET_TYPE = /^[a-z][a-z0-9_]{0,31}$/;
/** The shape of an action name, to say which one was unknown without echoing arbitrary input. */
const ACTION_SHAPE = /^[a-z][a-z0-9_.]*$/;

/**
 * Values that must never be stored, wherever they appear in a string: CT-AUTH API keys, JWS/JWE
 * tokens (a base64url JSON header, `eyJ…`, then a dot), CT-IDS `sha256:` digests, e-mail
 * addresses, and IPv4 and IPv6 addresses (GUIDELINES §5.3: audit rows hold ids, not people's
 * addresses). Strings are at most 200 characters here, so these scans stay short.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /cen_(?:live|test)_/i,
  /eyJ[A-Za-z0-9_-]*\./,
  /sha256:/i,
  /[^\s@]@[^\s@]+\.[^\s@]/,
  /(?:^|[^0-9.])(?:\d{1,3}\.){3}\d{1,3}(?![0-9])/,
  // IPv6: eight groups (or six and an IPv4 address), or any `::` abbreviation.
  /(?:^|[^0-9A-Za-z])(?:[0-9A-Fa-f]{1,4}:){4,7}[0-9A-Fa-f]{1,4}(?![0-9A-Za-z])/,
  /::/,
];

/** True when a meta string must be stored as `[redacted]`. */
export const isSecretLike = (value: string): boolean => SECRET_PATTERNS.some((p) => p.test(value));

const fail = (message: string): never => {
  throw new InvalidAuditEventError(message);
};

/** True when `s` has more than `max` code points (a code point is one or two code units). */
function longerThan(s: string, max: number): boolean {
  if (s.length <= max) return false;
  return s.length > 2 * max || Array.from(s).length > max;
}

function metaValue(key: string, value: unknown): AuditMetaValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fail(`meta.${key} must be a finite number`);
  }
  if (typeof value === 'string') {
    if (longerThan(value, AUDIT_META_MAX_STRING)) {
      fail(`meta.${key} is longer than ${AUDIT_META_MAX_STRING} characters`);
    }
    return isSecretLike(value) ? REDACTED : value;
  }
  return fail(`meta.${key} must be a string, number, boolean or null`);
}

/**
 * The meta to store: the keys of `allowed` that `meta` has (others are dropped unread), in the
 * allowlist's order, with secret-like strings redacted. Throws InvalidAuditEventError for a value
 * of the wrong type, a string over 200 characters, or a result over 2 KiB.
 */
export function sanitizeAuditMeta(
  meta: unknown,
  allowed: readonly string[],
): Record<string, AuditMetaValue> {
  const out: Record<string, AuditMetaValue> = {};
  if (meta === undefined || meta === null) return out;
  const proto: unknown = typeof meta === 'object' ? Object.getPrototypeOf(meta) : undefined;
  if (Array.isArray(meta) || (proto !== Object.prototype && proto !== null)) {
    return fail('meta must be a plain object');
  }
  const record = meta as Record<string, unknown>;
  for (const key of allowed) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (value !== undefined) out[key] = metaValue(key, value);
  }
  const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
  if (bytes > AUDIT_META_MAX_BYTES) {
    fail(`meta is ${bytes} bytes serialised; at most ${AUDIT_META_MAX_BYTES} are allowed`);
  }
  return out;
}

function checkActor(actor: unknown): AuditActor {
  if (typeof actor !== 'object' || actor === null) return fail('actor is required');
  const { type, id } = actor as { type?: unknown; id?: unknown };
  if (typeof type !== 'string' || !ACTOR_TYPES.has(type)) {
    return fail('actor.type must be user, api_key, system or device');
  }
  const kind = type as AuditActorType;
  const ok =
    kind === 'system'
      ? typeof id === 'string' && SYSTEM_ACTOR.test(id)
      : isId(ACTOR_PREFIX[kind], id);
  return ok
    ? { type: kind, id: id as string }
    : fail(
        kind === 'system'
          ? 'actor.id of a system actor must be a service name'
          : `actor.id must be a ${ACTOR_PREFIX[kind]}_ id`,
      );
}

function checkTarget(target: unknown): AuditTarget | undefined {
  if (target === undefined) return undefined;
  if (typeof target !== 'object' || target === null) return fail('target must be {type, id}');
  const { type, id } = target as { type?: unknown; id?: unknown };
  if (typeof type !== 'string' || !TARGET_TYPE.test(type)) {
    return fail('target.type must be a snake_case entity name');
  }
  return parseId(id) === null ? fail('target.id must be a CT-IDS id') : { type, id: id as string };
}

/**
 * Checks `event` against `actions` and returns its row, with the given id and time. Throws
 * InvalidAuditActionError for an action outside the catalogue and InvalidAuditEventError for any
 * other problem; never reads a meta key the action does not allow.
 */
export function toAuditRow<A extends string>(
  event: AuditEvent<A>,
  actions: AuditCatalog<A>,
  id: string,
  at: Date,
): NewAuditRow {
  if (typeof event !== 'object' || event === null) return fail('an audit event must be an object');
  const e = event as Partial<Record<keyof AuditEvent, unknown>>;
  const action = e.action;
  if (typeof action !== 'string' || !Object.hasOwn(actions, action)) {
    const named =
      typeof action === 'string' &&
      action.length <= MAX_AUDIT_ACTION_LENGTH &&
      ACTION_SHAPE.test(action);
    throw new InvalidAuditActionError(
      named ? `unknown audit action "${action}"` : 'action is not an audit action',
    );
  }
  const workspaceId = e.workspaceId;
  if (workspaceId !== null && !isId('wsp', workspaceId)) {
    fail('workspaceId must be a wsp_ id, or null for events outside a workspace');
  }
  const actor = checkActor(e.actor);
  const target = checkTarget(e.target);
  if (typeof e.outcome !== 'string' || !OUTCOMES.has(e.outcome)) {
    fail('outcome must be success, denied or failed');
  }
  if (e.requestId !== undefined && !isId('req', e.requestId)) fail('requestId must be a req_ id');
  const rule = actions[action as A];
  return {
    id,
    workspace_id: workspaceId as string | null,
    actor_type: actor.type,
    actor_id: actor.id,
    action,
    target_type: target?.type ?? null,
    target_id: target?.id ?? null,
    outcome: e.outcome as AuditOutcome,
    request_id: (e.requestId as string | undefined) ?? null,
    meta: JSON.stringify(sanitizeAuditMeta(e.meta, rule.meta)),
    created_at: at,
  };
}
