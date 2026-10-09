/**
 * Object storage for audit exports (B082): the port the export runner and the download URLs use,
 * and its S3 implementation (path-style requests signed with SigV4; R2 in production, MinIO in
 * development).
 *
 * - `putFile` uploads a finished local file in one PUT, streamed from disk and signed over its
 *   SHA-256. S3 stores an object only once its whole body has arrived, so a failed or cut upload
 *   leaves no object, and a retried one replaces the key whole.
 * - `delete` removes a key; one that is not there is not an error.
 * - `presignGet` makes a URL that can only GET that key, for at most `ttlS` seconds (host the only
 *   signed header), optionally naming the download's file name.
 * - A failure (network, timeout, any status but success) is an ObjectStoreError naming the
 *   operation and status, never the response body or a credential.
 *
 * Owns: talking to the store. Must not: log or return a secret, or sign any method but GET into a URL.
 */
import { createReadStream } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';
import type { ObjectStoreConfig } from './config.js';
import {
  amzDate,
  authorizationHeader,
  canonicalPath,
  EMPTY_SHA256,
  presignQuery,
  type SigningCredentials,
} from '@centcom/storage';

/** A finished file to upload. */
export interface LocalFile {
  path: string;
  size: number;
  /** Lower-case hex SHA-256 of the file. */
  sha256: string;
  contentType: string;
}

/** Where export files go. */
export interface ObjectStore {
  /** Uploads `file` to `key` whole; a failed upload leaves no object. */
  putFile(key: string, file: LocalFile): Promise<void>;
  /** Deletes `key`; resolves as well when there is none. */
  delete(key: string): Promise<void>;
  /** A URL that GETs `key` for `ttlS` seconds from `now`. */
  presignGet(key: string, ttlS: number, now: Date, opts?: { filename?: string }): string;
}

/** The store failed or is unreachable. */
export class ObjectStoreError extends Error {
  override name = 'ObjectStoreError';
}

/** How long a request may go without progress before it is abandoned. */
export const OBJECT_STORE_IDLE_TIMEOUT_MS = 30_000;

/** Options for `createS3ObjectStore`. */
export interface S3ObjectStoreDeps {
  /** Milliseconds; default Date.now (request signing time). */
  clock?: () => number;
}

/** An S3-compatible store at `config.endpoint`, bucket `config.bucket`, path-style. */
export function createS3ObjectStore(
  config: ObjectStoreConfig,
  deps: S3ObjectStoreDeps = {},
): ObjectStore {
  const clock = deps.clock ?? Date.now;
  const base = new URL(config.endpoint);
  const prefix = base.pathname.split('/').filter(Boolean);
  const credentials = (): SigningCredentials => ({
    accessKeyId: config.accessKeyId.reveal(),
    secretAccessKey: config.secretAccessKey.reveal(),
    region: config.region,
    service: 's3',
  });
  const segmentsOf = (key: string): string[] => [...prefix, config.bucket, ...key.split('/')];

  /** Sends one signed request; resolves to its status, the body read and dropped. */
  function send(
    method: 'PUT' | 'DELETE',
    key: string,
    headers: Record<string, string>,
    payloadHash: string,
    body?: () => NodeJS.ReadableStream,
  ): Promise<number> {
    const now = new Date(clock());
    const segments = segmentsOf(key);
    const signed = { ...headers, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate(now) };
    const authorization = authorizationHeader(
      { method, host: base.host, segments, headers: signed },
      credentials(),
      now,
      payloadHash,
    );
    const request = base.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<number>((resolve, reject) => {
      const req = request(
        {
          protocol: base.protocol,
          hostname: base.hostname,
          port: base.port === '' ? undefined : Number(base.port),
          method,
          path: canonicalPath(segments),
          headers: { ...signed, host: base.host, authorization },
          timeout: OBJECT_STORE_IDLE_TIMEOUT_MS,
        },
        (res: IncomingMessage) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
          res.on('error', () => reject(new ObjectStoreError(`${method} response failed`)));
        },
      );
      req.on('timeout', () => req.destroy(new ObjectStoreError(`${method} timed out`)));
      req.on('error', (err) =>
        reject(err instanceof ObjectStoreError ? err : new ObjectStoreError(`${method} failed`)),
      );
      if (body === undefined) {
        req.end();
        return;
      }
      pipeline(body(), req).catch((err: unknown) => {
        req.destroy(
          err instanceof ObjectStoreError ? err : new ObjectStoreError(`${method} failed`),
        );
      });
    });
  }

  return {
    async putFile(key, file) {
      const status = await send(
        'PUT',
        key,
        { 'content-length': String(file.size), 'content-type': file.contentType },
        file.sha256,
        () => createReadStream(file.path),
      );
      if (status < 200 || status > 299) throw new ObjectStoreError(`PUT answered ${status}`);
    },
    async delete(key) {
      const status = await send('DELETE', key, {}, EMPTY_SHA256);
      if (status !== 404 && (status < 200 || status > 299)) {
        throw new ObjectStoreError(`DELETE answered ${status}`);
      }
    },
    presignGet(key, ttlS, now, opts = {}) {
      const segments = segmentsOf(key);
      const query: Record<string, string> =
        opts.filename === undefined
          ? {}
          : { 'response-content-disposition': `attachment; filename="${opts.filename}"` };
      const signed = presignQuery(
        { method: 'GET', host: base.host, segments, query },
        credentials(),
        now,
        ttlS,
      );
      return `${base.protocol}//${base.host}${canonicalPath(segments)}?${signed}`;
    },
  };
}
