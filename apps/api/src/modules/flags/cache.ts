/**
 * The flags each API process holds (B083): every definition at one revision, read from Postgres.
 *
 * - **Fresh:** a change publishes its revision on Redis `flags:inv`; a process whose revision
 *   differs reloads at once (within a message's delivery). As a backstop, every 15 s each process
 *   reads the revision and reloads when it differs, so a lost message costs at most 15 s.
 * - **Postgres down:** the last good set is served, with its revision and so its ETags, for up to
 *   5 minutes after the last successful read. After that `snapshot` answers 503 with
 *   `retry_after_s` until Postgres is back. Before the first load it answers 503 too.
 * - **Broken definitions:** a stored rule this code does not know serves the flag's default; each
 *   load counts such flags in `flags_rule_errors_total`.
 * - Reloads are single-flight: concurrent requests share one read.
 *
 * Owns: freshness. Must not: serve a set older than 5 minutes past its last confirmation.
 */
import { noopMetrics, unavailable, type Logger, type Metrics, type PubSub } from '@centcom/core';
import { readStoredFlag, type EvalFlag } from './definition.js';
import type { FlagRepository } from './repository.js';

/** The channel changes are announced on: `{"rev": n}`. */
export const FLAGS_CHANNEL = 'flags:inv';
/** How often each process confirms its revision. */
export const FLAGS_POLL_MS = 15_000;
/** How long the last good set is served while Postgres cannot be read. */
export const FLAGS_STALE_MS = 5 * 60 * 1000;
/** `retry_after_s` of a 503. */
export const FLAGS_RETRY_AFTER_S = 5;
/** After a failed read, requests answer 503 without trying again for this long. */
export const FLAGS_RETRY_BACKOFF_MS = 1000;

/** Every flag at one revision. */
export interface FlagSnapshot {
  rev: number;
  flags: readonly EvalFlag[];
  byKey: ReadonlyMap<string, EvalFlag>;
}

/** What the cache needs. */
export interface FlagCacheDeps {
  repository: Pick<FlagRepository, 'load' | 'rev'>;
  /** Where `flags:inv` is heard; without it, only polling refreshes. */
  pubsub?: Pick<PubSub, 'subscribe'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Default FLAGS_POLL_MS. */
  pollMs?: number;
  /** Default FLAGS_STALE_MS. */
  staleMs?: number;
  logger?: Logger;
  metrics?: Metrics;
}

/** The details of refusals (GUIDELINES §3.4). */
export const CACHE_DETAILS = Object.freeze({
  unavailable: 'Feature flags are unavailable. Try again shortly.',
} as const);

/** The revision in a `flags:inv` message, or null. */
export function parseFlagsMessage(message: string): number | null {
  try {
    const rev = (JSON.parse(message) as { rev?: unknown } | null)?.rev;
    return typeof rev === 'number' && Number.isSafeInteger(rev) && rev >= 0 ? rev : null;
  } catch {
    return null;
  }
}

/** Flag definitions, cached per process. */
export class FlagCache {
  readonly #clock: () => number;
  readonly #metrics: Metrics;
  readonly #staleMs: number;
  #state: FlagSnapshot | null = null;
  /** When the state was last confirmed current (a load or a matching revision). */
  #confirmedAt = 0;
  /** When a read last failed. */
  #failedAt = Number.NEGATIVE_INFINITY;
  #loading: Promise<FlagSnapshot> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #unsubscribe: (() => Promise<void>) | null = null;

  constructor(private readonly deps: FlagCacheDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
    this.#staleMs = deps.staleMs ?? FLAGS_STALE_MS;
  }

  /** Subscribes to `flags:inv`, starts polling, and loads once (a failure is retried by polling). */
  async start(): Promise<void> {
    if (this.deps.pubsub !== undefined) {
      const unsubscribe = await this.deps.pubsub.subscribe(FLAGS_CHANNEL, (message) => {
        const rev = parseFlagsMessage(message);
        if (rev !== null && rev === this.#state?.rev) return;
        // A read already under way may predate the change: read again if it did.
        void this.reload()
          .then((state) => (rev !== null && state.rev < rev ? this.reload() : state))
          .catch(() => undefined);
      });
      this.#unsubscribe = async () => {
        await unsubscribe();
      };
    }
    this.#timer = setInterval(() => void this.poll(), this.deps.pollMs ?? FLAGS_POLL_MS);
    this.#timer.unref();
    await this.reload().catch(() => undefined);
  }

  /** Stops listening and polling. */
  async stop(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /** The last loaded set, however old; null before the first load (for `isEnabled`). */
  current(): FlagSnapshot | null {
    return this.#state;
  }

  /** The set to answer with: current enough, or reloaded; 503 when neither is possible. */
  async snapshot(): Promise<FlagSnapshot> {
    const state = this.#state;
    const now = this.#clock();
    if (state !== null && now - this.#confirmedAt <= this.#staleMs) return state;
    const refuse = () =>
      unavailable(FLAGS_RETRY_AFTER_S, CACHE_DETAILS.unavailable, {
        cause: new Error('flags unavailable'),
      });
    // Postgres just failed: answer at once rather than queue every request behind it.
    if (now - this.#failedAt < FLAGS_RETRY_BACKOFF_MS) throw refuse();
    try {
      return await this.reload();
    } catch {
      throw refuse();
    }
  }

  /** Confirms the revision, reloading when it differs. Never throws. */
  async poll(): Promise<void> {
    try {
      const rev = await this.deps.repository.rev();
      if (this.#state !== null && rev === this.#state.rev) {
        this.#confirmedAt = this.#clock();
        return;
      }
      await this.reload();
    } catch (err) {
      this.#metrics.counter('flags_refresh_failures_total').inc();
      this.deps.logger?.warn({ error: (err as Error).name }, 'flags.refresh_failed');
    }
  }

  /** Reads every flag; concurrent calls share one read. */
  reload(): Promise<FlagSnapshot> {
    this.#loading ??= (async () => {
      try {
        const { rev, rows } = await this.deps.repository.load();
        const flags = rows.map(readStoredFlag);
        const broken = flags.filter((f) => f.broken).length;
        if (broken > 0) {
          this.#metrics.counter('flags_rule_errors_total').inc(broken);
          this.deps.logger?.error({ broken }, 'flags.unknown_rule');
        }
        const state: FlagSnapshot = { rev, flags, byKey: new Map(flags.map((f) => [f.key, f])) };
        this.#state = state;
        this.#confirmedAt = this.#clock();
        return state;
      } catch (err) {
        this.#failedAt = this.#clock();
        throw err;
      } finally {
        this.#loading = null;
      }
    })();
    return this.#loading;
  }
}
