/**
 * Webhook events (B081, CT-WEBHOOKS "Event types"): the types, what each `data` may hold, and
 * `emitWebhookEvent`, which hands an event to the `webhook.events` queue for fan-out to endpoints.
 *
 * - `data` holds ids, enums, counts and names only, per type (WEBHOOK_DATA_FIELDS): never session
 *   content, paths, branch names or keys. An event with any other field, or a value of the wrong
 *   kind, is refused (`webhookDataProblems`), so nothing else can reach a receiver.
 * - Emitting never loses an event: when the queue (Redis) fails, the event goes to the
 *   `webhook_outbox` table, which the worker drains into the queue once Redis is back.
 *
 * Owns: the vocabulary and the emitter. Must not: carry content in an event.
 */
import { randomUUID } from 'node:crypto';

/** The queue events are fanned out from. */
export const WEBHOOK_EVENTS_QUEUE = 'webhook.events';
/** The queue of delivery attempts (one job per attempt). */
export const WEBHOOK_DELIVER_QUEUE = 'webhook.deliver';
/** Where deliveries that failed every attempt are parked for operators. */
export const WEBHOOK_DEAD_QUEUE = 'webhook.dead';
/** The payload's `api_version`. */
export const WEBHOOK_API_VERSION = '2026-10-01';

/** A rule for one `data` field. */
type FieldRule = (value: unknown) => boolean;

const id =
  (...prefixes: string[]): FieldRule =>
  (v) =>
    typeof v === 'string' &&
    prefixes.some((p) => new RegExp(`^${p}_[0-9A-HJKMNP-TV-Z]{26}$`).test(v));
const token: FieldRule = (v) => typeof v === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(v);
const count: FieldRule = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const opaqueId: FieldRule = (v) => typeof v === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(v);
const name: FieldRule = (v) =>
  // eslint-disable-next-line no-control-regex
  typeof v === 'string' && v.length >= 1 && v.length <= 80 && !/[\u0000-\u001f\u007f]/.test(v);
const email: FieldRule = (v) =>
  typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const currency: FieldRule = (v) => typeof v === 'string' && /^[A-Z]{3}$/.test(v);
const scopes: FieldRule = (v) =>
  Array.isArray(v) &&
  v.length <= 20 &&
  v.every((s) => typeof s === 'string' && /^[a-z]+(:[a-z]+)?$/.test(s));

const ROLE = token;

/** Each type's `data` fields and their rules (CT-WEBHOOKS "Event types"; optional ones may be absent). */
export const WEBHOOK_DATA_FIELDS = Object.freeze({
  'workspace.member.joined': { member: id('mem'), user: id('usr'), role: ROLE },
  'workspace.member.left': { member: id('mem'), user: id('usr'), role: ROLE },
  'workspace.member.role_changed': { member: id('mem'), user: id('usr'), role: ROLE },
  'workspace.invite.created': { invite: id('inv'), email, role: ROLE },
  'workspace.invite.accepted': { invite: id('inv'), email, role: ROLE },
  'workspace.invite.revoked': { invite: id('inv'), email, role: ROLE },
  'session.created': { session: id('ses'), host: id('mem', 'usr'), name, state: token },
  'session.started': { session: id('ses'), host: id('mem', 'usr'), name, state: token },
  'session.ended': { session: id('ses'), host: id('mem', 'usr'), name, state: token },
  'session.member.joined': { session: id('ses'), member: id('mem') },
  'session.member.left': { session: id('ses'), member: id('mem') },
  'agent.completed': { session: id('ses'), agent: id('agt'), outcome: token, minutes: count },
  'billing.subscription.updated': { plan: token, status: token, seats: count },
  'billing.invoice.paid': { invoice: opaqueId, amount: count, currency },
  'billing.invoice.payment_failed': { invoice: opaqueId, amount: count, currency },
  'usage.threshold': { limit: token, pct: count },
  'api_key.created': { key: id('key'), scopes },
  'api_key.revoked': { key: id('key'), scopes },
  'webhook.test': { endpoint: id('whk') },
} as const satisfies Record<string, Record<string, FieldRule>>);

