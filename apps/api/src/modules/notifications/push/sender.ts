/**
 * Push sending (B064): `PushSender` is the dispatcher's `PushSenderPort` (B063); it queues one
 * `notify.push` job per notification and user. `PushDelivery.process` is what the worker job
 * runs: it opens the user's subscriptions and sends the payload to each through its provider.
 *
 * - The payload is the CT-NOTIF-PAYLOAD object and nothing else: its fields only, `params` cut to
 *   the category's allow-list (B063 `PARAM_RULES`), at most PUSH_PAYLOAD_BUDGET bytes before the
 *   provider wraps or encrypts it (dropping `params`, then `action`, when it is larger), so no
 *   request body exceeds 3 KiB.
 * - A transient failure (timeout, 429, 5xx) is retried 3 times with full-jitter exponential
 *   backoff (base 1 s, cap 30 s), then counted on the subscription (the fifth in a row within
 *   24 h deletes it). Gone (404/410, Unregistered, UNREGISTERED) deletes it at once. A permanent
 *   failure (bad credentials, 4xx) is not the subscription's fault and is not counted.
 * - Each provider has a semaphore (PUSH_CONCURRENCY_PER_PROVIDER sends in flight) and a circuit
 *   breaker (10 failed sends in a row open it for 60 s). While it is open, deliveries through that
 *   provider are deferred: the job re-queues them, delayed, rather than dropping them.
 * - A provider that is not configured skips its subscriptions (they are kept).
 *
 * Owns: the payload and the delivery rules. Must not: send display text, or log an endpoint,
 * token, key or payload (logs carry subscription ids and providers).
 */
import {
  NOTIFY_PUSH_QUEUE,
  noopMetrics,
  notifyPushJobOptions,
  type Logger,
  type Metrics,
  type NotificationCategory,
  type NotifyPushJobData,
} from '@centcom/core';
import { PARAM_RULES } from '../dispatcher/params.js';
import type { NotificationPayload, PushSenderPort } from '../dispatcher/ports.js';
import {
  CircuitBreaker,
  PUSH_KINDS,
  Semaphore,
  type PushKind,
  type PushProvider,
  type PushTarget,
} from './providers.js';
import type { PushRegistry } from './registry.js';

/** No request body sent to a push service exceeds this. */
export const PUSH_BODY_MAX_BYTES = 3072;
/** The payload's budget before the provider wraps (APNs, FCM) or encrypts (web push) it. */
export const PUSH_PAYLOAD_BUDGET = 2816;
/** Retries of a transient failure. */
export const PUSH_RETRIES = 3;
export const PUSH_BACKOFF_BASE_MS = 1_000;
export const PUSH_BACKOFF_CAP_MS = 30_000;

/** Categories pushed at high priority. */
const URGENT: ReadonlySet<string> = new Set(['approval_needed', 'security_alert', 'billing_issue']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Longest string field kept (ids, keys and param values are far shorter). */
const MAX_FIELD = 256;
/** Longest deeplink kept. */
const MAX_DEEPLINK = 1024;
const capped = (value: unknown, max = MAX_FIELD): string => String(value).slice(0, max);

/**
 * The CT-NOTIF-PAYLOAD fields of `payload`, params cut to the category's allow-list, as JSON of at
 * most PUSH_PAYLOAD_BUDGET bytes (string fields are capped, so the smallest form always fits).
 */
export function pushPayload(payload: Record<string, unknown>): Uint8Array {
  const category = capped(payload['category'], 64);
  const rules =
    (PARAM_RULES as Record<string, Readonly<Record<string, unknown>> | undefined>)[category] ?? {};
  const params = isRecord(payload['params']) ? payload['params'] : {};
  const allowed: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (Object.hasOwn(rules, key) && (typeof value === 'string' || typeof value === 'number')) {
      allowed[key] = typeof value === 'string' ? capped(value) : value;
    }
  }
  const action = isRecord(payload['action'])
    ? {
        type: capped(payload['action']['type'], 64),
        ...(typeof payload['action']['deeplink'] === 'string'
          ? { deeplink: capped(payload['action']['deeplink'], MAX_DEEPLINK) }
          : {}),
      }
    : undefined;
  const base = {
    id: capped(payload['id'], 64),
    created_at: capped(payload['created_at'], 64),
    read_at: typeof payload['read_at'] === 'string' ? capped(payload['read_at'], 64) : null,
    category,
    title_key: capped(payload['title_key']),
    body_key: capped(payload['body_key']),
    priority: capped(payload['priority'], 16),
  };
  for (const candidate of [
    { ...base, params: allowed, ...(action === undefined ? {} : { action }) },
    { ...base, params: {}, ...(action === undefined ? {} : { action }) },
    { ...base, params: {} },
  ]) {
    const bytes = Buffer.from(JSON.stringify(candidate), 'utf8');
    if (bytes.length <= PUSH_PAYLOAD_BUDGET) return bytes;
  }
  // Unreachable with the caps above (the smallest form is under 1 KiB); kept as a hard stop.
  return Buffer.from(JSON.stringify({ id: base.id, category, priority: base.priority }), 'utf8');
}

/** The `notify.push` queue as the sender uses it. */
export interface PushQueue {
  add(
    name: string,
    data: NotifyPushJobData,
    opts: ReturnType<typeof notifyPushJobOptions> & { jobId: string },
  ): Promise<unknown>;
}

