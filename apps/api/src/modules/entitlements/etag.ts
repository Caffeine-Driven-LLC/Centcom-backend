/**
 * ETags of entitlements (B069, CT-PAGE conditional requests): a strong ETag naming the revision
 * and a digest of the whole body, so usage that moves without a new revision still changes it.
 * `If-None-Match` is compared weakly (RFC 9110 §13.1.2): `W/"x"` matches `"x"`, `*` matches any.
 *
 * Owns: the ETag format. Must not: be parsed by clients (it is opaque; `rev` is in the body).
 */
import { createHash } from 'node:crypto';
import type { Entitlements } from './ports.js';

/** The ETag of `body`: `"e<rev>.<16 base64url characters of its sha256>"`. */
export function entitlementsEtag(body: Entitlements): string {
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('base64url');
  return `"e${body.rev}.${digest.slice(0, 16)}"`;
}

/** True when an `If-None-Match` header lists `etag` (weakly) or is `*`. */
export function ifNoneMatchHits(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const opaque = etag.replace(/^W\//, '');
  return (Array.isArray(header) ? header : [header])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .some((value) => value === '*' || value.replace(/^W\//, '') === opaque);
}
