/**
 * The export runner (B082), which the worker's `audit-export` job calls:
 *
 * - `run(id)` marks the export running, removes whatever an earlier attempt left at its object key,
 *   then streams the matching events, newest first and in keyset batches (never the whole result
 *   in memory), through the CSV or JSON writer (and gzip when asked) into a temporary file, hashing
 *   it on the way. The finished file is uploaded in one PUT and the export marked ready, its file
 *   kept for AUDIT_EXPORT_RETAIN_H. The temporary file is always removed.
 * - Row cap: on the event after AUDIT_EXPORT_MAX_ROWS the run stops and the export fails with
 *   `row_cap_exceeded`, without a retry.
 * - Any other error is thrown for the queue to retry (3 attempts, 10 s apart). The last attempt
 *   first marks the export failed: `storage_unavailable` when the object store failed, else
 *   `internal`, and removes any object it left.
 * - A run of an export that is finished, failed or gone does nothing.
 * - `sweep(now)` deletes the files of exports past their expiry and marks them expired, fails
 *   (`internal`) exports still unfinished an hour after their request (their job is gone), and
 *   returns the exports left pending for over 2 minutes (their job was never queued) to queue again.
 *
 * Owns: producing and expiring export files. Must not: hold an export in memory, or leave a
 * partial object behind as the export's file.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import { exportWriter } from './csv.js';
import type { AuditFilters } from './filters.js';
import { ObjectStoreError, type LocalFile, type ObjectStore } from './object-store.js';
import { presentEvent } from './present.js';
import type { AuditRepository, BatchKey, EventScope, ExportRow } from './repository.js';
import { exportObjectKey } from './service.js';

/** Events read per statement. */
export const EXPORT_BATCH_SIZE = 5_000;
/** A pending export older than this has no queued job (the enqueue failed): it is queued again. */
export const STALE_PENDING_MS = 2 * 60 * 1000;
/**
 * An export unfinished this long after its request will not finish: its job is gone (every attempt
 * failed before the export could be marked, as with Postgres down). It is failed as `internal`.
 */
export const STUCK_EXPORT_MS = 60 * 60 * 1000;
/** Exports a sweep handles at most, per kind. */
export const SWEEP_LIMIT = 100;

/** What the runner needs. */
export interface AuditExportRunnerDeps {
  repository: AuditRepository;
  store: Pick<ObjectStore, 'putFile' | 'delete'>;
  /** AUDIT_EXPORT_MAX_ROWS. */
  maxRows: number;
  /** AUDIT_EXPORT_RETAIN_H, in milliseconds. */
  retainMs: number;
  /** Rows per statement; default EXPORT_BATCH_SIZE. */
  batchSize?: number;
  /** Where files are written before upload; default the OS's temporary directory. */
  tmpDir?: string;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** How a run ended. */
export type RunOutcome = 'ready' | 'row_cap_exceeded' | 'skipped';

/** What a sweep did. */
export interface SweepResult {
  expired: number;
  /** Exports failed as stuck. */
  failed: number;
  /** Pending exports to queue again. */
  stale: string[];
}

/** Thrown inside the stream to stop at the row cap. */
class RowCapExceeded extends Error {
  override name = 'RowCapExceeded';
}

/** The events an export covers. */
function scopeOf(row: ExportRow): EventScope {
  const { actor, action, from, to, since } = row.filters;
  const filters: AuditFilters = {
    ...(actor === undefined ? {} : { actor }),
    ...(action === undefined ? {} : { action }),
    ...(from === undefined && to === undefined
      ? {}
      : {
          range: {
            ...(from === undefined ? {} : { from: new Date(from) }),
            ...(to === undefined ? {} : { to: new Date(to) }),
          },
        }),
  };
  return { workspaceId: row.workspaceId, filters, since: new Date(since), until: row.createdAt };
}

/** Produces export files. */
export class AuditExportRunner {
  readonly #clock: () => number;
  readonly #metrics: Metrics;
  readonly #batchSize: number;

  constructor(private readonly deps: AuditExportRunnerDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
    this.#batchSize = deps.batchSize ?? EXPORT_BATCH_SIZE;
  }

