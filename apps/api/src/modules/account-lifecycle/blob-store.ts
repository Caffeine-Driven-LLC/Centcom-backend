/**
 * Where export files go (B026): the port the export runner, the purge and the download URLs use,
 * and an adapter over B082's S3 object store (`createS3ObjectStore`, path-style SigV4; R2 in
 * production, MinIO in development), so the signing code exists once.
 *
 * - `put` uploads a whole document: the adapter writes it to a private temporary file, uploads
 *   that in one PUT signed over its SHA-256 (S3 keeps an object only once its whole body arrived,
 *   so a failed upload leaves nothing), then removes the file.
 * - `delete` removes a key; a missing key is not an error.
 * - `presignGet` makes a URL that can only GET that key, for `ttlS` seconds.
 *
 * Owns: the port and the adapter. Must not: log a key's content or a URL.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObjectStore } from '../audit-api/object-store.js';

/** Where export files go. */
export interface ExportBlobStore {
  /** Uploads `body` to `key` whole; a failed upload leaves no object. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Deletes `key`; resolves as well when there is none. */
  delete(key: string): Promise<void>;
  /** A URL that GETs `key` for `ttlS` seconds from `now`. */
  presignGet(key: string, ttlS: number, now: Date, opts?: { filename?: string }): string;
}

/** The object key of an export's file. */
export const exportBlobKey = (userId: string, exportId: string): string =>
  `exports/${userId}/${exportId}.json`;

/** Options of `exportBlobStoreFrom`. */
export interface ExportBlobStoreOptions {
  /** Where temporary files go; default the OS's temporary directory. */
  tmpDir?: string;
}

/** An ExportBlobStore over an S3 ObjectStore (B082). */
export function exportBlobStoreFrom(
  store: ObjectStore,
  opts: ExportBlobStoreOptions = {},
): ExportBlobStore {
  return {
    async put(key, body, contentType) {
      const dir = await mkdtemp(join(opts.tmpDir ?? tmpdir(), 'account-export-'));
      const path = join(dir, randomBytes(8).toString('hex'));
      try {
        await writeFile(path, body, { mode: 0o600 });
        await store.putFile(key, {
          path,
          size: body.byteLength,
          sha256: createHash('sha256').update(body).digest('hex'),
          contentType,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    delete: (key) => store.delete(key),
    presignGet: (key, ttlS, now, options) => store.presignGet(key, ttlS, now, options),
  };
}
