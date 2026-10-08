/**
 * Test helpers for health and status (B086): an in-memory StatusRepository, a scripted database
 * for readiness (up, down, slow, behind on migrations, no migrations table), a scripted HTTP server
 * for component probes (up, down or hanging, counting requests), and the routes on the API's
 * plugin stack. Instances share one in-memory Redis.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMemoryRedis, type RedisBackend } from '@centcom/core';
import type { IncidentStatus } from '@centcom/db';
import { fastify, type FastifyInstance } from 'fastify';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import type { StatusComponent } from '../../src/modules/status/config.js';
import { ComponentProber } from '../../src/modules/status/prober.js';
import { Readiness } from '../../src/modules/status/readiness.js';
import type {
  DeprecationRecord,
  IncidentRecord,
  StatusRepository,
} from '../../src/modules/status/repository.js';
import { StatusAdmin, StatusFeed } from '../../src/modules/status/service.js';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.js';
import { requestContextPlugin } from '../../src/plugins/request-context.js';
import { statusRoutes } from '../../src/routes/status.js';
import { captureLogger, recordingMetrics } from '../helpers.js';

/** The tests' "now". */
export const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);
export const DAY_MS = 86_400_000;

/** An in-memory StatusRepository. */
export class MemoryStatusRepository implements StatusRepository {
  incidents = new Map<string, IncidentRecord>();
  deprecationRows = new Map<string, string>();
  down = false;
  reads = 0;

  #check(): void {
    if (this.down)
      throw Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), {
        code: 'ECONNREFUSED',
      });
  }

  feedIncidents(resolvedSince: Date, limit: number): Promise<IncidentRecord[]> {
    try {
      this.#check();
    } catch (err) {
      return Promise.reject(err as Error);
    }
    this.reads += 1;
    const rows = [...this.incidents.values()]
      .filter((i) => i.resolvedAt === null || i.resolvedAt >= resolvedSince)
      .sort(
        (a, b) =>
          Number(a.resolvedAt !== null) - Number(b.resolvedAt !== null) ||
          b.startedAt.getTime() - a.startedAt.getTime(),
      )
      .slice(0, limit);
    return Promise.resolve(structuredClone(rows));
  }

  deprecations(): Promise<DeprecationRecord[]> {
    try {
      this.#check();
    } catch (err) {
      return Promise.reject(err as Error);
    }
    return Promise.resolve(
      [...this.deprecationRows]
        .map(([what, sunset]) => ({ what, sunset }))
        .sort((a, b) => (a.sunset < b.sunset ? -1 : 1)),
    );
  }

  createIncident(incident: Omit<IncidentRecord, 'updates' | 'resolvedAt'>): Promise<void> {
    this.incidents.set(incident.id, {
      ...incident,
      resolvedAt: incident.status === 'resolved' ? incident.startedAt : null,
      updates: [],
    });
    return Promise.resolve();
  }

  addUpdate(
    id: string,
    update: { at: Date; text: string; status: IncidentStatus | null },
  ): Promise<boolean> {
    const incident = this.incidents.get(id);
    if (incident === undefined) return Promise.resolve(false);
    incident.updates.push(update);
    if (update.status !== null) {
      incident.status = update.status;
      incident.resolvedAt = update.status === 'resolved' ? update.at : null;
    }
    return Promise.resolve(true);
  }

  resolve(id: string, at: Date): Promise<boolean> {
    const incident = this.incidents.get(id);
    if (incident === undefined) return Promise.resolve(false);
    incident.status = 'resolved';
    incident.resolvedAt ??= at;
    return Promise.resolve(true);
  }

  getIncident(id: string): Promise<IncidentRecord | null> {
    const incident = this.incidents.get(id);
    return Promise.resolve(incident === undefined ? null : structuredClone(incident));
  }

  setDeprecation(d: DeprecationRecord): Promise<void> {
    this.deprecationRows.set(d.what, d.sunset);
    return Promise.resolve();
  }
}

/** How the scripted database behaves. */
export interface DbScript {
  mode: 'up' | 'down' | 'slow' | 'no_table';
  /** The newest applied migration. */
  version: string | null;
}

