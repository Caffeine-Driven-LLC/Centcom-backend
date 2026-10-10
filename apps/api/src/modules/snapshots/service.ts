/**
 * The snapshot service (B056, CT-RESUME "Snapshot rules", CT-API-SESSIONS): begin an upload,
 * commit it after checking its size and hash, serve the latest descriptor, keep 3.
 *
 * - **Begin** (host only): a `snp_` id, a pending row and a pre-signed PUT of exactly the declared
 *   size (at most 32 MiB) to `snapshots/<ses_>/<snp_>.bin`, valid 600 s. A session with 3 uploads
 *   pending (younger than 15 min) gets 429 with `retry_after_s` until the oldest of them stops
 *   counting.
 * - **Commit** (host only): the object is read as a stream and hashed (SHA-256, 64 KiB at a time);
 *   its size and hash must match the body (`sha256:<hex>`, CT-IDS) and the size declared at begin
 *   (a body size other than begin's is 422 before any read, and the object is kept).
 *   A hash mismatch is 409 `snapshot_hash_mismatch` (CT-ERR, errors.json; `errors[0].pointer`
 *   `/sha256`), an object of another size 422 `validation_failed` (`/size`): the object is deleted and the
 *   row stays pending. No object: 404
 *   `snapshot_missing`. The store failing: 503 with `retry_after_s`, the row stays pending.
 *   Committing a snapshot already committed with the same values answers its descriptor again.
 *   After a commit, the session is pruned to 3 snapshots (`prune.ts`); a prune that
 *   fails does not fail the commit (the next one finishes it).
 * - **Latest**: the committed snapshot with the highest seq, with a pre-signed GET valid 300 s. A
 *   lower seq committed later is stored but not served. `latest(sid)` has no caller check (the
 *   relay's `snapshot_required` path asks it, `snapshotSeqLookup`); the route uses `latestFor`,
 *   for participants (host, editor, viewer).
 * - **Who:** not a participant, or no such session: 404 (the session is not revealed); an editor
 *   or viewer who begins or commits: 403 `host_required`.
 * - **Audit:** `snapshot.begin` and `snapshot.commit`, in the transaction of the row change
 *   (SNAPSHOT_AUDIT_ACTIONS: this module's emitter only; CT-API-AUDIT's list lacks them).
 *
 * Owns: these rules. Must not: read the bytes for anything but size and hash, or log a URL or a
 * hash.
 */
import { createHash } from 'node:crypto';
import { newId as defaultNewId, type IdPrefix } from '@centcom/contracts';
import {
  AppError,
  AUDIT_ACTIONS,
  defineAuditActions,
  noopMetrics,
  notFound,
  tooManyRequests,
  unavailable,
  validationFailed,
  type AuditEmitter,
  type FieldError,
  type Logger,
  type Metrics,
} from '@centcom/core';
import { isConnectionError } from '@centcom/db';
import { BlobNotFoundError, type SessionStanding } from '@centcom/storage';
import { SnapshotPruner } from './prune.js';
import {
  DOWNLOAD_TTL_S,
  MAX_PENDING,
  PENDING_TTL_MS,
  SNAPSHOT_MAX_BYTES,
  snapshotKey,
  snapshotPrefix,
  UPLOAD_TTL_S,
  type SnapshotAccess,
  type SnapshotCommitBody,
  type SnapshotDescriptor,
  type SnapshotObjects,
  type SnapshotRow,
  type SnapshotRows,
} from './ports.js';

/** B036's catalogue and this module's two actions (ids, the seq and the size only). */
export const SNAPSHOT_AUDIT_ACTIONS = defineAuditActions({
  ...AUDIT_ACTIONS,
  'snapshot.begin': { meta: ['session_id', 'size'] },
  'snapshot.commit': { meta: ['session_id', 'seq', 'size'] },
});

/** An action this module's emitter accepts. */
export type SnapshotAuditAction = keyof typeof SNAPSHOT_AUDIT_ACTIONS;

/** The details of refusals (GUIDELINES §3.4). */
export const SNAPSHOT_DETAILS = Object.freeze({
  notFound: 'There is no such session.',
  hostOnly: 'Only the session host may upload a snapshot.',
  missing: 'There is no such snapshot, or its upload has not arrived.',
  pendingCap: 'Too many snapshot uploads are in progress for this session; try again shortly.',
  hashMismatch: 'The uploaded snapshot does not match the hash given; it was deleted.',
  sizeMismatch: 'The uploaded snapshot does not have the size given; it was deleted.',
  unavailable: 'Snapshots cannot be reached right now; try again shortly.',
  invalid: 'The snapshot request is not valid.',
} as const);

/** Who asks. */
export interface SnapshotCaller {
  userId: string;
  /** The request's `req_` id, for the audit events. */
  requestId?: string;
}

