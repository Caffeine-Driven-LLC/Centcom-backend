/**
 * Outgoing webhooks (B081, CT-API-WEBHOOKS, CT-WEBHOOKS).
 *
 * **Endpoints.**
 * - `create` checks the URL (destination.ts) and the events (1 to 32 contract types, or `*`), and
 *   refuses the endpoint past `webhooks_max` (403 `entitlement_required`). It answers the signing
 *   secret once.
 * - `update` changes url, events and enabled. Re-enabling clears a disabled or failing state.
 *   `rotate_secret` answers a new secret and keeps the old one signing for 24 h.
 * - Secrets are sealed with WEBHOOK_SECRET_KEY, bound to the endpoint id, and never shown again.
 *
 * **Fan-out.** `fanOut(event)` stores the event and one pending delivery per enabled endpoint
 * subscribed to it, once per event id, and queues each delivery's first attempt.
 *
 * **Attempts.** `attempt(delivery, n)` is one try.
 * - The body is the same on every try: `id` is the delivery's, as is `Centcom-Event-Id`;
 *   `Centcom-Delivery-Attempt` is n. It is signed with every live secret.
 * - The destination is resolved and checked again; a private address is `blocked_destination`.
 * - A 2xx ends the delivery `delivered`. Anything else (non-2xx, 301/302, timeout, connection,
 *   blocked) schedules the next try after 1 m, 5 m, 30 m, 2 h, 6 h, 12 h, 24 h (±10 %), and the
 *   7th retry's failure ends it `failed`.
 * - A failure dates the endpoint's failure run (a final one marks it `failing`). After 3 days of
 *   failures without a success, the endpoint is disabled, and the owners' e-mail and the audit
 *   event go out once.
 * - A sealed secret that cannot be opened pauses the delivery (nothing unsigned is sent), counted
 *   in `webhook_secret_unavailable_total`.
 * - Each endpoint has at most 5 attempts in flight, each workspace 20.
 *
 * **Manual sends.** `test` sends a `webhook.test` event once and answers the result.
 * `redeliver` re-opens a delivery and queues an attempt now.
 *
 * Owns: these rules. Must not: log or return a secret, a signature, or a request or response body.
 */
import { randomBytes } from 'node:crypto';
import { newId, type Api } from '@centcom/contracts';
import {
  AppError,
  noopMetrics,
  notFound,
  openBody,
  sealBody,
  signPayload,
  SUBSCRIBABLE_EVENT_TYPES,
  validationFailed,
  WEBHOOK_API_VERSION,
  type FieldError,
  type Logger,
  type Metrics,
  type Page,
  type PageParams,
  type WebhookEvent,
} from '@centcom/core';
import type { SealedColumn } from '@centcom/db';
import type { RequestCtx } from '../workspaces/service.js';
import type { WebhookConfig } from './config.js';
import {
  BlockedDestinationError,
  dnsResolver,
  resolveDestination,
  urlProblem,
  type HostResolver,
} from './destination.js';
import { httpSender, type AttemptOutcome, type WebhookSender } from './http.js';
import type { DeliveryRecord, EndpointRecord, WebhookRepository } from './repository.js';

/** The delays before retries 1 to 7. */
export const RETRY_SCHEDULE_MS = Object.freeze([
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
]);
/** Tries per delivery: the first and 7 retries. */
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1;
/** Retry delays vary by up to this fraction either way. */
export const RETRY_JITTER = 0.1;
/** A rotated-out secret keeps signing this long. */
export const SECRET_OVERLAP_MS = 24 * 60 * 60_000;
/** An endpoint failing this long without a success is disabled. */
export const DISABLE_AFTER_MS = 3 * 24 * 60 * 60_000;
/** Events per endpoint, at most. */
export const MAX_ENDPOINT_EVENTS = 32;
/** Attempts in flight per endpoint and per workspace. */
export const ENDPOINT_CONCURRENCY = 5;
export const WORKSPACE_CONCURRENCY = 20;
/** How long a delivery waits when its secret cannot be opened. */
export const SECRET_RETRY_MS = 60_000;

/** The details of refusals (GUIDELINES §3.4). */
export const WEBHOOK_DETAILS = Object.freeze({
  notFound: 'There is no such webhook.',
  deliveryNotFound: 'There is no such delivery.',
  limit: "The workspace's plan allows no more webhook endpoints.",
  invalid: 'Some webhook fields are not valid.',
} as const);

