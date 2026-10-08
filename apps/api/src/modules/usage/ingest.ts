/**
 * Usage ingestion (B074, CT-API-USAGE): stores a validated batch for a device.
 *
 * 1. Attribution (attribution.ts) gives each event its workspace; a session the caller does not
 *    take part in is 403 for the whole batch.
 * 2. The per-workspace daily event cap (USAGE_DAILY_EVENT_CAP, default 1 000 000 a UTC day) is an
 *    abuse limit, not a plan quota: past it the batch is 429 `rate_limited` until midnight UTC.
 *    Its counter is approximate (a Redis value, read then written) and never blocks when Redis
 *    fails. Plan quotas never block ingestion: usage is a fact (quota is enforced elsewhere).
 * 3. The batch is written in one statement; ids already stored for that workspace are
 *    duplicates. The answer is `{accepted, duplicates}`.
 * 4. A hint goes out on `usage:ingested` (the workspaces and the receive time) for B075. A failed
 *    hint is logged and never fails the batch: B075 also sweeps by `received_at`.
 *
 * A database timeout or lost connection is 503 with `retry_after_s`; the client retries with the
 * same Idempotency-Key and event ids.
 *
 * Owns: the order above. Must not: store a partial batch, or anything beyond the contract fields,
 * the device and the receive time.
 */
import {
  AppError,
  defineConfig,
  envInt,
  noopMetrics,
  unavailable,
  z,
  type Env,
  type KeyValue,
  type Logger,
  type Metrics,
  type PubSub,
} from '@centcom/core';
import { isConnectionError } from '@centcom/db';
import { attribute, workspaceOf, type DevicePrincipal } from './attribution.js';
import type { UsageRepository, UsageRow } from './repository.js';
import type { UsageEvent } from './validate.js';

/** The channel of B075's hint. */
export const USAGE_HINT_CHANNEL = 'usage:ingested';
/** Default events a workspace may report a UTC day. */
export const DEFAULT_DAILY_EVENT_CAP = 1_000_000;
/** Seconds a client waits after a database failure. */
export const USAGE_RETRY_AFTER_S = 5;

/** The details of ingestion's refusals (GUIDELINES §3.4). */
export const INGEST_DETAILS = Object.freeze({
  dailyCap: 'This workspace reported its maximum of usage events for today.',
  unavailable: 'Usage cannot be stored right now. Try again with the same Idempotency-Key.',
} as const);

/** The environment keys of ingestion. */
export const usageEnvSchema = z.object({
  USAGE_DAILY_EVENT_CAP: envInt({ min: 1, max: 1_000_000_000 })
    .default(DEFAULT_DAILY_EVENT_CAP)
    .meta({ description: 'Usage events one workspace may report per UTC day (an abuse limit).' }),
});

/** Reads the ingestion settings. */
export function loadUsageConfig(env?: Env): { dailyEventCap: number } {
  return { dailyEventCap: defineConfig(usageEnvSchema, env).USAGE_DAILY_EVENT_CAP };
}

/** What ingestion needs. */
export interface UsageIngestDeps {
  repository: UsageRepository;
  /** For the daily cap's counters; without it there is no cap. */
  kv?: KeyValue;
  dailyEventCap?: number;
  /** For B075's hint; without it there is none. */
  pubsub?: Pick<PubSub, 'publish'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** What a batch did. */
export interface IngestResult {
  accepted: number;
  duplicates: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A database failure that is the database's fault (timeout, lost connection): a 503. */
function databaseFailure(err: unknown): never {
  const code = (err as { code?: unknown } | null)?.code;
  if (isConnectionError(err) || code === '57014') {
    throw unavailable(USAGE_RETRY_AFTER_S, INGEST_DETAILS.unavailable, {
      cause: new Error('database unavailable'),
    });
  }
  throw err;
}

/** Usage ingestion. */
export class UsageIngest {
  readonly #clock: () => number;
  readonly #metrics: Metrics;