  /** Runs export `id`; `finalAttempt` says whether the queue will retry a failure. */
  async run(id: string, opts: { finalAttempt: boolean }): Promise<RunOutcome> {
    const { repository, store } = this.deps;
    const row = await repository.start(id, new Date(this.#clock()));
    if (row === null) return 'skipped';
    const key = exportObjectKey(row);
    const dir = await mkdtemp(join(this.deps.tmpDir ?? tmpdir(), 'audit-export-'));
    try {
      // An earlier attempt may have been cut off after its upload: start from no object.
      await store.delete(key);
      const file = await this.#write(row, join(dir, 'export'));
      if (file === null) {
        await repository.fail(id, 'row_cap_exceeded', new Date(this.#clock()));
        this.#metrics.counter('audit_exports_total', { outcome: 'row_cap_exceeded' }).inc();
        this.deps.logger?.info({ export_id: id }, 'audit_export.row_cap_exceeded');
        return 'row_cap_exceeded';
      }
      await store.putFile(key, file);
      const done = new Date(this.#clock());
      await repository.finish(id, {
        rowCount: file.rows,
        objectKey: key,
        completedAt: done,
        expiresAt: new Date(done.getTime() + this.deps.retainMs),
      });
      this.#metrics.counter('audit_exports_total', { outcome: 'ready' }).inc();
      return 'ready';
    } catch (err) {
      const reason = err instanceof ObjectStoreError ? 'storage_unavailable' : 'internal';
      this.deps.logger?.warn(
        { export_id: id, error: (err as Error).name, final: opts.finalAttempt },
        'audit_export.attempt_failed',
      );
      if (opts.finalAttempt) {
        await repository.fail(id, reason, new Date(this.#clock())).catch(() => false);
        await store.delete(key).catch(() => undefined);
        this.#metrics.counter('audit_exports_total', { outcome: reason }).inc();
      }
      throw err;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Writes the export's file to `path`; null when it would pass the row cap. */
  async #write(row: ExportRow, path: string): Promise<(LocalFile & { rows: number }) | null> {
    const { repository, maxRows } = this.deps;
    const writer = exportWriter(row.format);
    const scope = scopeOf(row);
    const batchSize = this.#batchSize;
    let rows = 0;
    async function* chunks(): AsyncGenerator<string> {
      yield writer.open();
      let after: BatchKey | null = null;
      for (;;) {
        const batch = await repository.batch(scope, after, batchSize);
        let text = '';
        for (const event of batch) {
          if (rows >= maxRows) throw new RowCapExceeded();
          text += writer.event(presentEvent(event), rows);
          rows += 1;
        }
        if (text !== '') yield text;
        const last = batch.at(-1);
        if (batch.length < batchSize || last === undefined) break;
        after = last.key;
      }
      yield writer.close();
    }
    const hash = createHash('sha256');
    let size = 0;
    const measure = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        size += chunk.length;
        done(null, chunk);
      },
    });
    const source = Readable.from(chunks(), { objectMode: false });
    try {
      if (row.gzip) {
        await pipeline(source, createGzip(), measure, createWriteStream(path));
      } else {
        await pipeline(source, measure, createWriteStream(path));
      }
    } catch (err) {
      if (err instanceof RowCapExceeded) return null;
      throw err;
    }
    return {
      path,
      size,
      sha256: hash.digest('hex'),
      contentType: row.gzip ? 'application/gzip' : writer.contentType,
      rows,
    };
  }

  /** Expires the files past their time; returns pending exports to queue again. */
  async sweep(now: Date = new Date(this.#clock())): Promise<SweepResult> {
    const { repository, store } = this.deps;
    let expired = 0;
    for (const item of await repository.expiring(now, SWEEP_LIMIT)) {
      try {
        if (item.objectKey !== null) await store.delete(item.objectKey);
      } catch (err) {
        // Kept ready (and still past its expiry, so never handed out): the next sweep retries.
        this.deps.logger?.warn(
          { export_id: item.id, error: (err as Error).name },
          'audit_export.delete_failed',
        );
        continue;
      }
      await repository.expire(item.id);
      expired += 1;
    }
    const failed = await repository.failStuck(new Date(now.getTime() - STUCK_EXPORT_MS), now);
    const stale = await repository.stalePending(
      new Date(now.getTime() - STALE_PENDING_MS),
      SWEEP_LIMIT,
    );
    return { expired, failed, stale };
  }
}
