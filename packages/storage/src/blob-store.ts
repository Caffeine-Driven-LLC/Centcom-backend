/**
 * Blob storage for the durable log (B055): the port, the object keys and the batch format.
 *
 * - `BlobStore`: `put` a whole object (a failed put leaves none), `get` it (a missing key is a
 *   `BlobNotFoundError`), `delete` keys (missing keys are fine) and `list` keys under a prefix.
 *   S3/R2 (`s3-blob-store.ts`) in production, memory (`memory-blob-store.ts`) in tests.
 * - Keys are `history/<ses_>/<first seq>-<last seq>.bin`: only the session id and numbers, never a
 *   user-provided string. The same range always gives the same key, so a retried batch replaces
 *   its object.
 * - A batch is newline-delimited JSON, one stored frame per line, in seq order. `ct` is written as
 *   it was received and read back unchanged: it is never decoded, normalised or truncated.
 *
 * Owns: the port, keys and format. Must not: put user text in a key, or look inside `ct`.
 */
import { isId } from '@centcom/contracts';
import type { StoredFrame } from './ports.js';

/** Where blobs go. */
export interface BlobStore {
  /** Writes `body` to `key` whole. */
  put(key: string, body: Uint8Array, opts?: { contentType?: string }): Promise<void>;
  /** The object at `key`; BlobNotFoundError when there is none. */
  get(key: string): Promise<Uint8Array>;
  /** Deletes `keys`; keys that are not there are not an error. */
  delete(keys: readonly string[]): Promise<void>;
  /** The keys under `prefix`, sorted. */
  list(prefix: string): Promise<string[]>;
}

/** The object is not there. */
export class BlobNotFoundError extends Error {
  override name = 'BlobNotFoundError';
}

/** The store failed or is unreachable (never carries a credential or a body). */
export class BlobStoreError extends Error {
  override name = 'BlobStoreError';
}

/** The content type of a batch. */
export const BATCH_CONTENT_TYPE = 'application/x-ndjson';

/** The prefix of session `sid`'s blobs. */
export function historyPrefix(sid: string): string {
  if (!isId('ses', sid)) throw new TypeError('historyPrefix: sid must be a ses_ id');
  return `history/${sid}/`;
}

/** The key of session `sid`'s batch holding seqs `first`..`last`. */
export function historyBlobKey(sid: string, first: number, last: number): string {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) {
    throw new TypeError('historyBlobKey: the range must be whole numbers, first <= last');
  }
  return `${historyPrefix(sid)}${first}-${last}.bin`;
}

const KEY = /^history\/(ses_[0-9A-HJKMNP-TV-Z]{26})\/([0-9]{1,19})-([0-9]{1,19})\.bin$/;

/** The session and range of a history key, or null for any other key. */
export function parseBlobKey(key: string): { sid: string; first: number; last: number } | null {
  const m = KEY.exec(key);
  if (m === null) return null;
  const first = Number(m[2]);
  const last = Number(m[3]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) return null;
  return { sid: m[1] ?? '', first, last };
}

/** One frame's line: the stored frame without `size` (the index keeps it). */
function lineOf(frame: StoredFrame): string {
  const rest: Partial<StoredFrame> = { ...frame };
  delete rest.size;
  return JSON.stringify(rest);
}

/** The bytes a frame takes in a batch (its line and the newline). */
export const frameSize = (frame: StoredFrame): number =>
  Buffer.byteLength(lineOf(frame), 'utf8') + 1;

/** A batch of `frames` (seq order), and each frame with its size. */
export function encodeBatch(frames: readonly StoredFrame[]): {
  body: Uint8Array;
  frames: StoredFrame[];
} {
  const sized = frames.map((f) => ({ ...f, size: frameSize(f) }));
  const text = sized.map((f) => `${lineOf(f)}\n`).join('');
  return { body: new TextEncoder().encode(text), frames: sized };
}

/** The frames of a batch; a TypeError for a body that is not one. */
export function decodeBatch(body: Uint8Array): StoredFrame[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  const frames: StoredFrame[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const value = JSON.parse(line) as Omit<StoredFrame, 'size'> | null;
    if (typeof value !== 'object' || value === null || !Number.isSafeInteger(value.seq)) {
      throw new TypeError('decodeBatch: a line is not a stored frame');
    }
    frames.push({ ...value, size: Buffer.byteLength(line, 'utf8') + 1 });
  }
  return frames;
}