  constructor(private readonly deps: UsageIngestDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** Stores `events` (validated: `parseUsageBatch`) reported by `principal`. */
  async ingest(principal: DevicePrincipal, events: readonly UsageEvent[]): Promise<IngestResult> {
    const now = new Date(this.#clock());
    const sessions = events.flatMap((e) => (e.sessionId === null ? [] : [e.sessionId]));
    const attribution = await this.#guarded(() =>
      attribute(
        this.deps.repository,
        principal,
        sessions,
        events.some((e) => e.sessionId === null),
      ),
    );
    const rows: UsageRow[] = events.map((e) => ({
      workspaceId: workspaceOf(attribution, e.sessionId),
      eventId: e.id,
      type: e.type,
      qty: e.qty,
      at: e.at,
      sessionId: e.sessionId,
      agentId: e.agentId,
      deviceId: principal.deviceId,
      receivedAt: now,
    }));
    const perWorkspace = new Map<string, number>();
    for (const row of rows)
      perWorkspace.set(row.workspaceId, (perWorkspace.get(row.workspaceId) ?? 0) + 1);

    const counts = await this.#checkDailyCap(perWorkspace, now);
    const inserted = await this.#guarded(() => this.deps.repository.insertEvents(rows));
    const accepted = inserted.length;
    const duplicates = rows.length - accepted;
    await this.#countDaily(counts, inserted, now);
    this.#metrics.counter('usage_events_accepted_total').inc(accepted);
    this.#metrics.counter('usage_events_duplicate_total').inc(duplicates);
    if (accepted > 0) await this.#hint([...perWorkspace.keys()], now);
    return { accepted, duplicates };
  }

  async #guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      return databaseFailure(err);
    }
  }

  #dayKey(workspaceId: string, now: Date): string {
    return `usage:daily:${workspaceId}:${now.toISOString().slice(0, 10)}`;
  }

  /** Refuses the batch past a workspace's daily cap; returns the counters it read. */
  async #checkDailyCap(
    perWorkspace: ReadonlyMap<string, number>,
    now: Date,
  ): Promise<Map<string, number> | null> {
    const { kv } = this.deps;
    if (kv === undefined) return null;
    const cap = this.deps.dailyEventCap ?? DEFAULT_DAILY_EVENT_CAP;
    const counts = new Map<string, number>();
    try {
      for (const [workspaceId, n] of perWorkspace) {
        const current = Number((await kv.get(this.#dayKey(workspaceId, now))) ?? 0) || 0;
        counts.set(workspaceId, current);
        if (current + n > cap) {
          const midnight = Math.floor(now.getTime() / DAY_MS) * DAY_MS + DAY_MS;
          this.#metrics.counter('usage_daily_cap_refusals_total').inc();
          throw new AppError('rate_limited', {
            detail: INGEST_DETAILS.dailyCap,
            retryAfterS: Math.max(1, Math.ceil((midnight - now.getTime()) / 1000)),
          });
        }
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.deps.logger?.warn({ error: (err as Error).name }, 'usage.daily_cap_unavailable');
      return null;
    }
    return counts;
  }

  /** Adds this batch's new events to each workspace's daily counter. */
  async #countDaily(
    counts: ReadonlyMap<string, number> | null,
    inserted: readonly string[],
    now: Date,
  ): Promise<void> {
    const { kv } = this.deps;
    if (kv === undefined || counts === null || inserted.length === 0) return;
    const added = new Map<string, number>();
    for (const workspaceId of inserted) added.set(workspaceId, (added.get(workspaceId) ?? 0) + 1);
    // Until an hour past midnight UTC, so the day's key outlives the day.
    const ttlMs =
      Math.floor(now.getTime() / DAY_MS) * DAY_MS + DAY_MS - now.getTime() + 60 * 60 * 1000;
    try {
      for (const [workspaceId, n] of added) {
        const before = counts.get(workspaceId) ?? 0;
        await kv.set(this.#dayKey(workspaceId, now), String(before + n), { ttlMs });
      }
    } catch (err) {
      this.deps.logger?.warn({ error: (err as Error).name }, 'usage.daily_cap_unavailable');
    }
  }

  async #hint(workspaceIds: readonly string[], now: Date): Promise<void> {
    if (this.deps.pubsub === undefined) return;
    try {
      await this.deps.pubsub.publish(
        USAGE_HINT_CHANNEL,
        JSON.stringify({ workspaces: workspaceIds, received_at: now.toISOString() }),
      );
    } catch (err) {
      this.#metrics.counter('usage_hint_failures_total').inc();
      this.deps.logger?.warn({ error: (err as Error).name }, 'usage.hint_failed');
    }
  }
}
