/**
 * Snapshot objects over S3/R2 (B056): pre-signed PUT and GET URLs (SigV4 query authentication,
 * B082's helpers in `@centcom/storage`), the streamed read the commit hashes, and B055's
 * `BlobStore` for deletes and listings. Configured by the same `OBJECT_STORE_*` settings.
 *
 * - **PUT** (`presignPut`): signs `content-length` as well as `host`, so the store refuses any body
 *   that is not exactly the declared size (at most 32 MiB, checked by the service), and only for
 *   that key, for `ttlS` seconds (600). The payload is `UNSIGNED-PAYLOAD`: the commit checks it.
 * - **GET** (`presignGet`): `host` only, for `ttlS` seconds (300).
 * - **Read** (`read`): a GET through a URL valid for READ_URL_TTL_S, streamed: chunks of at most
 *   64 KiB are handed on as they arrive and never collected, with an idle timeout. 404 is B055's
 *   BlobNotFoundError; any other failure a BlobStoreError naming the status, never a URL.
 * - URLs carry a credential and a signature: nothing here logs them.
 *
 * Owns: signing and reading. Must not: log or return a secret, sign a key the caller did not get
 * from `snapshotKey`, or keep an object's bytes.
 */
import { createHmac, createHash } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  amzDate,
  BLOB_IDLE_TIMEOUT_MS,
  BlobNotFoundError,
  BlobStoreError,
  canonicalPath,
  canonicalQuery,
  createS3BlobStore,
  SIGV4_ALGORITHM,
  UNSIGNED_PAYLOAD,
  type BlobStore,
  type ObjectStoreConfig,
  type SigningCredentials,
} from '@centcom/storage';
import { HASH_CHUNK_BYTES, type SnapshotObjects } from './ports.js';

/** The read's own URL lives this long: enough to start the GET, not to share it. */
export const READ_URL_TTL_S = 60;

/** Options for `createS3SnapshotObjects`. */
export interface S3SnapshotObjectsDeps {
  /** Milliseconds; default Date.now (signing time of reads). */
  clock?: () => number;
  /** Deletes and listings; default B055's S3 BlobStore on the same config. */
  blobs?: Pick<BlobStore, 'delete' | 'list'>;
  /** Idle timeout of a read; default B055's BLOB_IDLE_TIMEOUT_MS. */
  idleTimeoutMs?: number;
}

/** A request to pre-sign: its method, path segments and the headers it must carry. */
export interface PresignRequest {
  method: 'GET' | 'PUT';
  host: string;
  segments: readonly string[];
  /** Signed headers besides host (lower-case names). */
  headers?: Readonly<Record<string, string>>;
}

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/**
 * The query string that pre-signs `request` for `expiresS` seconds from `now`, signing `host` and
 * `request.headers` (SigV4 query authentication with an unsigned payload).
 */
export function presignWithHeaders(
  request: PresignRequest,
  credentials: SigningCredentials,
  now: Date,
  expiresS: number,
): string {
  const date = amzDate(now);
  const scope = `${date.slice(0, 8)}/${credentials.region}/${credentials.service}/aws4_request`;
  const headers = new Map<string, string>([['host', request.host]]);
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    headers.set(name.toLowerCase(), value.trim());
  }
  const names = [...headers.keys()].sort();
  const query: Record<string, string> = {
    'X-Amz-Algorithm': SIGV4_ALGORITHM,
    'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': date,
    'X-Amz-Expires': String(expiresS),
    'X-Amz-SignedHeaders': names.join(';'),
  };
  const canonical = [
    request.method,
    canonicalPath(request.segments),
    canonicalQuery(query),
    names.map((name) => `${name}:${headers.get(name) ?? ''}\n`).join(''),
    names.join(';'),
    UNSIGNED_PAYLOAD,
  ].join('\n');
  const toSign = [
    SIGV4_ALGORITHM,
    date,
    scope,
    createHash('sha256').update(canonical, 'utf8').digest('hex'),
  ].join('\n');
  let key = hmac(`AWS4${credentials.secretAccessKey}`, date.slice(0, 8));
  key = hmac(key, credentials.region);
  key = hmac(key, credentials.service);
  key = hmac(key, 'aws4_request');
  return `${canonicalQuery(query)}&X-Amz-Signature=${hmac(key, toSign).toString('hex')}`;
}

/** Snapshot objects in the bucket `config.bucket` at `config.endpoint`, path-style. */
export function createS3SnapshotObjects(
  config: ObjectStoreConfig,
  deps: S3SnapshotObjectsDeps = {},
): SnapshotObjects {
  const clock = deps.clock ?? Date.now;
  const blobs = deps.blobs ?? createS3BlobStore(config, { clock });
  const idleTimeoutMs = deps.idleTimeoutMs ?? BLOB_IDLE_TIMEOUT_MS;
  const base = new URL(config.endpoint);
  const prefix = base.pathname.split('/').filter(Boolean);
  const credentials = (): SigningCredentials => ({
    accessKeyId: config.accessKeyId.reveal(),
    secretAccessKey: config.secretAccessKey.reveal(),
    region: config.region,
    service: 's3',
  });
  const segmentsOf = (key: string): string[] => [...prefix, config.bucket, ...key.split('/')];
  const urlOf = (
    method: 'GET' | 'PUT',
    key: string,
    ttlS: number,
    now: Date,
    headers?: Record<string, string>,
  ): string => {
    const segments = segmentsOf(key);
    const signed = presignWithHeaders(
      { method, host: base.host, segments, ...(headers === undefined ? {} : { headers }) },
      credentials(),
      now,
      ttlS,
    );
    return `${base.protocol}//${base.host}${canonicalPath(segments)}?${signed}`;
  };

  /** The response to a GET of `url`; a BlobStoreError when it cannot be had. */
  function open(url: URL): Promise<IncomingMessage> {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = request(url, { method: 'GET', timeout: idleTimeoutMs }, resolve);
      req.on('timeout', () => req.destroy(new BlobStoreError('GET timed out')));
      req.on('error', (err) =>
        reject(err instanceof BlobStoreError ? err : new BlobStoreError('GET failed')),
      );
      req.end();
    });
  }

  return {
    delete: (keys) => blobs.delete(keys),
    list: (keyPrefix) => blobs.list(keyPrefix),
    presignPut(key, contentLength, ttlS, now) {
      return urlOf('PUT', key, ttlS, now, { 'content-length': String(contentLength) });
    },
    presignGet(key, ttlS, now) {
      return urlOf('GET', key, ttlS, now);
    },
    async *read(key) {
      const res = await open(new URL(urlOf('GET', key, READ_URL_TTL_S, new Date(clock()))));
      try {
        const status = res.statusCode ?? 0;
        if (status === 404) throw new BlobNotFoundError('snapshot object not found');
        if (status < 200 || status > 299) throw new BlobStoreError(`GET answered ${status}`);
        res.setTimeout(idleTimeoutMs, () => res.destroy(new BlobStoreError('GET timed out')));
        try {
          for await (const chunk of res as AsyncIterable<Buffer>) {
            for (let at = 0; at < chunk.length; at += HASH_CHUNK_BYTES) {
              yield chunk.subarray(at, at + HASH_CHUNK_BYTES);
            }
          }
        } catch (err) {
          throw err instanceof BlobStoreError ? err : new BlobStoreError('GET failed');
        }
      } finally {
        res.destroy();
      }
    },
  };
}
