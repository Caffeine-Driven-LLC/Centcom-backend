/**
 * AWS Signature Version 4 for S3-compatible stores (B082): signed request headers, and pre-signed
 * URLs (query-string authentication). R2 and MinIO accept both.
 *
 * Owns: canonical requests, the signing key and the signature. Must not: put a secret anywhere but
 * the HMAC key.
 */
import { createHash, createHmac } from 'node:crypto';

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';
/** The payload hash of a pre-signed URL: the body is not signed. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
/** SHA-256 of nothing, for requests without a body. */
export const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

/** Who signs, and where. */
export interface SigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** `s3`. */
  service: string;
}

/** A request to sign: the host (with its port when not the default) and the path, unencoded. */
export interface SignableRequest {
  method: string;
  host: string;
  /** Path segments, unencoded; each is encoded once (S3 does not double-encode). */
  segments: readonly string[];
  /** Query parameters, unencoded. */
  query?: Readonly<Record<string, string>>;
  /** Headers to sign besides host, any case; values are trimmed. */
  headers?: Readonly<Record<string, string>>;
}

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

const sha256Hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');

/** RFC 3986 percent-encoding: everything but `A-Z a-z 0-9 - _ . ~`. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `YYYYMMDDTHHMMSSZ`. */
export const amzDate = (now: Date): string =>
  now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/** The request's path, as sent and as signed. */
export const canonicalPath = (segments: readonly string[]): string =>
  `/${segments.map(encodeRfc3986).join('/')}`;

/** The query, as sent and as signed: encoded pairs sorted by name, then value. */
export function canonicalQuery(query: Readonly<Record<string, string>> = {}): string {
  return Object.entries(query)
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function scopeOf(credentials: SigningCredentials, date: string): string {
  return `${date.slice(0, 8)}/${credentials.region}/${credentials.service}/aws4_request`;
}

/** The signature of `request` at `date` (`amzDate`) over `payloadHash`, and its signed headers. */
function sign(
  request: SignableRequest,
  credentials: SigningCredentials,
  date: string,
  payloadHash: string,
): { signature: string; signedHeaders: string } {
  const headers = new Map<string, string>([['host', request.host]]);
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    headers.set(name.toLowerCase(), value.trim().replace(/\s+/g, ' '));
  }
  const names = [...headers.keys()].sort();
  const signedHeaders = names.join(';');
  const canonical = [
    request.method,
    canonicalPath(request.segments),
    canonicalQuery(request.query),
    names.map((name) => `${name}:${headers.get(name) ?? ''}\n`).join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = scopeOf(credentials, date);
  const toSign = [SIGV4_ALGORITHM, date, scope, sha256Hex(canonical)].join('\n');
  let key = hmac(`AWS4${credentials.secretAccessKey}`, date.slice(0, 8));
  key = hmac(key, credentials.region);
  key = hmac(key, credentials.service);
  key = hmac(key, 'aws4_request');
  return { signature: hmac(key, toSign).toString('hex'), signedHeaders };
}

/**
 * The headers that authorise `request` (its own headers must already hold `x-amz-date` equal to
 * `amzDate(now)` and `x-amz-content-sha256`): `authorization`, to add to them.
 */
export function authorizationHeader(
  request: SignableRequest,
  credentials: SigningCredentials,
  now: Date,
  payloadHash: string,
): string {
  const date = amzDate(now);
  const { signature, signedHeaders } = sign(request, credentials, date, payloadHash);
  return (
    `${SIGV4_ALGORITHM} Credential=${credentials.accessKeyId}/${scopeOf(credentials, date)}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

/**
 * The query string that pre-signs `request` (host the only signed header) for `expiresS` seconds
 * from `now`: the request's own query, then the `X-Amz-*` parameters, sorted and encoded.
 */
export function presignQuery(
  request: Omit<SignableRequest, 'headers'>,
  credentials: SigningCredentials,
  now: Date,
  expiresS: number,
): string {
  const date = amzDate(now);
  const query: Record<string, string> = {
    ...request.query,
    'X-Amz-Algorithm': SIGV4_ALGORITHM,
    'X-Amz-Credential': `${credentials.accessKeyId}/${scopeOf(credentials, date)}`,
    'X-Amz-Date': date,
    'X-Amz-Expires': String(expiresS),
    'X-Amz-SignedHeaders': 'host',
  };
  const { signature } = sign({ ...request, query }, credentials, date, UNSIGNED_PAYLOAD);
  return `${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}
