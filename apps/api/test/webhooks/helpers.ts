/**
 * Fixtures for the webhook tests (B081): an in-memory repository with the Postgres one's rules
 * (per-workspace limit under one lock, fan-out once per event, compare-and-set attempts, the
 * disable-once update), a local HTTP receiver on loopback that records every request's exact bytes
 * and answers scripted statuses and delays, a scripted DNS resolver, a recording queue, and the
 * service wired with test-mode loopback (WEBHOOK_ALLOW_LOOPBACK).
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { paginateArray, Secret, type AuditDb, type SigningKeys } from '@centcom/core';
import type { WebhookConfig } from '../../src/modules/webhooks/config.js';
import type { HostResolver } from '../../src/modules/webhooks/destination.js';
import { httpSender, type WebhookSender } from '../../src/modules/webhooks/http.js';
import type {
  AttemptRecord,
  DeliveryRecord,
  EndpointRecord,
  StoredEvent,
  WebhookRepository,
} from '../../src/modules/webhooks/repository.js';
import { WebhookService, type WebhookServiceDeps } from '../../src/modules/webhooks/service.js';

export const KEYS: SigningKeys = [
  { id: 'k1', secret: new Secret(new Uint8Array(randomBytes(32))) },
];

/** A controllable clock. */
export class Clock {
  constructor(public now = Date.UTC(2026, 9, 8, 12, 0, 0)) {}
  readonly read = (): number => this.now;
  advance(ms: number): void {
    this.now += ms;
  }
}

