/**
 * The S3-compatible BlobStore (B055): R2 in production, MinIO in development, path-style requests
 * signed with SigV4 by B082's signer (`audit-api/sigv4.ts`), configured like B082's object store
 * (`OBJECT_STORE_*`).
 *
 * - `put`: one PUT signed over the body's SHA-256; S3 stores an object only once its whole body
 *   arrived, so a failed put leaves nothing.
 * - `get`: GET; 404 is BlobNotFoundError.
 * - `delete`: one DELETE per key; 404 is fine.
 * - `list`: ListObjectsV2 under the prefix, following continuation tokens.
 * - Every request has an idle timeout; a failure is a BlobStoreError naming the operation and the
 *   status, never the response body or a credential.
 * - Encryption at rest is the bucket's (R2 always encrypts; set default encryption on S3 or MinIO,
 *   see README.md): no per-object header.
 *
 * Owns: talking to the store. Must not: log or return a secret, or a blob's content.
 */
import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ObjectStoreConfig } from '../audit-api/config.js';
import {
  amzDate,
  authorizationHeader,
  canonicalPath,
  canonicalQuery,
  EMPTY_SHA256,
  type SigningCredentials,
} from '../audit-api/sigv4.js';
import {
  BATCH_CONTENT_TYPE,
  BlobNotFoundError,
  BlobStoreError,
  type BlobStore,
} from './blob-store.js';

/** How long a request may go without progress. */
export const BLOB_IDLE_TIMEOUT_MS = 30_000;
/** Keys asked for per list page. */
const LIST_PAGE = 1000;

/** Options for `createS3BlobStore`. */
export interface S3BlobStoreDeps {
  /** Milliseconds; default Date.now (request signing time). */
  clock?: () => number;
}

const sha256 = (body: Uint8Array): string => createHash('sha256').update(body).digest('hex');

/** The values of `<tag>` elements in an S3 XML answer (keys are XML-escaped). */
function xmlValues(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  for (const m of xml.matchAll(re)) {
    out.push(
      (m[1] ?? '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&'),
    );
  }
  return out;
}

/** A BlobStore over the bucket `config.bucket` at `config.endpoint`. */
export function createS3BlobStore(
  config: ObjectStoreConfig,
  deps: S3BlobStoreDeps = {},
): BlobStore {
  const clock = deps.clock ?? Date.now;
  const base = new URL(config.endpoint);
  const prefix = base.pathname.split('/').filter(Boolean);
  const credentials = (): SigningCredentials => ({
    accessKeyId: config.accessKeyId.reveal(),
    secretAccessKey: config.secretAccessKey.reveal(),
    region: config.region,
    service: 's3',
  });

  /** Sends one signed request; resolves to its status and body. */
  function send(
    method: 'PUT' | 'GET' | 'DELETE',
    segments: string[],
    opts: {
      query?: Record<string, string>;
      body?: Uint8Array;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{ status: number; body: Buffer }> {
    const now = new Date(clock());
    const payloadHash = opts.body === undefined ? EMPTY_SHA256 : sha256(opts.body);
    const headers: Record<string, string> = {
      ...opts.headers,
      ...(opts.body === undefined ? {} : { 'content-length': String(opts.body.byteLength) }),
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate(now),
    };
    const authorization = authorizationHeader(
      {
        method,
        host: base.host,
        segments,
        ...(opts.query === undefined ? {} : { query: opts.query }),
        headers,
      },
      credentials(),
      now,
      payloadHash,
    );
    const query = opts.query === undefined ? '' : `?${canonicalQuery(opts.query)}`;
    const request = base.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = request(
        {
          protocol: base.protocol,
          hostname: base.hostname,
          port: base.port === '' ? undefined : Number(base.port),
          method,
          path: `${canonicalPath(segments)}${query}`,
          headers: { ...headers, host: base.host, authorization },
          timeout: BLOB_IDLE_TIMEOUT_MS,
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
          );
          res.on('error', () => reject(new BlobStoreError(`${method} response failed`)));
        },
      );
      req.on('timeout', () => req.destroy(new BlobStoreError(`${method} timed out`)));
      req.on('error', (err) =>
        reject(err instanceof BlobStoreError ? err : new BlobStoreError(`${method} failed`)),
      );
      req.end(opts.body === undefined ? undefined : Buffer.from(opts.body));
    });
  }

  const objectSegments = (key: string): string[] => [...prefix, config.bucket, ...key.split('/')];
  const ok = (status: number): boolean => status >= 200 && status <= 299;

  return {
    async put(key, body, opts = {}) {
      const { status } = await send('PUT', objectSegments(key), {
        body,
        headers: { 'content-type': opts.contentType ?? BATCH_CONTENT_TYPE },
      });
      if (!ok(status)) throw new BlobStoreError(`PUT answered ${status}`);
    },
    async get(key) {
      const { status, body } = await send('GET', objectSegments(key));
      if (status === 404) throw new BlobNotFoundError(key);
      if (!ok(status)) throw new BlobStoreError(`GET answered ${status}`);
      return new Uint8Array(body);
    },
    async delete(keys) {
      for (const key of keys) {
        const { status } = await send('DELETE', objectSegments(key));
        if (status !== 404 && !ok(status)) throw new BlobStoreError(`DELETE answered ${status}`);
      }
    },
    async list(keyPrefix) {
      const keys: string[] = [];
      let token: string | undefined;
      for (;;) {
        const query: Record<string, string> = {
          'list-type': '2',
          prefix: keyPrefix,
          'max-keys': String(LIST_PAGE),
          ...(token === undefined ? {} : { 'continuation-token': token }),
        };
        const { status, body } = await send('GET', [...prefix, config.bucket], { query });
        if (!ok(status)) throw new BlobStoreError(`LIST answered ${status}`);
        const xml = body.toString('utf8');
        keys.push(...xmlValues(xml, 'Key'));
        const truncated = xmlValues(xml, 'IsTruncated')[0] === 'true';
        token = xmlValues(xml, 'NextContinuationToken')[0];
        if (!truncated || token === undefined) break;
      }
      return keys.sort();
    },
  };
}