/** What begin returns (`SnapshotUpload`). */
export interface SnapshotUploadGrant {
  snp: string;
  uploadUrl: string;
  expiresIn: number;
}

/** The latest descriptor and its download URL. */
export interface LatestSnapshot {
  descriptor: SnapshotDescriptor;
  downloadUrl: string;
  expiresIn: number;
}

/** What the service needs. */
export interface SnapshotServiceDeps {
  rows: SnapshotRows;
  objects: SnapshotObjects;
  access: SnapshotAccess;
  /** Writes `snapshot.*` in the row change's transaction (an emitter over SNAPSHOT_AUDIT_ACTIONS). */
  audit: Pick<AuditEmitter<SnapshotAuditAction>, 'emit'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Id generator; default `@centcom/contracts`' newId. */
  newId?: (prefix: IdPrefix) => string;
  logger?: Logger;
  metrics?: Metrics;
}

/** Operations (the `op` label of `snapshot_requests_total`). */
type Op = 'begin' | 'commit' | 'latest';

const HASH = /^sha256:[0-9a-f]{64}$/;

/** A committed row's descriptor. */
const descriptorOf = (row: SnapshotRow): SnapshotDescriptor => ({
  snp: row.snp,
  seq: row.seq ?? 0,
  size: row.size,
  sha256: row.sha256 ?? '',
  kid: row.kid ?? '',
  createdAt: row.committedAt ?? row.createdAt,
});

/** Snapshots of sessions. */
export class SnapshotService {
  readonly #clock: () => number;
  readonly #newId: (prefix: IdPrefix) => string;
  readonly #metrics: Metrics;
  readonly #pruner: SnapshotPruner;

