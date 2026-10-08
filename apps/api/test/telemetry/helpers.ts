/**
 * Test helpers for telemetry (B085): an in-memory TelemetryRepository with the Postgres one's
 * semantics (day partitions, one rollup per day, counts only, drops by day), golden batches, and
 * the route on the API's plugin stack with real B017 authentication and B023's rate limiter (with
 * the telemetry route exempt, as the composer must register it).
 */
import { newId } from '@centcom/contracts';
import {
  createMemoryRedis,
  DEFAULT_EXEMPT_ROUTES,
  defaultBuckets,
  Secret,
  type RedisBackend,
} from '@centcom/core';
import { fastify, type FastifyInstance } from 'fastify';
import { TelemetryLimits } from '../../src/modules/telemetry/limits.js';
import type { TelemetryRepository } from '../../src/modules/telemetry/repository.js';
import type { StoredEvent } from '../../src/modules/telemetry/scrub.js';
import { TelemetryIngest } from '../../src/modules/telemetry/service.js';
import { authPlugin } from '../../src/plugins/auth.js';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.js';
import { rateLimitPlugin } from '../../src/plugins/rate-limit.js';
import { requestContextPlugin } from '../../src/plugins/request-context.js';
import { TELEMETRY_ROUTE, telemetryRoutes } from '../../src/routes/telemetry.js';
import { captureLogger, recordingMetrics } from '../helpers.js';
import { memoryTokens } from '../modules/auth/tokens/helpers.js';

/** The tests' "now": 2026-11-03 12:00 UTC. */
export const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);
export const DAY_MS = 86_400_000;
/** A valid install id. */
export const INSTALL = '01JA3Z8K2M5N7P9Q0R1S2T3V4W';

/** A stored row, as the memory repository keeps it. */
export interface MemoryRow extends StoredEvent {
  day: string;
}

/** An in-memory TelemetryRepository. */
export class MemoryTelemetryRepository implements TelemetryRepository {
  rows: MemoryRow[] = [];
  partitions = new Set<string>();
  rollups = new Set<string>();
  /** `${day}|${type}|${key}` to count. */
  agg = new Map<string, number>();
  /** Inserts fail (Postgres down). */
  down = false;
  statements = 0;

  insert(day: string, events: readonly StoredEvent[]): Promise<void> {
    if (this.down)
      return Promise.reject(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      );
    if (events.length === 0) return Promise.resolve();
    this.statements += 1;
    this.partitions.add(day);
    for (const e of events) this.rows.push({ ...structuredClone(e), day });
    return Promise.resolve();
  }

  rollup(day: string): Promise<boolean> {
    if (this.rollups.has(day)) return Promise.resolve(false);
    this.rollups.add(day);
    const add = (type: string, key: string) => {
      const k = `${day}|${type}|${key}`;
      this.agg.set(k, (this.agg.get(k) ?? 0) + 1);
    };
    for (const row of this.rows.filter((r) => r.day === day)) {
      add(row.type, '*');
      for (const [k, v] of Object.entries(row.props)) {
        if (typeof v === 'string' || typeof v === 'boolean') add(row.type, `${k}=${String(v)}`);
      }
    }
    return Promise.resolve(true);
  }

  partitionDays(): Promise<string[]> {
    return Promise.resolve([...this.partitions].sort());
  }

  rolledUpDays(): Promise<string[]> {
    return Promise.resolve([...this.rollups]);
  }

  drop(before: string): Promise<string[]> {
    const gone = [...this.partitions].filter((d) => d < before).sort();
    for (const d of gone) this.partitions.delete(d);
    this.rows = this.rows.filter((r) => !gone.includes(r.day));
    return Promise.resolve(gone.map((d) => `telemetry_events_${d.replaceAll('-', '')}`));
  }
}

/** An event at `at` (default a minute before T0). */
export const event = (type: string, props?: Record<string, unknown>, at = T0 - 60_000) => ({
  type,
  at: new Date(at).toISOString(),
  ...(props === undefined ? {} : { props }),
});

/** A batch of `events` for INSTALL. */
export const batch = (events: unknown[], over: Record<string, unknown> = {}) => ({
  install_id: INSTALL,
  app: { name: 'centcom-cli', version: '1.4.2', os: 'linux', arch: 'x64', contract: '1.0.0' },
  events,
  ...over,
});

/** The route on the API's stack, over the memory repository. */
export interface TelemetryApp {
  app: FastifyInstance;
  repo: MemoryTelemetryRepository;
  redis: RedisBackend;
  captured: ReturnType<typeof captureLogger>;
  recorded: ReturnType<typeof recordingMetrics>;
  clock: { now: number };
  /** A bearer header for a valid user token. */
  bearer(): Promise<Record<string, string>>;
}

export async function telemetryApp(): Promise<TelemetryApp> {
  const repo = new MemoryTelemetryRepository();
  const clock = { now: T0 };
  const redis = createMemoryRedis(() => clock.now);
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const { tokens } = memoryTokens();
  const ingest = new TelemetryIngest({
    repository: repo,
    limits: new TelemetryLimits(redis.rateLimit, new Secret('s'.repeat(32))),
    config: { maxEvents: 100, maxBytes: 64 * 1024, retentionDays: 90 },
    clock: () => clock.now,
    logger: captured.logger,
    metrics: recorded.metrics,
  });
  const app = fastify({ logger: false });
  await app.register(requestContextPlugin, { logger: captured.logger, metrics: recorded.metrics });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(rateLimitPlugin, {
    store: redis.rateLimit,
    config: {
      buckets: defaultBuckets,
      trustedHops: 0,
      exempt: [...DEFAULT_EXEMPT_ROUTES, TELEMETRY_ROUTE],
    },
  });
  await app.register(authPlugin, { tokens });
  await app.register(telemetryRoutes, { ingest });
  await app.ready();
  return {
    app,
    repo,
    redis,
    captured,
    recorded,
    clock,
    async bearer() {
      const issued = await tokens.issueTokens({
        userId: newId('usr'),
        deviceId: null,
        scopes: ['profile'],
      });
      return { authorization: `Bearer ${issued.access_token}` };
    },
  };
}

/** POST a body (an object is sent as JSON) with headers. */
export function post(
  app: FastifyInstance,
  body: unknown,
  headers: Record<string, string> = {},
  remoteAddress = '203.0.113.7',
) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: TELEMETRY_ROUTE,
    headers: { 'content-type': 'application/json', ...headers },
    payload,
    remoteAddress,
  });
}