/** A webhook event type. */
export type WebhookEventType = keyof typeof WEBHOOK_DATA_FIELDS;

/** Every event type, `webhook.test` included. */
export const WEBHOOK_EVENT_TYPES = Object.freeze(
  Object.keys(WEBHOOK_DATA_FIELDS) as WebhookEventType[],
);

/** The types an endpoint may subscribe to (all but `webhook.test`, which goes to the endpoint tested). */
export const SUBSCRIBABLE_EVENT_TYPES = Object.freeze(
  WEBHOOK_EVENT_TYPES.filter((t) => t !== 'webhook.test'),
);

/** True for a known event type. */
export const isWebhookEventType = (value: unknown): value is WebhookEventType =>
  typeof value === 'string' && Object.hasOwn(WEBHOOK_DATA_FIELDS, value);

/** What is wrong with `data` for `type`: unknown fields and wrong kinds, by field name. */
export function webhookDataProblems(type: WebhookEventType, data: unknown): string[] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return ['data'];
  const rules = WEBHOOK_DATA_FIELDS[type] as Record<string, FieldRule>;
  const problems: string[] = [];
  for (const [field, value] of Object.entries(data)) {
    const rule = Object.hasOwn(rules, field) ? rules[field] : undefined;
    if (rule === undefined || !rule(value)) problems.push(field);
  }
  return problems;
}

/** An event to deliver. */
export interface WebhookEvent {
  /** Unique; fan-out is idempotent by it. */
  id: string;
  type: WebhookEventType;
  workspace: string;
  data: Record<string, unknown>;
  created_at: string;
}

/** What `emitWebhookEvent` takes. */
export interface WebhookEventInput {
  type: WebhookEventType;
  workspace: string;
  data: Record<string, unknown>;
  created_at?: string;
}

/** The `webhook.events` queue (BullMQ's `add`). */
export interface WebhookEventQueue {
  add(name: string, data: WebhookEvent, opts: { jobId: string }): Promise<unknown>;
}

/** The `webhook_outbox` table, for when the queue is down. */
export interface WebhookOutbox {
  write(event: WebhookEvent): Promise<void>;
}

/** What the emitter needs. */
export interface WebhookEmitterDeps {
  queue: WebhookEventQueue;
  outbox?: WebhookOutbox;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  newId?: () => string;
}

/** An event the emitter refuses: its type or `data` is outside CT-WEBHOOKS. */
export class InvalidWebhookEventError extends Error {
  override name = 'InvalidWebhookEventError';
}

/**
 * `emitWebhookEvent(evt)`: checks the event against CT-WEBHOOKS and queues it on `webhook.events`
 * (job id = the event id), or writes it to the outbox when the queue fails. Rejects only when both
 * fail, or for an event outside the contract.
 */
export function createWebhookEventEmitter(
  deps: WebhookEmitterDeps,
): (input: WebhookEventInput) => Promise<WebhookEvent> {
  const clock = deps.clock ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  return async function emitWebhookEvent(input) {
    if (!isWebhookEventType(input.type)) throw new InvalidWebhookEventError('unknown event type');
    if (!/^wsp_[0-9A-HJKMNP-TV-Z]{26}$/.test(input.workspace)) {
      throw new InvalidWebhookEventError('workspace must be a wsp_ id');
    }
    const problems = webhookDataProblems(input.type, input.data);
    if (problems.length > 0) {
      throw new InvalidWebhookEventError(`data fields not allowed: ${problems.join(', ')}`);
    }
    const event: WebhookEvent = {
      id: newId(),
      type: input.type,
      workspace: input.workspace,
      data: { ...input.data },
      created_at: input.created_at ?? new Date(clock()).toISOString(),
    };
    try {
      await deps.queue.add('event', event, { jobId: event.id });
    } catch (err) {
      if (deps.outbox === undefined) throw err;
      await deps.outbox.write(event);
    }
    return event;
  };
}
