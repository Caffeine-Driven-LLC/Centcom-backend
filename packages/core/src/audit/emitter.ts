/**
 * The audit emitter (B036, CT-API-AUDIT): `emit(trx, event)` writes an event in the caller's
 * transaction, so the row commits or rolls back with the change it records; `emitDetached(event)`
 * queues one for paths without a transaction (the relay, refusals), written in the background;
 * `flush(timeoutMs)` writes what is queued, at shutdown.
 *
 * - Every event is checked first (event.ts): its action is in the catalogue, its ids are CT-IDS
 *   ids, and its meta is cut to the action's allowlist with secret-like values redacted.
 * - Detached events wait in a queue of at most AUDIT_QUEUE_MAX (1 000); a full queue drops its
 *   oldest event. A batch of up to 100 is written every 250 ms. A failed write keeps its events
 *   and is retried with exponential backoff and jitter (up to 10 s); a batch the database refuses
 *   (a deleted workspace, say) is written row by row and only the refused rows are dropped.
 * - Every lost event is counted in `audit_events_dropped_total{reason}` (`invalid`, `overflow`,
 *   `rejected`) and logged as `audit.dropped`; overflow at most every 10 s, with its count.
 *
 * Owns: the checks, the inserts, the queue. Must not: update or delete rows (the table refuses it,
 * migration 20260102000600), throw from emitDetached, or log event contents (logs carry actions,
 * counts and error codes).
 */
import { performance } from 'node:perf_hooks';
import { newId } from '@centcom/contracts';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type QueryResult,
} from 'kysely';
import type { Logger } from '../log/logger.js';
import { noopMetrics, type Counter, type Histogram, type Metrics } from '../log/metrics.js';
import { AUDIT_ACTIONS, type AuditAction, type AuditCatalog } from './actions.js';
import { toAuditRow, type AuditEvent } from './event.js';
import type { AuditDatabase, NewAuditRow } from './table.js';

/** Most detached events waiting to be written; beyond it the oldest is dropped. */
export const AUDIT_QUEUE_MAX = 1000;
/** Most events per detached write. */
export const AUDIT_BATCH_MAX = 100;
/** Pause between detached writes. */
export const AUDIT_BATCH_INTERVAL_MS = 250;
/** Longest pause before retrying a failed write. */
export const AUDIT_RETRY_MAX_MS = 10_000;
/** Overflow is logged at most this often (every dropped event is still counted). */
export const AUDIT_DROP_LOG_INTERVAL_MS = 10_000;
/** Upper bounds of the `audit_emit_latency_ms` buckets. */
export const AUDIT_LATENCY_BUCKETS_MS: readonly number[] = Object.freeze([
  0.5, 1, 2, 5, 10, 25, 50, 100, 250, 1000,
]);

/** What the emitter needs of a Kysely instance or transaction, whatever its database type. */
export interface AuditDb {
  readonly isTransaction: boolean;
  executeQuery<R>(query: CompiledQuery<R>): Promise<QueryResult<R>>;
}

/** Writes audit events. */
export interface AuditEmitter<A extends string = AuditAction> {
  /**
   * Writes `event` in `trx`, the transaction of the change it records: both commit, or neither
   * does. Resolves to the event's `aud_` id. Rejects before writing with InvalidAuditEventError
   * (InvalidAuditActionError for an unknown action) for an event it refuses, and with the
   * database's error when the insert fails; either way the caller's transaction should fail.
   */
  emit(trx: AuditDb, event: AuditEvent<A>): Promise<string>;
  /**
   * Queues `event` for a background write, for paths without a transaction. Never throws: an
   * event it refuses, or one pushed out of a full queue, is counted and logged instead.
   */
  emitDetached(event: AuditEvent<A>): void;
  /**
   * Writes every queued event, retrying while the database is down, for at most `timeoutMs`.
   * Never rejects; events still queued then are logged (`audit.flush_incomplete`) and stay queued.
   */
  flush(timeoutMs: number): Promise<void>;
}

/** Options for `createAuditEmitter`. */
export interface AuditEmitterOptions<A extends string> {
  /** Where detached events are written: the pool (a Kysely instance), not a transaction. */
  db: AuditDb;
  /** The actions accepted; default AUDIT_ACTIONS (extend it with `defineAuditActions`). */
  actions?: AuditCatalog<A>;
  /** Writes `audit.*` lines: actions, counts and error codes, never event contents. */
  logger?: Logger;
  /**
   * Receives `audit_events_written_total{path}`, `audit_events_dropped_total{reason}` and
   * `audit_emit_latency_ms{path}` (`path`: `emit` or `detached`).
   */
  metrics?: Metrics;
  /** Milliseconds since the epoch, for `created_at`, ids and flush deadlines; default Date.now. */
  clock?: () => number;
}

/** Why a detached event was lost. */
type DropReason = 'invalid' | 'overflow' | 'rejected';