  constructor(private readonly deps: SnapshotServiceDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#newId = deps.newId ?? defaultNewId;
    this.#metrics = deps.metrics ?? noopMetrics;
    this.#pruner = new SnapshotPruner({
      rows: deps.rows,
      objects: deps.objects,
      clock: this.#clock,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      metrics: this.#metrics,
    });
  }

  /** The pruner over the same rows and objects (`prune()` for a periodic job). */
  get pruner(): SnapshotPruner {
    return this.#pruner;
  }

  #count(op: Op, outcome: 'ok' | 'refused' | 'failed'): void {
    this.#metrics.counter('snapshot_requests_total', { op, outcome }).inc();
  }

  /** Runs `work`, counting its outcome; database outages become 503. */
  async #counted<T>(op: Op, work: () => Promise<T>): Promise<T> {
    try {
      const out = await work();
      this.#count(op, 'ok');
      return out;
    } catch (err) {
      const failure = dbFailure(err);
      const status = failure instanceof AppError ? failure.status : 500;
      this.#count(op, status >= 500 ? 'failed' : 'refused');
      throw failure;
    }
  }

  async #standing(sid: string, caller: SnapshotCaller): Promise<SessionStanding> {
    const standing = await this.deps.access.standing(sid, caller);
    if (standing === null || standing.shareLinkGuest || standing.role === null) {
      throw notFound(SNAPSHOT_DETAILS.notFound);
    }
    return standing;
  }

  async #host(sid: string, caller: SnapshotCaller): Promise<SessionStanding> {
    const standing = await this.#standing(sid, caller);
    if (standing.role !== 'host') {
      throw new AppError('host_required', { detail: SNAPSHOT_DETAILS.hostOnly });
    }
    return standing;
  }

  /** Begins an upload of `body.size` bytes (host only). */
  begin(
    sid: string,
    byMember: SnapshotCaller,
    body: { size?: number; kid?: string },
  ): Promise<SnapshotUploadGrant> {
    return this.#counted('begin', async () => {
      const standing = await this.#host(sid, byMember);
      const errors: FieldError[] = [];
      const size = body.size;
      if (size === undefined) {
        errors.push({ pointer: '/size', code: 'required', detail: 'is required' });
      } else if (!Number.isSafeInteger(size) || size < 0 || size > SNAPSHOT_MAX_BYTES) {
        errors.push({
          pointer: '/size',
          code: 'out_of_range',
          detail: `must be a whole number from 0 to ${SNAPSHOT_MAX_BYTES}`,
        });
      }
      if (body.kid !== undefined && !validKid(body.kid)) {
        errors.push({ pointer: '/kid', code: 'invalid', detail: 'must be 1 to 64 characters' });
      }
      if (errors.length > 0 || size === undefined) {
        throw validationFailed(errors, SNAPSHOT_DETAILS.invalid);
      }
      const now = this.#clock();
      const snp = this.#newId('snp');
      const blobKey = snapshotKey(sid, snp);
      const inserted = await this.deps.rows.insertPending(
        { snp, sessionId: sid, size, kid: body.kid ?? null, blobKey, createdAt: new Date(now) },
        MAX_PENDING,
        new Date(now - PENDING_TTL_MS),
        (trx) =>
          this.deps.audit.emit(trx, {
            workspaceId: standing.workspaceId,
            actor: { type: 'user', id: byMember.userId },
            action: 'snapshot.begin',
            target: { type: 'snapshot', id: snp },
            outcome: 'success',
            ...(byMember.requestId === undefined ? {} : { requestId: byMember.requestId }),
            meta: { session_id: sid, size },
          }),
      );
      if (inserted !== true) {
        // The oldest counted upload stops counting 15 min after it began.
        const wait = Math.ceil((inserted.getTime() + PENDING_TTL_MS - now) / 1000);
        throw tooManyRequests(
          Math.min(Math.max(wait, 1), PENDING_TTL_MS / 1000),
          SNAPSHOT_DETAILS.pendingCap,
        );
      }
      return {
        snp,
        uploadUrl: this.deps.objects.presignPut(blobKey, size, UPLOAD_TTL_S, new Date(now)),
        expiresIn: UPLOAD_TTL_S,
      };
    });
  }

  /** Commits snapshot `snp` after checking the uploaded object (host only). */
  commit(
    sid: string,
    snp: string,
    body: SnapshotCommitBody,
    byMember: SnapshotCaller,
  ): Promise<SnapshotDescriptor> {
    return this.#counted('commit', async () => {
      const standing = await this.#host(sid, byMember);
      checkCommitBody(body);
      const row = await this.deps.rows.get(sid, snp);
      if (row === null || row.state === 'deleting') {
        throw new AppError('snapshot_missing', { detail: SNAPSHOT_DETAILS.missing });
      }
      if (row.state === 'committed') return sameCommit(row, body);
      if (body.size !== row.size) {
        throw validationFailed(
          [{ pointer: '/size', code: 'size_mismatch', detail: 'differs from the size at begin' }],
          SNAPSHOT_DETAILS.sizeMismatch,
        );
      }
      const verified = await this.#verify(row, body.sha256);
      if (verified !== 'ok') {
        // A concurrent commit of the same snapshot may have won meanwhile: its object stays.
        const current = await this.deps.rows.get(sid, snp);
        if (current?.state === 'committed') return sameCommit(current, body);
        if (current?.state === 'pending') await this.#discard(row);
        throw verified === 'size'
          ? validationFailed(
              [{ pointer: '/size', code: 'size_mismatch', detail: 'differs from the object' }],
              SNAPSHOT_DETAILS.sizeMismatch,
            )
          : new AppError('snapshot_hash_mismatch', {
              detail: SNAPSHOT_DETAILS.hashMismatch,
              errors: [
                {
                  pointer: '/sha256',
                  code: 'snapshot_hash_mismatch',
                  detail: 'differs from the object',
                },
              ],
            });
      }
      const committed = await this.deps.rows.commit(
        sid,
        snp,
        {
          seq: body.seq,
          sha256: body.sha256,
          kid: body.kid,
          committedAt: new Date(this.#clock()),
        },
        (trx) =>
          this.deps.audit.emit(trx, {
            workspaceId: standing.workspaceId,
            actor: { type: 'user', id: byMember.userId },
            action: 'snapshot.commit',
            target: { type: 'snapshot', id: snp },
            outcome: 'success',
            ...(byMember.requestId === undefined ? {} : { requestId: byMember.requestId }),
            meta: { session_id: sid, seq: body.seq, size: body.size },
          }),
      );
      if (committed === null) {
        // Another commit or a prune got there first.
        const now = await this.deps.rows.get(sid, snp);
        if (now?.state === 'committed') return sameCommit(now, body);
        throw new AppError('snapshot_missing', { detail: SNAPSHOT_DETAILS.missing });
      }
      try {
        await this.#pruner.pruneSession(sid);
      } catch (err) {
        this.deps.logger?.warn(
          { sid, error: err instanceof Error ? err.name : 'unknown' },
          'snapshot.prune_after_commit_failed',
        );
      }
      return descriptorOf(committed);
    });
  }

  /**
   * Hashes the object of `row` as a stream and compares it with `claimed`: `ok`, or which check
   * failed. 404 and 503 for a missing object and a failing store.
   */
  async #verify(row: SnapshotRow, claimed: string): Promise<'ok' | 'size' | 'hash'> {
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of this.deps.objects.read(row.blobKey)) {
        bytes += chunk.byteLength;
        if (bytes > row.size) return 'size';
        hash.update(chunk);
      }
    } catch (err) {
      if (err instanceof BlobNotFoundError) {
        throw new AppError('snapshot_missing', { detail: SNAPSHOT_DETAILS.missing });
      }
      this.#metrics.counter('snapshot_verify_failures_total').inc();
      this.deps.logger?.warn(
        { sid: row.sessionId, error: err instanceof Error ? err.name : 'unknown' },
        'snapshot.verify_failed',
      );
      throw unavailable(1, SNAPSHOT_DETAILS.unavailable, { cause: new Error('read failed') });
    }
    if (bytes !== row.size) return 'size';
    return `sha256:${hash.digest('hex')}` === claimed ? 'ok' : 'hash';
  }

  /**
   * Deletes the object of a refused commit; the row stays pending (the expiry prune ends it). A
   * failure partway leaves the row `deleting`, which the next prune finishes.
   */
  async #discard(row: SnapshotRow): Promise<void> {
    try {
      // Claim the row first (pending -> deleting): a concurrent commit of the same snapshot then
      // cannot commit it while its object goes. Unclaimed (it committed or went): leave the object.
      const claimed = await this.deps.rows.markDeleting([row.snp], 'pending');
      if (claimed.length === 0) return;
      await this.deps.objects.delete([row.blobKey]);
      await this.deps.rows.restorePending([row.snp]);
    } catch (err) {
      this.deps.logger?.warn(
        { sid: row.sessionId, error: err instanceof Error ? err.name : 'unknown' },
        'snapshot.discard_failed',
      );
    }
  }

  /** The latest committed snapshot of `sid` with a download URL, or null (no caller check). */
  async latest(sid: string): Promise<LatestSnapshot | null> {
    const row = await this.deps.rows.latest(sid);
    if (row === null) return null;
    return {
      descriptor: descriptorOf(row),
      downloadUrl: this.deps.objects.presignGet(
        row.blobKey,
        DOWNLOAD_TTL_S,
        new Date(this.#clock()),
      ),
      expiresIn: DOWNLOAD_TTL_S,
    };
  }

  /** `latest` for a participant of `sid`; 404 `snapshot_missing` when there is none. */
  latestFor(sid: string, caller: SnapshotCaller): Promise<LatestSnapshot> {
    return this.#counted('latest', async () => {
      await this.#standing(sid, caller);
      const latest = await this.latest(sid);
      if (latest === null) {
        throw new AppError('snapshot_missing', { detail: SNAPSHOT_DETAILS.missing });
      }
      return latest;
    });
  }

  /** Deletes every snapshot of `sid`, objects first (B090's retention and workspace purge). */
  async purgeSession(sid: string): Promise<void> {
    await this.#pruner.purgeSession(sid, snapshotPrefix(sid));
  }
}

