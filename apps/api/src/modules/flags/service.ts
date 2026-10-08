/**
 * Feature flags (B083, CT-API-FLAGS): what `GET /v1/flags` answers, `isEnabled` for server code,
 * and the admin API B087's tooling calls.
 *
 * - **Answers** come from the process's cache (`cache.ts`), never from Postgres on the request
 *   path. The body is `{flags, rev, ttl_s}`; the ETag names the revision and a digest of the body,
 *   so it changes with every flag change and differs between callers who see different flags.
 *   Authenticated answers are `private, max-age=<FLAGS_TTL_S>`; anonymous ones, which hold no
 *   per-user data, `public, max-age=30`.
 * - **No targeting leaks:** the body holds keys and values only, never rules, rollout buckets or
 *   workspace ids, and never a `server_only` flag.
 * - **Flags never grant paid features:** they are configuration. Entitlements (CT-ENTITLEMENTS)
 *   and RBAC stay the only gates; a plan rule only narrows who sees a flag.
 * - **Admin:** `setFlag` and `deleteFlag` check the definition, change it and the revision and
 *   write `flag.set` / `flag.delete` (actor, the flag's key, the new revision, and a hash of the
 *   previous definition) in one transaction, then announce the revision on `flags:inv`. A
 *   definition over FLAGS_MAX_VALUE_BYTES, the flag after FLAGS_MAX_COUNT, or one that would take
 *   the answer past 64 KiB is a 422.
 *
 * Owns: the answer and the admin rules. Must not: expose a rule, or change a flag unaudited.
 */
import { createHash } from 'node:crypto';
import {
  canonicalJson,
  noopMetrics,
  notFound,
  unavailable,
  validationFailed,
  type Actor,
  type AuditActor,
  type AuditEmitter,
  type Logger,
  type Metrics,
  type PubSub,
} from '@centcom/core';
import { isConnectionError } from '@centcom/db';
import { FLAG_DELETE_ACTION, FLAG_SET_ACTION, type FlagAuditAction } from './actions.js';
import { FLAGS_CHANNEL, type FlagCache } from './cache.js';
import type { FlagsConfig } from './config.js';
import {
  checkFlagDef,
  FLAG_KEY,
  type FlagType,
  type FlagValue,
  type StoredFlagDef,
} from './definition.js';
import { evaluateFlags, isEnabledIn, type EvalContext, type FlagSet } from './evaluate.js';
import { FlagLimitError, type FlagRepository, type StoredRow } from './repository.js';

/** The largest `GET /v1/flags` body (card B083: at most 64 KiB). */
export const MAX_FLAGS_BODY_BYTES = 64 * 1024;
/** `ttl_s` and `max-age` of an anonymous answer. */
export const ANONYMOUS_TTL_S = 30;

/** CT-API-FLAGS `Flags`. */
export interface FlagsBody {
  flags: FlagSet;
  rev: number;
  ttl_s: number;
}

/** An answer and its headers. */
export interface FlagsAnswer {
  body: FlagsBody;
  etag: string;
  cacheControl: string;
}

/** The details of refusals (GUIDELINES §3.4). */
export const FLAG_DETAILS = Object.freeze({
  notFound: 'There is no such flag.',
  tooMany: 'The flag limit is reached; delete a flag first.',
  tooBig: 'The flags would no longer fit in one response; shrink or delete some.',
  unavailable: 'Feature flags cannot be changed right now. Try again shortly.',
} as const);

/** The ETag of an answer: `"f<rev>.<16 base64url characters of its body's sha256>"`. */
export function flagsEtag(body: FlagsBody): string {
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('base64url');
  return `"f${body.rev}.${digest.slice(0, 16)}"`;
}

/** What answering needs. */
export interface FlagServiceDeps {
  cache: Pick<FlagCache, 'snapshot' | 'current'>;
  config: Pick<FlagsConfig, 'ttlS'>;
}

/** Answers clients, and server code's `isEnabled`. */
export class FlagService {
  constructor(private readonly deps: FlagServiceDeps) {}

  /** The flags of a caller in `ctx`; `authenticated` picks the cache policy. */
  async answer(ctx: EvalContext, authenticated: boolean): Promise<FlagsAnswer> {
    const snapshot = await this.deps.cache.snapshot();
    const ttl = authenticated ? this.deps.config.ttlS : ANONYMOUS_TTL_S;
    const body: FlagsBody = {
      flags: evaluateFlags(ctx, snapshot.flags),
      rev: snapshot.rev,
      ttl_s: ttl,
    };
    return {
      body,
      etag: flagsEtag(body),
      cacheControl: authenticated ? `private, max-age=${ttl}` : `public, max-age=${ttl}`,
    };
  }

  /** For server code: whether boolean flag `key` is on for `ctx`; false before flags are loaded. */
  isEnabled(key: string, ctx: EvalContext): boolean {
    const snapshot = this.deps.cache.current();
    return snapshot !== null && isEnabledIn(snapshot.byKey, key, ctx);
  }
}