/** The `webhook.deliver` queue: one job per attempt. */
export interface DeliverQueue {
  add(
    name: string,
    data: { deliveryId: string; attempt: number },
    opts: { jobId: string; delay: number },
  ): Promise<unknown>;
}

/** Tells the workspace's owners an endpoint was disabled (e-mail). */
export interface DisabledNotifier {
  endpointDisabled(workspaceId: string, endpointId: string): Promise<void>;
}

/** Writes audit events outside a request (B036's emitter, detached). */
export interface SystemAudit {
  emitDetached(event: {
    workspaceId: string;
    actor: { type: 'system'; id: string };
    action: 'webhook.update';
    target: { type: 'webhook'; id: string };
    outcome: 'success';
    meta: { fields: string; enabled: boolean };
  }): void;
}

/** What a try decided. */
export interface AttemptResult {
  /** Nothing done: no such delivery, or this try was already made. */
  skipped?: true;
  /** The next try and its delay, if any. */
  next: { attempt: number; delayMs: number } | null;
  /** How the delivery ended, if it did. */
  final: 'delivered' | 'failed' | null;
}

/** Bounds concurrent work per key. */
export class KeyedLimiter {
  readonly #active = new Map<string, number>();
  readonly #waiting = new Map<string, (() => void)[]>();

  constructor(private readonly max: number) {}

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    while ((this.#active.get(key) ?? 0) >= this.max) {
      await new Promise<void>((resolve) => {
        const queue = this.#waiting.get(key) ?? [];
        queue.push(resolve);
        this.#waiting.set(key, queue);
      });
    }
    this.#active.set(key, (this.#active.get(key) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const left = (this.#active.get(key) ?? 1) - 1;
      if (left === 0) this.#active.delete(key);
      else this.#active.set(key, left);
      const next = this.#waiting.get(key)?.shift();
      if (this.#waiting.get(key)?.length === 0) this.#waiting.delete(key);
      next?.();
    }
  }

  /** Attempts in flight under `key`. */
  active(key: string): number {
    return this.#active.get(key) ?? 0;
  }
}

/** What the service needs. */
export interface WebhookServiceDeps {
  repository: WebhookRepository;
  config: WebhookConfig;
  queue: DeliverQueue;
  /** B080's `webhooks_max`; without it, no limit. */
  limits?: { get(workspaceId: string): Promise<{ limits: { webhooks_max: number | null } }> };
  resolve?: HostResolver;
  sender?: WebhookSender;
  notifier?: DisabledNotifier;
  audit?: SystemAudit;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** [0, 1); default Math.random. */
  random?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A new signing secret: `whsec_` and 32 random bytes. */
const newSecret = (): string => `whsec_${randomBytes(32).toString('base64url')}`;

/** Outgoing webhooks. */
export class WebhookService {
  readonly #clock: () => number;
  readonly #random: () => number;
  readonly #metrics: Metrics;
  readonly #resolve: HostResolver;
  readonly #send: WebhookSender;
  readonly #perEndpoint = new KeyedLimiter(ENDPOINT_CONCURRENCY);
  readonly #perWorkspace = new KeyedLimiter(WORKSPACE_CONCURRENCY);

  constructor(private readonly deps: WebhookServiceDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#random = deps.random ?? Math.random;
    this.#metrics = deps.metrics ?? noopMetrics;
    this.#resolve = deps.resolve ?? dnsResolver;
    this.#send = deps.sender ?? httpSender;
  }

  /** Attempts in flight for an endpoint and a workspace (for tests and metrics). */
  inFlight(endpointId: string, workspaceId: string): { endpoint: number; workspace: number } {
    return {
      endpoint: this.#perEndpoint.active(endpointId),
      workspace: this.#perWorkspace.active(workspaceId),
    };
  }

  #seal(endpointId: string, secret: string): SealedColumn {
    return sealBody(
      this.deps.config.secretKey,
      Buffer.from(secret, 'utf8'),
      `${endpointId}:secret`,
    );
  }

