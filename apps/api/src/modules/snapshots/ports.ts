/**
 * Snapshot ports (B056, CT-RESUME, CT-API-SESSIONS): the constants of the card, the stored row,
 * the descriptor, and what the service needs from the object store, the database and the caller's
 * standing in the session.
 *
 * - **Objects** (`SnapshotObjects`): B055's `BlobStore` (imported through its public interface
 *   only: `delete` and `list`) plus pre-signed PUT and GET URLs and a streamed read for the commit's
 *   hash. `presign.ts` builds it over S3/R2; tests use a memory fake.
 * - **Rows** (`SnapshotRows`): the `snapshot` table (`repository.ts` over Postgres).
 * - **Standing**: B055's `HistoryAccess` (host, editor, viewer, or not a participant).
 *
 * Owns: these shapes and limits. Must not: describe anything about the bytes but size and hash.
 */
import type { Api } from '@centcom/contracts';
import type { AuditDb } from '@centcom/core';
import type { BlobStore, HistoryAccess } from '@centcom/storage';

/** Largest snapshot: 32 MiB (CT-FOUNDATIONS body limits, card scope). */
export const SNAPSHOT_MAX_BYTES = 33_554_432;
/** A pre-signed PUT lives 600 s (card guardrail). */
export const UPLOAD_TTL_S = 600;
/** A pre-signed GET lives 300 s (card guardrail). */
export const DOWNLOAD_TTL_S = 300;
/** Committed snapshots kept per session (CT-RESUME "Keeps the latest 3"). */
export const KEEP_COMMITTED = 3;
/** Uploads not committed within 15 min are deleted (card scope). */
export const PENDING_TTL_MS = 15 * 60_000;
/** Pending uploads allowed per session at once (card failure modes). */
export const MAX_PENDING = 3;
/** The read buffer of the commit's hash: at most 64 KiB in memory (card guardrail). */
export const HASH_CHUNK_BYTES = 65_536;

/** A row's state; `deleting` rows are never served. */
export type SnapshotState = 'pending' | 'committed' | 'deleting';

/** A `snapshot` row. */
export interface SnapshotRow {
  snp: string;
  sessionId: string;
  state: SnapshotState;
  seq: number | null;
  /** Declared at begin; verified at commit. */
  size: number;
  /** `sha256:<hex>`. */
  sha256: string | null;
  kid: string | null;
  blobKey: string;
  createdAt: Date;
  committedAt: Date | null;
}

/** A committed snapshot (CT-API-SESSIONS `SnapshotDescriptor`, without the URL). */
export interface SnapshotDescriptor {
  snp: string;
  seq: number;
  size: number;
  sha256: string;
  kid: string;
  createdAt: Date;
}

/** What the commit claims about the uploaded object (`SnapshotCommit`). */
export type SnapshotCommitBody = Api.SnapshotCommit;

/** The object store as snapshots use it. */
export interface SnapshotObjects extends Pick<BlobStore, 'delete' | 'list'> {
  /**
   * A URL that PUTs exactly `contentLength` bytes to `key` for `ttlS` seconds from `now` (the
   * length is signed, so any other body is refused by the store).
   */
  presignPut(key: string, contentLength: number, ttlS: number, now: Date): string;
  /** A URL that GETs `key` for `ttlS` seconds from `now`. */
  presignGet(key: string, ttlS: number, now: Date): string;
  /**
   * The object's bytes in chunks of at most HASH_CHUNK_BYTES. Rejects (or throws while iterating)
   * with B055's `BlobNotFoundError` when there is no object and `BlobStoreError` when the store
   * fails; stopping the iteration early releases the connection.
   */
  read(key: string): AsyncIterable<Uint8Array>;
}

/** The `snapshot` table. */
export interface SnapshotRows {
  /**
   * Inserts a pending row unless the session already has `maxPending` pending rows created after
   * `pendingSince`; under a per-session lock, so concurrent begins never pass the cap, and with
   * `audit` in the same transaction. Resolves to true, or (nothing written, the cap reached) to
   * the `createdAt` of the oldest pending row counted.
   */
  insertPending(
    row: Pick<SnapshotRow, 'snp' | 'sessionId' | 'size' | 'kid' | 'blobKey' | 'createdAt'>,
    maxPending: number,
    pendingSince: Date,
    audit: (trx: AuditDb) => Promise<unknown>,
  ): Promise<true | Date>;
  /** The row `snp` of session `sid`, or null. */
  get(sid: string, snp: string): Promise<SnapshotRow | null>;
  /**
   * Marks a pending row committed, with `audit` in the same transaction; resolves to the row, or
   * null (nothing written) when it was not pending.
   */
  commit(
    sid: string,
    snp: string,
    fields: { seq: number; sha256: string; kid: string; committedAt: Date },
    audit: (trx: AuditDb) => Promise<unknown>,
  ): Promise<SnapshotRow | null>;
  /** The committed row with the highest seq (newest commit on a tie), or null. */
  latest(sid: string): Promise<SnapshotRow | null>;
  /**
   * Committed rows of `sid` beyond the `keep` to keep: the latest (highest seq, as `latest`) and
   * the `keep - 1` most recently committed others.
   */
  beyondNewest(sid: string, keep: number): Promise<SnapshotRow[]>;
  /** Pending rows created before `before` (of `sid` when given), at most `limit`, oldest first. */
  expiredPending(before: Date, limit: number, sid?: string): Promise<SnapshotRow[]>;
  /** Rows whose deletion stopped halfway, at most `limit` (all sessions when `sid` is absent). */
  deleting(limit: number, sid?: string): Promise<SnapshotRow[]>;
  /** Every row of `sid`, any state. */
  allOf(sid: string): Promise<SnapshotRow[]>;
  /**
   * Marks rows `deleting` (only from `fromState`); resolves to the ones it marked, so two prunes
   * never both act on a row.
   */
  markDeleting(snps: readonly string[], fromState: SnapshotState): Promise<string[]>;
  /** Puts `deleting` rows back to `pending` (a refused commit's row, once its object is gone). */
  restorePending(snps: readonly string[]): Promise<void>;
  /** Deletes rows (any state). */
  remove(snps: readonly string[]): Promise<void>;
}

/** Who the caller is in the session (B055's access). */
export type SnapshotAccess = HistoryAccess;

/** The object key of snapshot `snp` of `sid` (server-generated, card guardrail). */
export const snapshotKey = (sid: string, snp: string): string => `snapshots/${sid}/${snp}.bin`;

/** The prefix of a session's snapshot objects. */
export const snapshotPrefix = (sid: string): string => `snapshots/${sid}/`;