/** What the admin API needs. */
export interface FlagAdminDeps {
  repository: FlagRepository;
  /** Writes `flag.set` / `flag.delete` in the change's transaction (FLAG_AUDIT_ACTIONS). */
  emitter: Pick<AuditEmitter<FlagAuditAction>, 'emit'>;
  /** Where changes are announced (`flags:inv`). */
  pubsub: Pick<PubSub, 'publish'>;
  config: Pick<FlagsConfig, 'maxCount' | 'maxValueBytes'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

const auditActor = (actor: Actor): AuditActor =>
  actor.kind === 'user' ? { type: 'user', id: actor.userId } : { type: 'api_key', id: actor.keyId };

/** Hex SHA-256 of a stored definition (what the audit records instead of the value). */
export function definitionHash(row: StoredRow): string {
  const def = {
    key: row.key,
    type: row.type,
    value: row.value,
    default: row.default_value,
    public: row.public,
    server_only: row.server_only,
    kill: row.kill,
    rules: row.rules,
  };
  return createHash('sha256').update(canonicalJson(def), 'utf8').digest('hex');
}

/** A stored row as an admin reads it. */
function storedDef(row: StoredRow): StoredFlagDef {
  return {
    key: row.key,
    type: row.type as FlagType,
    value: row.value as FlagValue,
    default: row.default_value as FlagValue,
    public: row.public,
    server_only: row.server_only,
    kill: row.kill,
    rules: (Array.isArray(row.rules) ? row.rules : []) as StoredFlagDef['rules'],
    updated_by: row.updated_by,
    updated_at: row.updated_at.toISOString(),
  };
}

/** The admin API (B087's tooling and B088 call it; there is no HTTP route here). */
export class FlagAdmin {
  readonly #clock: () => number;
  readonly #metrics: Metrics;

  constructor(private readonly deps: FlagAdminDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** Creates or replaces a flag; returns the new revision. 422 for a bad or oversized definition. */
  async setFlag(input: unknown, actor: Actor): Promise<{ rev: number }> {
    const def = checkFlagDef(input, { maxValueBytes: this.deps.config.maxValueBytes });
    const by = auditActor(actor);
    let result: { rev: number };
    try {
      result = await this.deps.repository.upsert(
        def,
        by.id,
        new Date(this.#clock()),
        { maxCount: this.deps.config.maxCount, maxBodyBytes: MAX_FLAGS_BODY_BYTES - 64 },
        (trx, previous, rev) =>
          this.deps.emitter.emit(trx, {
            workspaceId: null,
            actor: by,
            action: FLAG_SET_ACTION,
            outcome: 'success',
            meta: {
              flag: def.key,
              rev,
              prev_hash: previous === null ? null : definitionHash(previous),
              created: previous === null,
              kill: def.kill,
            },
          }),
      );
    } catch (err) {
      throw this.#failure(err);
    }
    await this.#announce(result.rev);
    return { rev: result.rev };
  }

  /** Deletes a flag; returns the new revision. 404 when there is none. */
  async deleteFlag(key: string, actor: Actor): Promise<{ rev: number }> {
    if (!FLAG_KEY.test(key)) throw notFound(FLAG_DETAILS.notFound);
    const by = auditActor(actor);
    let result: { rev: number } | null;
    try {
      result = await this.deps.repository.remove(key, (trx, previous, rev) =>
        this.deps.emitter.emit(trx, {
          workspaceId: null,
          actor: by,
          action: FLAG_DELETE_ACTION,
          outcome: 'success',
          meta: { flag: key, rev, prev_hash: previous === null ? null : definitionHash(previous) },
        }),
      );
    } catch (err) {
      throw this.#failure(err);
    }
    if (result === null) throw notFound(FLAG_DETAILS.notFound);
    await this.#announce(result.rev);
    return { rev: result.rev };
  }

  /** Every flag, complete, by key. */
  async listFlags(): Promise<StoredFlagDef[]> {
    let rows: StoredRow[];
    try {
      rows = (await this.deps.repository.load()).rows;
    } catch (err) {
      throw this.#failure(err);
    }
    return rows.map(storedDef).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** Tells every process about revision `rev`; a lost message is caught by their polling. */
  async #announce(rev: number): Promise<void> {
    try {
      await this.deps.pubsub.publish(FLAGS_CHANNEL, JSON.stringify({ rev }));
    } catch (err) {
      this.#metrics.counter('flags_publish_failures_total').inc();
      this.deps.logger?.warn({ rev, error: (err as Error).name }, 'flags.publish_failed');
    }
  }

  #failure(err: unknown): unknown {
    if (err instanceof FlagLimitError) {
      return validationFailed(
        [
          err.limit === 'count'
            ? {
                pointer: '/key',
                code: 'too_many',
                detail: `at most ${this.deps.config.maxCount} flags`,
              }
            : { pointer: '/value', code: 'too_long', detail: 'the flags would pass 64 KiB' },
        ],
        err.limit === 'count' ? FLAG_DETAILS.tooMany : FLAG_DETAILS.tooBig,
      );
    }
    const code = (err as { code?: unknown } | null)?.code;
    if (isConnectionError(err) || code === '57014') {
      return unavailable(1, FLAG_DETAILS.unavailable, { cause: new Error('database unavailable') });
    }
    return err;
  }
}