/** The repository in memory, by the Postgres one's rules. */
export class MemoryWebhookRepository implements WebhookRepository {
  readonly endpoints = new Map<string, EndpointRecord>();
  readonly events = new Map<string, StoredEvent>();
  readonly deliveries = new Map<string, DeliveryRecord>();
  readonly outbox: Record<string, unknown>[] = [];
  /** The parameters of every audit insert written in a transaction. */
  readonly auditParameters: unknown[][] = [];
  #turn: Promise<unknown> = Promise.resolve();
  readonly #auditTrx: AuditDb = {
    isTransaction: true,
    executeQuery: (query) => {
      this.auditParameters.push([...query.parameters]);
      return Promise.resolve({ rows: [] });
    },
  };

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#turn.then(fn, fn);
    this.#turn = run.catch(() => undefined);
    return run;
  }

  createEndpoint(
    row: Parameters<WebhookRepository['createEndpoint']>[0],
    limit: number | null,
    audit: (trx: AuditDb) => Promise<unknown>,
  ) {
    return this.#exclusive(async () => {
      const count = [...this.endpoints.values()].filter(
        (e) => e.workspaceId === row.workspaceId,
      ).length;
      if (limit !== null && count >= limit) return 'limit' as const;
      const now = new Date();
      const record: EndpointRecord = {
        ...row,
        enabled: true,
        status: 'active',
        prevSecretEnc: null,
        prevSecretExpiresAt: null,
        secretRotatedAt: null,
        failingSince: null,
        disabledAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await audit(this.#auditTrx);
      this.endpoints.set(row.id, record);
      return { ...record };
    });
  }

  findEndpoint(id: string) {
    const e = this.endpoints.get(id);
    return Promise.resolve(e === undefined ? null : { ...e });
  }

  listEndpoints(workspaceId: string, page: Parameters<WebhookRepository['listEndpoints']>[1]) {
    const items = [...this.endpoints.values()].filter((e) => e.workspaceId === workspaceId);
    return Promise.resolve(
      paginateArray(
        items,
        {
          sorts: { created: { value: (e) => e.createdAt.getTime(), direction: 'desc' } },
          id: (e) => e.id,
        },
        page,
      ),
    );
  }

  updateEndpoint(
    id: string,
    patch: Parameters<WebhookRepository['updateEndpoint']>[1],
    audit: (trx: AuditDb) => Promise<unknown>,
  ) {
    return this.#exclusive(async () => {
      const e = this.endpoints.get(id);
      if (e === undefined) return null;
      const next: EndpointRecord = { ...e, updatedAt: patch.now };
      if (patch.url !== undefined) next.url = patch.url;
      if (patch.events !== undefined) next.events = patch.events;
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      if (patch.reactivate === true)
        Object.assign(next, { status: 'active', failingSince: null, disabledAt: null });
      if (patch.rotation !== undefined) {
        Object.assign(next, {
          secretEnc: patch.rotation.secretEnc,
          prevSecretEnc: patch.rotation.prevSecretEnc,
          prevSecretExpiresAt: patch.rotation.prevExpiresAt,
          secretRotatedAt: patch.rotation.at,
        });
      }
      await audit(this.#auditTrx);
      this.endpoints.set(id, next);
      return { ...next };
    });
  }

  deleteEndpoint(id: string, audit: (trx: AuditDb) => Promise<unknown>) {
    return this.#exclusive(async () => {
      if (!this.endpoints.has(id)) return false;
      await audit(this.#auditTrx);
      this.endpoints.delete(id);
      for (const [k, d] of this.deliveries) if (d.endpointId === id) this.deliveries.delete(k);
      return true;
    });
  }

  matchingEndpoints(workspaceId: string, type: string) {
    return Promise.resolve(
      [...this.endpoints.values()].filter(
        (e) =>
          e.workspaceId === workspaceId &&
          e.enabled &&
          (e.events.includes(type) || e.events.includes('*')),
      ),
    );
  }

  fanOut(event: StoredEvent, deliveries: { id: string; endpointId: string }[]) {
    return this.#exclusive(() => {
      if (this.events.has(event.id)) return Promise.resolve(false);
      this.events.set(event.id, event);
      const now = new Date();
      for (const d of deliveries) {
        this.deliveries.set(d.id, {
          id: d.id,
          endpointId: d.endpointId,
          eventId: event.id,
          eventType: event.type,
          attempt: 0,
          status: 'pending',
          httpStatus: null,
          durationMs: null,
          lastError: null,
          responseExcerpt: null,
          nextAttemptAt: null,
          createdAt: now,
          updatedAt: now,
        });
      }
      return Promise.resolve(true);
    });
  }

  findDelivery(id: string) {
    const delivery = this.deliveries.get(id);
    const endpoint = delivery === undefined ? undefined : this.endpoints.get(delivery.endpointId);
    const event = delivery === undefined ? undefined : this.events.get(delivery.eventId);
    return Promise.resolve(
      delivery === undefined || endpoint === undefined || event === undefined
        ? null
        : { delivery: { ...delivery }, endpoint: { ...endpoint }, event: { ...event } },
    );
  }

  recordAttempt(id: string, r: AttemptRecord) {
    const d = this.deliveries.get(id);
    if (d === undefined || d.attempt !== r.attempt - 1 || d.status !== 'pending')
      return Promise.resolve(null);
    const next: DeliveryRecord = {
      ...d,
      attempt: r.attempt,
      status: r.status,
      httpStatus: r.httpStatus,
      durationMs: r.durationMs,
      lastError: r.lastError,
      responseExcerpt: r.responseExcerpt,
      nextAttemptAt: r.nextAttemptAt,
      updatedAt: r.now,
    };
    this.deliveries.set(id, next);
    return Promise.resolve({ ...next });
  }

  reopenDelivery(id: string, now: Date) {
    const d = this.deliveries.get(id);
    if (d === undefined) return Promise.resolve(null);
    const next: DeliveryRecord = { ...d, status: 'pending', nextAttemptAt: now, updatedAt: now };
    this.deliveries.set(id, next);
    return Promise.resolve({ ...next });
  }

  listDeliveries(endpointId: string, page: Parameters<WebhookRepository['listDeliveries']>[1]) {
    const items = [...this.deliveries.values()].filter((d) => d.endpointId === endpointId);
    return Promise.resolve(
      paginateArray(
        items,
        {
          sorts: { created: { value: (d) => d.createdAt.getTime(), direction: 'desc' } },
          id: (d) => d.id,
        },
        page,
      ),
    );
  }

  endpointFailed(id: string, now: Date, final: boolean, disableBefore: Date) {
    const e = this.endpoints.get(id);
    if (e === undefined) return Promise.resolve({ disabled: false });
    e.failingSince ??= now;
    if (final && e.enabled) e.status = 'failing';
    if (e.enabled && e.failingSince.getTime() <= disableBefore.getTime()) {
      Object.assign(e, { enabled: false, status: 'disabled', disabledAt: now });
      return Promise.resolve({ disabled: true });
    }
    return Promise.resolve({ disabled: false });
  }

  endpointSucceeded(id: string) {
    const e = this.endpoints.get(id);
    if (e !== undefined && e.enabled) Object.assign(e, { failingSince: null, status: 'active' });
    return Promise.resolve();
  }

  writeOutbox(event: Record<string, unknown>) {
    this.outbox.push(event);
    return Promise.resolve();
  }

  async drainOutbox(limit: number, send: (events: Record<string, unknown>[]) => Promise<void>) {
    const batch = this.outbox.slice(0, limit);
    if (batch.length === 0) return 0;
    await send(batch);
    this.outbox.splice(0, batch.length);
    return batch.length;
  }
}

