/**
 * The entitlements cache (B080, CT-ENTITLEMENTS §6): a read-through, per-process cache of each
 * workspace's entitlements, shared by the API and the relay so both enforce from one
 * implementation.
 *
 * - **Freshness:** an entry is served for at most `ttlMs` (≤ 30 s, MAX_ENT_CACHE_TTL_MS), and
 *   never past its value's own expiry (`expiresAt`: a grace period or billing period ending), so a
 *   status that lapses is reloaded the moment it lapses.
 * - **Invalidation:** `invalidate` drops an entry. `listenForInvalidations` does it for every
 *   `{workspace, rev}` message on the entitlements channel, so a change reaches every process
 *   within a message's delivery. A load that started before an invalidation is not cached (a
 *   per-workspace generation).
 * - **Bounded:** at most `maxEntries` workspaces (default 10 000), least recently used out first.
 * - **Failures:** a failed load is never cached. With `staleOnErrorMs` > 0, an entry at most that
 *   much past its freshness may be served when the load fails (counted through `onStaleServed`);
 *   otherwise the error goes to the caller, who fails closed.
 * - Concurrent misses for one workspace share one load.
 *
 * Owns: caching. Must not: decide what is allowed (the callers do), or cache a failure.
 */
import type { PubSub, Unsubscribe } from '../redis/types.js';

/** The longest an entry may be served (CT-ENTITLEMENTS §6: ≤ 30 s). */
export const MAX_ENT_CACHE_TTL_MS = 30_000;
/** Workspaces kept, at most. */
export const DEFAULT_ENT_CACHE_MAX_ENTRIES = 10_000;

/** What the cache needs. */
export interface EntitlementCacheOptions<T> {
  /** Loads a workspace's value; null when there is none (null is not cached). */
  load(workspaceId: string): Promise<T | null>;
  /** 1 to 30 000; default 30 000. */
  ttlMs?: number;
  /** Default 10 000. */
  maxEntries?: number;
  /** How far past freshness an entry may stand in for a failed load; default 0 (never). */
  staleOnErrorMs?: number;
  /** When `value` must be reloaded whatever its age (milliseconds), or null. */
  expiresAt?(value: T): number | null;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Called each time a stale entry is served for a failed load. */
  onStaleServed?(workspaceId: string): void;
}

interface Entry<T> {
  value: T;
  /** Fresh until this instant. */
  freshUntil: number;
}

/** A read-through cache of entitlements per workspace. */
export class EntitlementCache<T> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #loading = new Map<string, Promise<T | null>>();
  readonly #generation = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #staleOnErrorMs: number;
  readonly #clock: () => number;

  constructor(private readonly options: EntitlementCacheOptions<T>) {
    const ttl = options.ttlMs ?? MAX_ENT_CACHE_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_ENT_CACHE_TTL_MS) {
      throw new RangeError(`EntitlementCache: ttlMs must be 1 to ${MAX_ENT_CACHE_TTL_MS}`);
    }
    const max = options.maxEntries ?? DEFAULT_ENT_CACHE_MAX_ENTRIES;
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new RangeError('EntitlementCache: maxEntries must be a whole number of 1 or more');
    }
    const stale = options.staleOnErrorMs ?? 0;
    if (!Number.isSafeInteger(stale) || stale < 0) {
      throw new RangeError('EntitlementCache: staleOnErrorMs must be 0 or more');
    }
    this.#ttlMs = ttl;
    this.#maxEntries = max;
    this.#staleOnErrorMs = stale;
    this.#clock = options.clock ?? Date.now;
  }

  /** Entries held. */
  get size(): number {
    return this.#entries.size;
  }

  /** The workspace's value: from the cache while fresh, else loaded. */
  get(workspaceId: string): Promise<T | null> {
    const now = this.#clock();
    const entry = this.#entries.get(workspaceId);
    if (entry !== undefined && now < entry.freshUntil) {
      // Most recently used goes to the end.
      this.#entries.delete(workspaceId);
      this.#entries.set(workspaceId, entry);
      return Promise.resolve(entry.value);
    }
    const running = this.#loading.get(workspaceId);
    if (running !== undefined) return running;
    const load = this.#load(workspaceId, entry).finally(() => {
      this.#loading.delete(workspaceId);
    });
    this.#loading.set(workspaceId, load);
    return load;
  }

  async #load(workspaceId: string, previous: Entry<T> | undefined): Promise<T | null> {
    const generation = this.#generation.get(workspaceId) ?? 0;
    let value: T | null;
    try {
      value = await this.options.load(workspaceId);
    } catch (err) {
      const now = this.#clock();
      if (
        previous !== undefined &&
        this.#staleOnErrorMs > 0 &&
        now < previous.freshUntil + this.#staleOnErrorMs
      ) {
        this.options.onStaleServed?.(workspaceId);
        return previous.value;
      }
      throw err;
    }
    if (value === null) {
      this.#entries.delete(workspaceId);
      return null;
    }
    // An invalidation while loading: the value may predate the change, so it is not kept.
    if ((this.#generation.get(workspaceId) ?? 0) !== generation) return value;
    const now = this.#clock();
    const expires = this.options.expiresAt?.(value) ?? null;
    const freshUntil = Math.min(now + this.#ttlMs, expires ?? Number.POSITIVE_INFINITY);
    this.#entries.delete(workspaceId);
    this.#entries.set(workspaceId, { value, freshUntil });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return value;
  }

  /** Drops the workspace's entry; a load already running is not kept. */
  invalidate(workspaceId: string): void {
    this.#entries.delete(workspaceId);
    this.#generation.set(workspaceId, (this.#generation.get(workspaceId) ?? 0) + 1);
  }

  /** Drops everything. */
  clear(): void {
    for (const workspaceId of this.#entries.keys()) this.invalidate(workspaceId);
  }
}

/** An invalidation message: `{workspace, rev}` as JSON. */
export interface InvalidationMessage {
  workspace: string;
  rev: number;
}

/** Parses an invalidation message; null for anything else. */
export function parseInvalidation(message: string): InvalidationMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { workspace, rev } = parsed as Record<string, unknown>;
  if (typeof workspace !== 'string' || !/^wsp_[0-9A-HJKMNP-TV-Z]{26}$/.test(workspace)) return null;
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev)) return null;
  return { workspace, rev };
}

/** Drops a cache entry for every valid message on `channel`; resolves once subscribed. */
export function listenForInvalidations(
  pubsub: Pick<PubSub, 'subscribe'>,
  channel: string,
  cache: Pick<EntitlementCache<unknown>, 'invalidate'>,
): Promise<Unsubscribe> {
  return pubsub.subscribe(channel, (message) => {
    const parsed = parseInvalidation(message);
    if (parsed !== null) cache.invalidate(parsed.workspace);
  });
}
