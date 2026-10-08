/**
 * Test helpers for entitlements (B069): an in-memory EntitlementRepository with the Postgres
 * repository's semantics (live workspaces only, a default row written on first lock, transactions
 * that run one at a time and roll back on a throw), a catalog built from the seed, a publisher
 * that records and can fail, and the entitlement routes on B027's test app.
 */
import { newId } from '@centcom/contracts';
import type { FastifyInstance } from 'fastify';
import {
  defaultEntitlement,
  EntitlementService,
  PLAN_IDS,
  SEED_PLANS,
  type CatalogPlan,
  type EntitlementRepository,
  type EntitlementServiceOptions,
  type EntitlementTx,
  type SeedPlans,
  type StoredEntitlement,
  type UsageReaderPort,
} from '../../src/modules/entitlements/index.js';
import { entitlementRoutes } from '../../src/routes/entitlements/index.js';
import { planRoutes } from '../../src/routes/plans/index.js';
import { recordingMetrics, captureLogger } from '../helpers.js';
import {
  workspacesApp,
  type MemoryWorkspaceStore,
  type WorkspacesApp,
} from '../modules/workspaces/helpers.js';

/** A catalog as the `plans`/`plan_limits` rows would give `seed`. */
export const catalogOf = (seed: SeedPlans = SEED_PLANS): CatalogPlan[] =>
  PLAN_IDS.map((id) => ({ id, name: seed[id].name, limits: { ...seed[id].limits } }));

/** The in-memory repository; its state is public for tests to look at and arrange. */
export class MemoryEntitlementRepository implements EntitlementRepository {
  catalog: CatalogPlan[] = catalogOf();
  rows = new Map<string, StoredEntitlement>();
  /** Calls to `plans()`. */
  planReads = 0;
  /** When set, `plans()` rejects. */
  failPlans = false;
  /** Rows written by `write` (not by the first lock). */
  writes = 0;
  #turn: Promise<unknown> = Promise.resolve();

  /** `isLive(id)`: whether workspace `id` exists and is not deleted. */
  constructor(readonly isLive: (workspaceId: string) => boolean) {}

  plans(): Promise<CatalogPlan[]> {
    this.planReads += 1;
    if (this.failPlans) return Promise.reject(new Error('db down'));
    return Promise.resolve(structuredClone(this.catalog));
  }

  find(workspaceId: string): Promise<StoredEntitlement | null> {
    if (!this.isLive(workspaceId)) return Promise.resolve(null);
    const row = this.rows.get(workspaceId);
    return Promise.resolve(row === undefined ? defaultEntitlement(workspaceId) : copy(row));
  }

  transaction<T>(fn: (tx: EntitlementTx) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const saved = new Map([...this.rows].map(([k, v]) => [k, copy(v)]));
      const savedWrites = this.writes;
      const tx: EntitlementTx = {
        lock: (workspaceId) => {
          if (!this.isLive(workspaceId)) return Promise.resolve(null);
          if (!this.rows.has(workspaceId)) {
            this.rows.set(workspaceId, { ...defaultEntitlement(workspaceId), stored: true });
          }
          return Promise.resolve(copy(this.rows.get(workspaceId) as StoredEntitlement));
        },
        write: (workspaceId, row) => {
          if (!this.rows.has(workspaceId)) throw new Error('write: the row is not locked');
          this.writes += 1;
          this.rows.set(workspaceId, { ...copy(row), workspaceId, stored: true });
          return Promise.resolve();
        },
      };
      try {
        return await fn(tx);
      } catch (err) {
        this.rows = saved;
        this.writes = savedWrites;
        throw err;
      }
    };
    const result = this.#turn.then(run, run);
    this.#turn = result.catch(() => undefined);
    return result;
  }

  deleteForWorkspace(workspaceId: string): Promise<number> {
    if (this.isLive(workspaceId)) return Promise.resolve(0);
    return Promise.resolve(this.rows.delete(workspaceId) ? 1 : 0);
  }
}

const copy = <T extends object>(row: T): T => {
  const out = { ...row } as Record<string, unknown>;
  for (const [key, value] of Object.entries(out)) {
    if (value instanceof Date) out[key] = new Date(value);
    else if (Buffer.isBuffer(value)) out[key] = Buffer.from(value);
    else if (value !== null && typeof value === 'object') out[key] = copy(value);
  }
  return out as T;
};

/** A publisher that records, and fails its next `failNext` calls. */
export class RecordingPublisher {
  published: { channel: string; message: string }[] = [];
  attempts = 0;
  failNext = 0;
  publish(channel: string, message: string): Promise<void> {
    this.attempts += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new Error('redis down'));
    }
    this.published.push({ channel, message });
    return Promise.resolve();
  }
  /** The `{workspace, rev}` payloads published. */
  payloads(): { workspace: string; rev: number }[] {
    return this.published.map((p) => JSON.parse(p.message) as { workspace: string; rev: number });
  }
}

/** A controllable clock, in milliseconds. */
export class Clock {
  constructor(public now = Date.UTC(2026, 9, 8, 12, 0, 0)) {}
  readonly read = (): number => this.now;
  /** Moves on `ms` milliseconds. */
  advance(ms: number): void {
    this.now += ms;
  }
}

/** A service over a fresh in-memory repository whose live workspaces are `live`. */
export function serviceHarness(
  options: Partial<Omit<EntitlementServiceOptions, 'repository' | 'events' | 'clock'>> = {},
): {
  service: EntitlementService;
  repository: MemoryEntitlementRepository;
  events: RecordingPublisher;
  clock: Clock;
  live: Set<string>;
  captured: ReturnType<typeof captureLogger>;
  recorded: ReturnType<typeof recordingMetrics>;
  /** Adds a live workspace; returns its id. */
  workspace(): string;
} {
  const live = new Set<string>();
  const repository = new MemoryEntitlementRepository((id) => live.has(id));
  const events = new RecordingPublisher();
  const clock = new Clock();
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const service = new EntitlementService({
    repository,
    events,
    clock: clock.read,
    logger: captured.logger,
    metrics: recorded.metrics,
    ...options,
  });
  return {
    service,
    repository,
    events,
    clock,
    live,
    captured,
    recorded,
    workspace: () => {
      const id = newId('wsp');
      live.add(id);
      return id;
    },
  };
}

/** B027's test app with the plan and entitlement routes over an in-memory repository. */
export async function entitlementsApp(options: { usage?: UsageReaderPort } = {}): Promise<
  WorkspacesApp & {
    entitlements: EntitlementService;
    repository: MemoryEntitlementRepository;
    publisher: RecordingPublisher;
    clock: Clock;
  }
> {
  const publisher = new RecordingPublisher();
  const clock = new Clock();
  // The workspace store is made inside `workspacesApp`; requests reach it only once it is set.
  const ref: { store?: MemoryWorkspaceStore } = {};
  const repository = new MemoryEntitlementRepository(
    (id) => ref.store?.workspaces.get(id)?.deletedAt === null,
  );
  const entitlements = new EntitlementService({
    repository,
    events: publisher,
    clock: clock.read,
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  });
  const base = await workspacesApp({
    beforeReady: async (app: FastifyInstance) => {
      await app.register(planRoutes, { service: entitlements });
      await app.register(entitlementRoutes, { service: entitlements });
    },
  });
  ref.store = base.store;
  return { ...base, entitlements, repository, publisher, clock };
}