/** A database answering `select 1` and the migration-version queries as `script` says. */
export function scriptedReadinessDb(script: DbScript): Kysely<unknown> {
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      if (script.mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 5000).unref());
      if (script.mode === 'down') {
        throw Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), {
          code: 'ECONNREFUSED',
        });
      }
      const rows: unknown[] = /to_regclass/.test(query.sql)
        ? [{ present: script.mode !== 'no_table' }]
        : /max\(version\)/.test(query.sql)
          ? [{ version: script.version }]
          : [{ one: 1 }];
      return { rows: rows as R[] };
    },
    streamQuery() {
      throw new Error('not streamed');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  return new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

/** A Redis whose PING answers, fails, or hangs. */
export function scriptedRedis(mode: 'up' | 'down' | 'slow') {
  return {
    ping: () =>
      mode === 'up'
        ? Promise.resolve()
        : mode === 'down'
          ? Promise.reject(new Error('connect ECONNREFUSED redis.internal:6379'))
          : new Promise<void>((resolve) => setTimeout(resolve, 5000).unref()),
  };
}

/** A probe target: `up` answers 200, `down` 503, `hang` never within 10 s; requests are counted. */
export interface ProbeTarget {
  url: (path: string) => string;
  modes: Map<string, 'up' | 'down' | 'hang'>;
  hits: Map<string, number>;
  close(): Promise<void>;
}

export async function probeTarget(): Promise<ProbeTarget> {
  const modes = new Map<string, 'up' | 'down' | 'hang'>();
  const hits = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '/';
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const mode = modes.get(path) ?? 'up';
    if (mode === 'hang') {
      setTimeout(() => res.end('late'), 10_000).unref();
      return;
    }
    res.statusCode = mode === 'up' ? 200 : 503;
    res.end(mode);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    modes,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** One API instance: its feed, admin, readiness and app. */
export interface StatusInstance {
  app: FastifyInstance;
  feed: StatusFeed;
  admin: StatusAdmin;
  captured: ReturnType<typeof captureLogger>;
  recorded: ReturnType<typeof recordingMetrics>;
}

/** Shared state: repository, Redis, clock, components. */
export interface StatusWorld {
  repo: MemoryStatusRepository;
  redis: RedisBackend;
  clock: { now: number };
  components: StatusComponent[];
  db: DbScript;
  redisMode: { mode: 'up' | 'down' | 'slow' };
  instance(): Promise<StatusInstance>;
  close(): Promise<void>;
}

export function statusWorld(components: StatusComponent[] = []): StatusWorld {
  const repo = new MemoryStatusRepository();
  const clock = { now: T0 };
  const redis = createMemoryRedis(() => clock.now);
  const db: DbScript = { mode: 'up', version: '20260102002800' };
  const redisMode = { mode: 'up' as 'up' | 'down' | 'slow' };
  const opened: StatusInstance[] = [];
  return {
    repo,
    redis,
    clock,
    components,
    db,
    redisMode,
    async instance() {
      const captured = captureLogger();
      const recorded = recordingMetrics();
      const kv = redis.kv;
      const prober = new ComponentProber({
        components,
        kv,
        clock: () => clock.now,
        metrics: recorded.metrics,
      });
      const feed = new StatusFeed({
        prober,
        repository: repo,
        kv,
        components,
        minClientVersion: '1.0.0',
        clock: () => clock.now,
        logger: captured.logger,
        metrics: recorded.metrics,
      });
      const readiness = {
        check: () =>
          new Readiness({
            db: scriptedReadinessDb(db),
            redis: scriptedRedis(redisMode.mode),
            expectedVersion: '20260102002800',
            timeoutMs: 1000,
          }).check(),
      };
      const app = fastify({ logger: false });
      await app.register(requestContextPlugin, { logger: captured.logger });
      await app.register(errorHandlerPlugin, { logger: captured.logger });
      await app.register(statusRoutes, { feed, readiness });
      await app.ready();
      const admin = new StatusAdmin({ repository: repo, components, clock: () => clock.now });
      const instance = { app, feed, admin, captured, recorded };
      opened.push(instance);
      return instance;
    },
    async close() {
      for (const i of opened.splice(0)) await i.app.close();
    },
  };
}