/** A recorded request to the receiver. */
export interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A scripted answer: a status (and headers/body), optionally after a delay. */
export interface Answer {
  status: number;
  delayMs?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

/** A local receiver on 127.0.0.1. */
export async function receiver(script: (n: number) => Answer = () => ({ status: 200 })) {
  const received: Received[] = [];
  let inFlight = 0;
  let peak = 0;
  const server: Server = createServer((req, res) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      const answer = script(received.length);
      const reply = () => {
        res.writeHead(answer.status, answer.headers);
        res.end(answer.body ?? '');
        inFlight -= 1;
      };
      if (answer.delayMs === undefined) reply();
      else setTimeout(reply, answer.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: (path = '/hook') => `http://127.0.0.1:${port}${path}`,
    received,
    peak: () => peak,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A resolver answering from a table (host → addresses), changeable mid-test. */
export function tableResolver(
  table: Record<string, string[]>,
): HostResolver & { set(host: string, a: string[]): void } {
  const resolve = ((host: string) => {
    const found = table[host];
    return found === undefined ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve(found);
  }) as HostResolver & { set(host: string, a: string[]): void };
  resolve.set = (host, a) => {
    table[host] = a;
  };
  return resolve;
}

/** A queue that records the jobs added to it. */
export function recordingQueue() {
  const jobs: {
    name: string;
    data: { deliveryId: string; attempt: number };
    opts: { jobId: string; delay: number };
  }[] = [];
  return {
    jobs,
    add: (
      name: string,
      data: { deliveryId: string; attempt: number },
      opts: { jobId: string; delay: number },
    ) => {
      jobs.push({ name, data, opts });
      return Promise.resolve();
    },
  };
}

/** Test-mode configuration: loopback allowed unless said otherwise. */
export const testConfig = (allowLoopback = true): WebhookConfig => ({
  secretKey: new Secret(new Uint8Array(randomBytes(32))),
  allowLoopback,
});

/** A sender with a short timeout, so timeouts take milliseconds in tests. */
export const quickSender =
  (timeoutMs: number): WebhookSender =>
  (req) =>
    httpSender({ ...req, timeoutMs });

/** The service over memory, a clock at a fixed instant and fixed jitter. */
export function webhookService(overrides: Partial<WebhookServiceDeps> = {}) {
  const repository = new MemoryWebhookRepository();
  const queue = recordingQueue();
  const clock = new Clock();
  const service = new WebhookService({
    repository,
    config: testConfig(),
    queue,
    clock: clock.read,
    random: () => 0.5,
    resolve: tableResolver({}),
    ...overrides,
  });
  return { service, repository, queue, clock };
}

/** A request context whose audit writes are recorded. */
export function recordingCtx() {
  const audits: Record<string, unknown>[] = [];
  return {
    audits,
    ctx: {
      audit: (_trx: AuditDb, input: Record<string, unknown>) => {
        audits.push(input);
        return Promise.resolve('aud_x');
      },
    },
  };
}