/** A key id CT-CRYPTO and the table accept. */
const validKid = (kid: string): boolean => kid.length >= 1 && kid.length <= 64;

/** The checks the schema leaves to the server; 422 with every field that fails. */
function checkCommitBody(body: SnapshotCommitBody): void {
  const errors: FieldError[] = [];
  if (!Number.isSafeInteger(body.seq) || body.seq < 0) {
    errors.push({ pointer: '/seq', code: 'out_of_range', detail: 'must be a whole number >= 0' });
  }
  if (!HASH.test(body.sha256)) {
    errors.push({ pointer: '/sha256', code: 'invalid_format', detail: 'must be sha256:<hex>' });
  }
  if (!Number.isSafeInteger(body.size) || body.size < 0 || body.size > SNAPSHOT_MAX_BYTES) {
    errors.push({
      pointer: '/size',
      code: 'out_of_range',
      detail: `must be a whole number from 0 to ${SNAPSHOT_MAX_BYTES}`,
    });
  }
  if (!validKid(body.kid)) {
    errors.push({ pointer: '/kid', code: 'invalid', detail: 'must be 1 to 64 characters' });
  }
  if (errors.length > 0) throw validationFailed(errors, SNAPSHOT_DETAILS.invalid);
}

/** A repeated commit: its descriptor when the values match, else 422 naming the first that differs. */
function sameCommit(row: SnapshotRow, body: SnapshotCommitBody): SnapshotDescriptor {
  const d = descriptorOf(row);
  for (const field of ['seq', 'sha256', 'size', 'kid'] as const) {
    if (d[field] !== body[field]) {
      throw validationFailed(
        [{ pointer: `/${field}`, code: 'already_committed', detail: 'differs from the commit' }],
        SNAPSHOT_DETAILS.invalid,
      );
    }
  }
  return d;
}

/** A database timeout or lost connection: a 503. */
function dbFailure(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  if (isConnectionError(err) || code === '57014') {
    return unavailable(1, SNAPSHOT_DETAILS.unavailable, {
      cause: new Error('database unavailable'),
    });
  }
  return err;
}

/** The relay's `SnapshotLookup` (B042, `apps/relay/src/resume/types.ts`) over this service. */
export function snapshotSeqLookup(service: Pick<SnapshotService, 'latest'>): {
  latestSeq(sid: string): Promise<number | null>;
} {
  return {
    async latestSeq(sid) {
      return (await service.latest(sid))?.descriptor.seq ?? null;
    },
  };
}