  #open(endpointId: string, sealed: SealedColumn): string {
    return openBody(this.deps.config.secretKey, sealed, `${endpointId}:secret`).toString('utf8');
  }

  /** The contract's view of an endpoint: never a secret. */
  view(e: EndpointRecord): Api.Webhook {
    const now = this.#clock();
    const overlap =
      e.prevSecretExpiresAt !== null && e.prevSecretExpiresAt.getTime() > now
        ? e.prevSecretExpiresAt
        : null;
    return {
      id: e.id,
      workspace: e.workspaceId,
      url: e.url,
      events: e.events as Api.WebhookEventType[],
      enabled: e.enabled,
      status: e.status,
      created_at: e.createdAt.toISOString(),
      secret_rotated_at: e.secretRotatedAt?.toISOString() ?? null,
      secret_overlap_until: overlap?.toISOString() ?? null,
    };
  }

  /** The contract's view of a delivery (`delivered` is the contract's `succeeded`). */
  deliveryView(d: DeliveryRecord): Api.WebhookDelivery {
    return {
      id: d.id,
      webhook: d.endpointId,
      event_type: d.eventType as Api.WebhookEventType,
      attempt: d.attempt,
      status: d.status === 'delivered' ? 'succeeded' : d.status,
      response_status: d.httpStatus,
      duration_ms: d.durationMs,
      created_at: d.createdAt.toISOString(),
      next_attempt_at: d.nextAttemptAt?.toISOString() ?? null,
    };
  }

  async #checkUrl(url: unknown, issues: FieldError[]): Promise<string | undefined> {
    if (typeof url !== 'string') {
      issues.push({ pointer: '/url', code: 'invalid_type', detail: 'must be a string' });
      return undefined;
    }
    const problem = await urlProblem(url, this.#resolve, this.deps.config.allowLoopback);
    if (problem !== null) {
      throw new AppError('webhook_url_invalid', {
        detail: `The webhook URL ${problem}.`,
        errors: [{ pointer: '/url', code: 'invalid_value', detail: problem }],
      });
    }
    return url;
  }

  #checkEvents(events: unknown, issues: FieldError[]): string[] | undefined {
    if (!Array.isArray(events) || events.length === 0 || events.length > MAX_ENDPOINT_EVENTS) {
      issues.push({
        pointer: '/events',
        code: 'out_of_range',
        detail: `must list 1 to ${MAX_ENDPOINT_EVENTS} events`,
      });
      return undefined;
    }
    const out: string[] = [];
    events.forEach((e: unknown, i) => {
      if (e !== '*' && !(SUBSCRIBABLE_EVENT_TYPES as readonly unknown[]).includes(e)) {
        issues.push({
          pointer: `/events/${i}`,
          code: 'invalid_value',
          detail: 'is not a webhook event type',
        });
      } else if (out.includes(e as string)) {
        issues.push({ pointer: `/events/${i}`, code: 'duplicate', detail: 'appears twice' });
      } else {
        out.push(e as string);
      }
    });
    return out;
  }

  /** Creates an endpoint; answers it with its secret, shown this once. */
  async create(
    workspaceId: string,
    body: unknown,
    ctx: RequestCtx,
  ): Promise<Api.Webhook & { secret: string }> {
    if (!isRecord(body))
      throw validationFailed([{ pointer: '', code: 'invalid_type', detail: 'must be an object' }]);
    const issues: FieldError[] = [];
    const events = this.#checkEvents(body['events'], issues);
    if (issues.length > 0) throw validationFailed(issues, WEBHOOK_DETAILS.invalid);
    const url = await this.#checkUrl(body['url'], issues);
    if (issues.length > 0 || url === undefined || events === undefined) {
      throw validationFailed(issues, WEBHOOK_DETAILS.invalid);
    }
    const limit =
      this.deps.limits === undefined
        ? null
        : (await this.deps.limits.get(workspaceId)).limits.webhooks_max;
    const id = newId('whk');
    const secret = newSecret();
    const created = await this.deps.repository.createEndpoint(
      { id, workspaceId, url, events, secretEnc: this.#seal(id, secret) },
      limit,
      (trx) =>
        ctx.audit(trx, {
          action: 'webhook.create',
          workspaceId,
          target: { type: 'webhook', id },
          meta: { events: events.join(' '), enabled: true },
        }),
    );
    if (created === 'limit')
      throw new AppError('entitlement_required', { detail: WEBHOOK_DETAILS.limit });
    return { ...this.view(created), secret };
  }

  /** The workspace's endpoints, newest first. */
  async list(workspaceId: string, page: PageParams): Promise<Page<Api.Webhook>> {
    const result = await this.deps.repository.listEndpoints(workspaceId, page);
    return { ...result, data: result.data.map((e) => this.view(e)) };
  }

  /** An endpoint, or 404. */
  async find(id: unknown): Promise<EndpointRecord> {
    const found =
      typeof id === 'string' && /^whk_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)
        ? await this.deps.repository.findEndpoint(id)
        : null;
    if (found === null) throw notFound(WEBHOOK_DETAILS.notFound);
    return found;
  }

  /** Changes an endpoint; answers it, with the new secret when rotated. */
  async update(
    endpoint: EndpointRecord,
    body: unknown,
    ctx: RequestCtx,
  ): Promise<Api.Webhook & { secret?: string }> {
    if (!isRecord(body) || Object.keys(body).length === 0) {
      throw validationFailed([
        { pointer: '', code: 'invalid_type', detail: 'must be an object with a field to change' },
      ]);
    }
    const issues: FieldError[] = [];
    const events =
      body['events'] === undefined ? undefined : this.#checkEvents(body['events'], issues);
    const enabled = body['enabled'];
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      issues.push({ pointer: '/enabled', code: 'invalid_type', detail: 'must be a boolean' });
    }
    const rotate = body['rotate_secret'];
    if (rotate !== undefined && typeof rotate !== 'boolean') {
      issues.push({ pointer: '/rotate_secret', code: 'invalid_type', detail: 'must be a boolean' });
    }
    if (issues.length > 0) throw validationFailed(issues, WEBHOOK_DETAILS.invalid);
    const url = body['url'] === undefined ? undefined : await this.#checkUrl(body['url'], issues);
    if (issues.length > 0) throw validationFailed(issues, WEBHOOK_DETAILS.invalid);
    const now = new Date(this.#clock());
    let secret: string | undefined;
    let rotation: Parameters<WebhookRepository['updateEndpoint']>[1]['rotation'];
    if (rotate === true) {
      secret = newSecret();
      rotation = {
        secretEnc: this.#seal(endpoint.id, secret),
        prevSecretEnc: endpoint.secretEnc,
        prevExpiresAt: new Date(now.getTime() + SECRET_OVERLAP_MS),
        at: now,
      };
    }
    const fields = ['url', 'events', 'enabled', 'rotate_secret'].filter(
      (f) => body[f] !== undefined,
    );
    const updated = await this.deps.repository.updateEndpoint(
      endpoint.id,
      {
        ...(url === undefined ? {} : { url }),
        ...(events === undefined ? {} : { events }),
        ...(enabled === undefined ? {} : { enabled: enabled as boolean }),
        ...(enabled === true && !endpoint.enabled ? { reactivate: true } : {}),
        ...(rotation === undefined ? {} : { rotation }),
        now,
      },
      (trx) =>
        ctx.audit(trx, {
          action: 'webhook.update',
          workspaceId: endpoint.workspaceId,
          target: { type: 'webhook', id: endpoint.id },
          meta: {
            fields: fields.join(' '),
            enabled: (enabled as boolean | undefined) ?? endpoint.enabled,
          },
        }),
    );
    if (updated === null) throw notFound(WEBHOOK_DETAILS.notFound);
    return { ...this.view(updated), ...(secret === undefined ? {} : { secret }) };
  }

  /** Deletes an endpoint (its deliveries with it). */
  async remove(endpoint: EndpointRecord, ctx: RequestCtx): Promise<void> {
    const deleted = await this.deps.repository.deleteEndpoint(endpoint.id, (trx) =>
      ctx.audit(trx, {
        action: 'webhook.delete',
        workspaceId: endpoint.workspaceId,
        target: { type: 'webhook', id: endpoint.id },
      }),
    );
    if (!deleted) throw notFound(WEBHOOK_DETAILS.notFound);
  }

  /** Fans `event` out to its endpoints and queues each first attempt; returns how many. */
  async fanOut(event: WebhookEvent): Promise<number> {
    const endpoints = await this.deps.repository.matchingEndpoints(event.workspace, event.type);
    const deliveries = endpoints.map((e) => ({ id: newId('dlv'), endpointId: e.id }));
    const stored = await this.deps.repository.fanOut(
      {
        id: event.id,
        workspaceId: event.workspace,
        type: event.type,
        data: event.data,
        createdAt: new Date(event.created_at),
      },
      deliveries,
    );
    if (!stored) return 0;
    for (const d of deliveries) {
      await this.deps.queue.add(
        'attempt',
        { deliveryId: d.id, attempt: 1 },
        { jobId: `${d.id}-1`, delay: 0 },
      );
    }
    this.#metrics.counter('webhook_deliveries_created_total').inc(deliveries.length);
    return deliveries.length;
  }

  /** The delay before retry `retry` (1 to 7), with ±10 % jitter. */
  retryDelay(retry: number): number {
    const base =
      RETRY_SCHEDULE_MS[retry - 1] ?? RETRY_SCHEDULE_MS[RETRY_SCHEDULE_MS.length - 1] ?? 0;
    return Math.round(base * (1 - RETRY_JITTER + 2 * RETRY_JITTER * this.#random()));
  }

  /** One try of a delivery (see the module comment). */
  async attempt(
    deliveryId: string,
    attempt: number,
    opts: { retry?: boolean } = {},
  ): Promise<AttemptResult> {
    const found = await this.deps.repository.findDelivery(deliveryId);
    if (found === null) return { skipped: true, next: null, final: null };
    const { delivery, endpoint, event } = found;
    if (delivery.status !== 'pending' || delivery.attempt !== attempt - 1) {
      return { skipped: true, next: null, final: null };
    }
    const now = new Date(this.#clock());
    if (!endpoint.enabled) {
      await this.deps.repository.recordAttempt(deliveryId, {
        attempt,
        status: 'failed',
        httpStatus: null,
        durationMs: null,
        lastError: 'endpoint_disabled',
        responseExcerpt: null,
        nextAttemptAt: null,
        now,
      });
      return { next: null, final: 'failed' };
    }
    let secrets: string[];
    try {
      secrets = [this.#open(endpoint.id, endpoint.secretEnc)];
      if (
        endpoint.prevSecretEnc !== null &&
        (endpoint.prevSecretExpiresAt?.getTime() ?? 0) > now.getTime()
      ) {
        secrets.push(this.#open(endpoint.id, endpoint.prevSecretEnc));
      }
    } catch {
      this.#metrics.counter('webhook_secret_unavailable_total').inc();
      this.deps.logger?.error({ webhook_id: endpoint.id }, 'webhook.secret_unavailable');
      return { next: { attempt, delayMs: SECRET_RETRY_MS }, final: null };
    }
    const body = JSON.stringify({
      id: delivery.id,
      type: event.type,
      created_at: event.createdAt.toISOString(),
      workspace: event.workspaceId,
      api_version: WEBHOOK_API_VERSION,
      data: event.data,
    });
    const outcome = await this.#perWorkspace.run(endpoint.workspaceId, () =>
      this.#perEndpoint.run(endpoint.id, () =>
        this.#deliver(endpoint, delivery, attempt, secrets, body),
      ),
    );
    return this.#record(endpoint, delivery, attempt, outcome, opts.retry !== false);
  }

  async #deliver(
    endpoint: EndpointRecord,
    delivery: DeliveryRecord,
    attempt: number,
    secrets: string[],
    body: string,
  ): Promise<
    | AttemptOutcome
    | { ok: false; error: 'blocked_destination'; status: null; durationMs: null; excerpt: null }
  > {
    let destination;
    try {
      destination = await resolveDestination(
        endpoint.url,
        this.#resolve,
        this.deps.config.allowLoopback,
      );
    } catch (err) {
      if (!(err instanceof BlockedDestinationError)) throw err;
      return {
        ok: false,
        error: 'blocked_destination',
        status: null,
        durationMs: null,
        excerpt: null,
      };
    }
    return this.#send({
      destination,
      body,
      headers: {
        'centcom-event-id': delivery.id,
        'centcom-event-type': delivery.eventType,
        'centcom-delivery-attempt': String(attempt),
        'centcom-signature': signPayload(secrets, body, Math.floor(this.#clock() / 1000)),
      },
    });
  }

  async #record(
    endpoint: EndpointRecord,
    delivery: DeliveryRecord,
    attempt: number,
    outcome:
      | AttemptOutcome
      | { ok: false; error: 'blocked_destination'; status: null; durationMs: null; excerpt: null },
    retry: boolean,
  ): Promise<AttemptResult> {
    const now = new Date(this.#clock());
    if (outcome.ok) {
      await this.deps.repository.recordAttempt(delivery.id, {
        attempt,
        status: 'delivered',
        httpStatus: outcome.status,
        durationMs: outcome.durationMs,
        lastError: null,
        responseExcerpt: outcome.excerpt,
        nextAttemptAt: null,
        now,
      });
      await this.deps.repository.endpointSucceeded(endpoint.id, now);
      this.#metrics.counter('webhook_attempts_total', { result: 'delivered' }).inc();
      return { next: null, final: 'delivered' };
    }
    const more = retry && attempt < MAX_ATTEMPTS;
    const delayMs = more ? this.retryDelay(attempt) : 0;
    await this.deps.repository.recordAttempt(delivery.id, {
      attempt,
      status: more ? 'pending' : 'failed',
      httpStatus: outcome.status,
      durationMs: outcome.durationMs,
      lastError: outcome.error,
      responseExcerpt: outcome.excerpt,
      nextAttemptAt: more ? new Date(now.getTime() + delayMs) : null,
      now,
    });
    this.#metrics.counter('webhook_attempts_total', { result: outcome.error }).inc();
    if (retry) {
      const { disabled } = await this.deps.repository.endpointFailed(
        endpoint.id,
        now,
        !more,
        new Date(now.getTime() - DISABLE_AFTER_MS),
      );
      if (disabled) await this.#announceDisabled(endpoint);
    }
    return more
      ? { next: { attempt: attempt + 1, delayMs }, final: null }
      : { next: null, final: 'failed' };
  }

  async #announceDisabled(endpoint: EndpointRecord): Promise<void> {
    this.#metrics.counter('webhook_endpoints_disabled_total').inc();
    this.deps.logger?.warn(
      { webhook_id: endpoint.id, workspace_id: endpoint.workspaceId },
      'webhook.disabled',
    );
    this.deps.audit?.emitDetached({
      workspaceId: endpoint.workspaceId,
      actor: { type: 'system', id: 'webhooks' },
      action: 'webhook.update',
      target: { type: 'webhook', id: endpoint.id },
      outcome: 'success',
      meta: { fields: 'enabled status', enabled: false },
    });
    try {
      await this.deps.notifier?.endpointDisabled(endpoint.workspaceId, endpoint.id);
    } catch (err) {
      this.deps.logger?.error(
        { webhook_id: endpoint.id, error: (err as Error).name },
        'webhook.disabled_notice_failed',
      );
    }
  }

  /** Sends a `webhook.test` event to the endpoint once, and answers the delivery. */
  async test(endpoint: EndpointRecord): Promise<Api.WebhookDelivery> {
    const deliveryId = newId('dlv');
    const event = {
      id: `test-${deliveryId}`,
      workspaceId: endpoint.workspaceId,
      type: 'webhook.test',
      data: { endpoint: endpoint.id },
      createdAt: new Date(this.#clock()),
    };
    await this.deps.repository.fanOut(event, [{ id: deliveryId, endpointId: endpoint.id }]);
    await this.attempt(deliveryId, 1, { retry: false });
    return this.#deliveryOf(deliveryId);
  }

  /** The endpoint's delivery log, newest first. */
  async deliveries(endpoint: EndpointRecord, page: PageParams): Promise<Page<Api.WebhookDelivery>> {
    const result = await this.deps.repository.listDeliveries(endpoint.id, page);
    return { ...result, data: result.data.map((d) => this.deliveryView(d)) };
  }

  /** Re-opens one of the endpoint's deliveries and queues an attempt now. */
  async redeliver(endpoint: EndpointRecord, deliveryId: unknown): Promise<Api.WebhookDelivery> {
    const found =
      typeof deliveryId === 'string' && /^dlv_[0-9A-HJKMNP-TV-Z]{26}$/.test(deliveryId)
        ? await this.deps.repository.findDelivery(deliveryId)
        : null;
    if (found === null || found.delivery.endpointId !== endpoint.id) {
      throw notFound(WEBHOOK_DETAILS.deliveryNotFound);
    }
    const now = new Date(this.#clock());
    const reopened = await this.deps.repository.reopenDelivery(found.delivery.id, now);
    if (reopened === null) throw notFound(WEBHOOK_DETAILS.deliveryNotFound);
    const attempt = reopened.attempt + 1;
    await this.deps.queue.add(
      'attempt',
      { deliveryId: reopened.id, attempt },
      { jobId: `${reopened.id}-${attempt}-manual-${now.getTime()}`, delay: 0 },
    );
    return this.deliveryView(reopened);
  }

  async #deliveryOf(id: string): Promise<Api.WebhookDelivery> {
    const found = await this.deps.repository.findDelivery(id);
    if (found === null) throw notFound(WEBHOOK_DETAILS.deliveryNotFound);
    return this.deliveryView(found.delivery);
  }
}