/** Compiles the inserts. It never connects (DummyDriver): the caller's Kysely runs them. */
const builder = new Kysely<AuditDatabase>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const insertOne = (row: NewAuditRow): CompiledQuery =>
  builder.insertInto('audit_events').values(row).compile();

/** Detached rows; a retried batch whose first attempt landed after all skips the rows it wrote. */
const insertBatch = (rows: readonly NewAuditRow[]): CompiledQuery =>
  builder
    .insertInto('audit_events')
    .values(rows)
    .onConflict((oc) => oc.column('id').doNothing())
    .compile();

/** The SQLSTATE (or Node error code) of an error, for logs. */
const errorCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
};

/** A data exception or constraint violation (SQLSTATE classes 22 and 23): the row, not the database. */
const isRowError = (err: unknown): boolean => /^2[23][0-9A-Z]{3}$/.test(errorCode(err));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** `promise`'s value, or undefined when `ms` pass first. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, ms, undefined);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

class Emitter<A extends string> implements AuditEmitter<A> {
  readonly #db: AuditDb;
  readonly #actions: AuditCatalog<A>;
  readonly #logger: Logger | undefined;
  readonly #metrics: Metrics;
  readonly #clock: () => number;
  readonly #latency: Histogram;
  readonly #written: Readonly<Record<'emit' | 'detached', Counter>>;
  /** Detached rows not yet handed to the database, oldest first. */
  readonly #queue: NewAuditRow[] = [];
  /** Rows of the write in progress (they count against AUDIT_QUEUE_MAX too). */
  #inFlight = 0;
  #writing: Promise<boolean> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #flushing = 0;
  /** Failed writes in a row; sets the retry pause. */
  #failures = 0;
  #overflowUnlogged = 0;
  #overflowLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(options: AuditEmitterOptions<A>) {
    if (options.db.isTransaction) {
      throw new TypeError('createAuditEmitter: db must be the pool, not a transaction');
    }
    this.#db = options.db;
    this.#actions = options.actions ?? (AUDIT_ACTIONS as AuditCatalog<string> as AuditCatalog<A>);
    this.#logger = options.logger;
    this.#metrics = options.metrics ?? noopMetrics;
    this.#clock = options.clock ?? Date.now;
    this.#latency = this.#metrics.histogram('audit_emit_latency_ms', AUDIT_LATENCY_BUCKETS_MS);
    this.#written = {
      emit: this.#metrics.counter('audit_events_written_total', { path: 'emit' }),
      detached: this.#metrics.counter('audit_events_written_total', { path: 'detached' }),
    };
  }

  /** The row of `event`, with a new id and the current time; throws for an event it refuses. */
  #row(event: AuditEvent<A>): NewAuditRow {
    const at = this.#clock();
    return toAuditRow(event, this.#actions, newId('aud', { now: () => at }), new Date(at));
  }

  async emit(trx: AuditDb, event: AuditEvent<A>): Promise<string> {
    if ((trx as AuditDb | undefined)?.isTransaction !== true) {
      throw new TypeError(
        'emit: pass the transaction of the change the event records (emitDetached writes outside one)',
      );
    }
    const started = performance.now();
    const row = this.#row(event);
    await trx.executeQuery(insertOne(row));
    // The row is in the caller's transaction: a broken metrics backend must not fail it now.
    this.#quietly(() => {
      this.#latency.observe(performance.now() - started, { path: 'emit' });
      this.#written.emit.inc();
    });
    return row.id;
  }

  emitDetached(event: AuditEvent<A>): void {
    try {
      let row: NewAuditRow;
      try {
        row = this.#row(event);
      } catch (err) {
        const action = (event as { action?: unknown } | null)?.action;
        const known = typeof action === 'string' && Object.hasOwn(this.#actions, action);
        this.#drop('invalid', 1, { err, ...(known ? { action } : {}) });
        return;
      }
      const full = this.#queue.length + this.#inFlight >= AUDIT_QUEUE_MAX;
      const oldest = full ? this.#queue.shift() : undefined;
      this.#queue.push(row);
      this.#schedule();
      if (oldest !== undefined) this.#drop('overflow', 1, {});
    } catch {
      // Never throws: a failing logger or metrics backend must not break the caller.
    }
  }

  async flush(timeoutMs: number): Promise<void> {
    const deadline = this.#clock() + (Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0);
    this.#flushing += 1;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    try {
      while (this.#queue.length > 0 || this.#writing !== undefined) {
        const left = deadline - this.#clock();
        if (left <= 0) break;
        const ok = await within(this.#writeBatch(), left);
        if (ok === false) {
          const pause = Math.min(this.#retryDelay(), deadline - this.#clock());
          if (pause > 0) await sleep(pause);
        }
      }
    } catch {
      // Never rejects: what could not be written is reported below.
    } finally {
      this.#flushing -= 1;
      const pending = this.#queue.length + this.#inFlight;
      this.#quietly(() => {
        if (pending > 0) this.#logger?.error({ pending }, 'audit.flush_incomplete');
        this.#reportOverflow(true);
      });
      this.#schedule();
    }
  }

  /** Counts lost events and logs them: refusals each time, overflow at most every 10 s. */
  #drop(reason: DropReason, count: number, fields: Record<string, unknown>): void {
    this.#metrics.counter('audit_events_dropped_total', { reason }).inc(count);
    if (reason === 'overflow') {
      this.#overflowUnlogged += count;
      this.#reportOverflow(false);
      return;
    }
    this.#logger?.error({ reason, dropped: count, ...fields }, 'audit.dropped');
  }

  /** Logs the overflow drops not logged yet, if 10 s have passed since the last such line (or `force`). */
  #reportOverflow(force: boolean): void {
    if (this.#overflowUnlogged === 0) return;
    const now = this.#clock();
    if (!force && now - this.#overflowLoggedAt < AUDIT_DROP_LOG_INTERVAL_MS) return;
    this.#logger?.error(
      {
        reason: 'overflow',
        dropped: this.#overflowUnlogged,
        pending: this.#queue.length + this.#inFlight,
      },
      'audit.dropped',
    );
    this.#overflowUnlogged = 0;
    this.#overflowLoggedAt = now;
  }

  /** Exponential backoff from the batch interval, capped, with jitter (half to all of it). */
  #retryDelay(): number {
    const base = Math.min(AUDIT_RETRY_MAX_MS, AUDIT_BATCH_INTERVAL_MS * 2 ** this.#failures);
    return Math.round(base * (0.5 + Math.random() / 2));
  }

  /** Sets the timer for the next background write, unless one is due, running or flush drives. */
  #schedule(): void {
    if (this.#timer !== undefined || this.#writing !== undefined) return;
    if (this.#flushing > 0 || this.#queue.length === 0) return;
    const delay = this.#failures === 0 ? AUDIT_BATCH_INTERVAL_MS : this.#retryDelay();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#writeBatch();
    }, delay);
    // Queued audit events alone do not keep a process alive; shutdown calls flush.
    this.#timer.unref();
  }

  /** Writes the next batch (one write at a time); resolves to whether it succeeded. */
  #writeBatch(): Promise<boolean> {
    if (this.#writing !== undefined) return this.#writing;
    if (this.#queue.length === 0) return Promise.resolve(true);
    const batch = this.#queue.splice(0, AUDIT_BATCH_MAX);
    this.#inFlight = batch.length;
    const writing = this.#write(batch).then((ok) => {
      this.#writing = undefined;
      this.#schedule();
      return ok;
    });
    this.#writing = writing;
    return writing;
  }

  /**
   * Inserts `batch`. When the database refuses a row, writes the rows one at a time and drops
   * only the refused ones; when it fails otherwise, puts the unwritten rows back at the head of
   * the queue (they are the oldest) for a later attempt. Reporting cannot change the outcome.
   */
  async #write(batch: NewAuditRow[]): Promise<boolean> {
    const started = performance.now();
    let written = 0;
    let unwritten: NewAuditRow[] = [];
    let failure: unknown;
    try {
      await this.#db.executeQuery(insertBatch(batch));
      written = batch.length;
    } catch (err) {
      if (isRowError(err)) {
        for (const [i, row] of batch.entries()) {
          try {
            await this.#db.executeQuery(insertBatch([row]));
            written += 1;
          } catch (rowErr) {
            if (!isRowError(rowErr)) {
              [unwritten, failure] = [batch.slice(i), rowErr];
              break;
            }
            this.#quietly(() =>
              this.#drop('rejected', 1, { action: row.action, error_code: errorCode(rowErr) }),
            );
          }
        }
      } else {
        [unwritten, failure] = [batch, err];
      }
    }
    this.#inFlight = 0;
    this.#queue.unshift(...unwritten);
    this.#failures = unwritten.length === 0 ? 0 : this.#failures + 1;
    this.#quietly(() => {
      if (written > 0) this.#written.detached.inc(written);
      if (unwritten.length === 0) {
        this.#latency.observe(performance.now() - started, { path: 'detached' });
      } else {
        this.#logger?.warn(
          { error_code: errorCode(failure), attempt: this.#failures, pending: this.#queue.length },
          'audit.write_failed',
        );
      }
      this.#reportOverflow(this.#queue.length === 0);
    });
    return unwritten.length === 0;
  }

  /** Runs reporting code whose failure (a broken logger or metrics backend) must not matter. */
  #quietly(report: () => void): void {
    try {
      report();
    } catch {
      // Deliberately ignored: the queue's state is already settled.
    }
  }
}

/** An audit emitter writing to `options.db`. */
export function createAuditEmitter<A extends string = AuditAction>(
  options: AuditEmitterOptions<A>,
): AuditEmitter<A> {
  return new Emitter(options);
}