/** B063's `PushSenderPort`: one job per notification and user. */
export class PushSender implements PushSenderPort {
  constructor(private readonly queue: PushQueue) {}

  async enqueue(userId: string, payload: NotificationPayload): Promise<void> {
    await this.queue.add(
      NOTIFY_PUSH_QUEUE,
      { userId, payload: { ...payload } },
      { ...notifyPushJobOptions(), jobId: `push-${payload.id}-${userId}` },
    );
  }
}

/** What one delivery came to. */
export interface DeliveryReport {
  sent: number;
  gone: number;
  failed: number;
  /** Subscriptions whose provider is not configured. */
  skipped: number;
  /** Deliveries to re-queue once their provider's circuit closes. */
  deferred?: { subscriptionIds: string[]; delayMs: number };
}

/** Dependencies of the delivery. */
export interface PushDeliveryDeps {
  registry: Pick<PushRegistry, 'targets' | 'recordSuccess' | 'recordFailure' | 'delete'>;
  providers: Partial<Record<PushKind, PushProvider>>;
  /** PUSH_CONCURRENCY_PER_PROVIDER. */
  concurrency: number;
  logger?: Logger;
  metrics?: Metrics;
  /** Milliseconds since the epoch; default Date.now. */
  clock?: () => number;
  /** Waits between retries; default a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** [0, 1); default Math.random. */
  random?: () => number;
}

type Result = 'sent' | 'gone' | 'failed' | 'skipped' | 'deferred';

const timer = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Delivers pushes. */
export class PushDelivery {
  readonly semaphores: Readonly<Record<PushKind, Semaphore>>;
  readonly breakers: Readonly<Record<PushKind, CircuitBreaker>>;
  readonly #clock: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #metrics: Metrics;

  constructor(private readonly deps: PushDeliveryDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#sleep = deps.sleep ?? timer;
    this.#random = deps.random ?? Math.random;
    this.#metrics = deps.metrics ?? noopMetrics;
    const by = <T>(make: () => T) =>
      Object.fromEntries(PUSH_KINDS.map((kind) => [kind, make()])) as Record<PushKind, T>;
    this.semaphores = by(() => new Semaphore(deps.concurrency));
    this.breakers = by(() => new CircuitBreaker(this.#clock));
  }

  /** The wait before retry `attempt` (0-based): full jitter over min(30 s, 1 s × 2^attempt). */
  backoff(attempt: number): number {
    return Math.floor(
      this.#random() * Math.min(PUSH_BACKOFF_CAP_MS, PUSH_BACKOFF_BASE_MS * 2 ** attempt),
    );
  }

  /** Sends one push job's notification to the user's subscriptions. */
  async process(data: NotifyPushJobData): Promise<DeliveryReport> {
    const payload = pushPayload(data.payload);
    const urgent =
      data.payload['priority'] === 'high' ||
      URGENT.has(String(data.payload['category'] as NotificationCategory));
    const targets = await this.deps.registry.targets(data.userId, data.subscriptionIds);
    const results = await Promise.all(
      targets.map(async (target) => ({
        target,
        result: await this.#deliver(target, payload, urgent),
      })),
    );
    const report: DeliveryReport = { sent: 0, gone: 0, failed: 0, skipped: 0 };
    const deferred: string[] = [];
    let delayMs = 0;
    for (const { target, result } of results) {
      if (result === 'deferred') {
        deferred.push(target.id);
        delayMs = Math.max(delayMs, this.breakers[target.kind].openFor());
      } else {
        report[result] += 1;
      }
    }
    if (deferred.length > 0)
      report.deferred = { subscriptionIds: deferred, delayMs: Math.max(delayMs, 1_000) };
    return report;
  }

  async #deliver(target: PushTarget, payload: Uint8Array, urgent: boolean): Promise<Result> {
    const provider = this.deps.providers[target.kind];
    if (provider === undefined) return 'skipped';
    const breaker = this.breakers[target.kind];
    for (let attempt = 0; ; attempt += 1) {
      if (breaker.openFor() > 0) return 'deferred';
      const outcome = await this.semaphores[target.kind].run(() =>
        provider.send(target, payload, { urgent }),
      );
      this.#metrics
        .counter('push_sends_total', { provider: target.kind, result: outcome.result })
        .inc();
      if (outcome.result === 'retry') {
        breaker.failure();
        if (attempt < PUSH_RETRIES) {
          await this.#sleep(this.backoff(attempt));
          continue;
        }
        const deleted = await this.deps.registry.recordFailure(target.id, new Date(this.#clock()));
        this.deps.logger?.warn(
          { subscription_id: target.id, provider: target.kind, deleted },
          'push.send_failed',
        );
        return deleted ? 'gone' : 'failed';
      }
      breaker.success();
      if (outcome.result === 'sent') {
        await this.deps.registry.recordSuccess(target.id);
        return 'sent';
      }
      if (outcome.result === 'gone') {
        await this.deps.registry.delete(target.id);
        this.deps.logger?.info(
          { subscription_id: target.id, provider: target.kind },
          'push.subscription_gone',
        );
        return 'gone';
      }
      this.deps.logger?.warn(
        { subscription_id: target.id, provider: target.kind, status: outcome.status ?? null },
        'push.send_refused',
      );
      return 'failed';
    }
  }
}
