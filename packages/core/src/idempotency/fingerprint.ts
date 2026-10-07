/**
 * Request fingerprints (B024, CT-PAGE): what makes two POSTs under one Idempotency-Key "the same
 * request": the method, the route template, the path parameters and the body, as canonical JSON
 * (object keys sorted, so key order never matters), hashed with SHA-256.
 *
 * Owns: canonical JSON and the fingerprint. Must not: depend on key order or whitespace, or
 * compare fingerprints in a time that depends on where they differ.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** The prefix of every fingerprint. */
export const FINGERPRINT_PREFIX = 'sha256:';

const isPlainObject = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * `value` as canonical JSON: object keys sorted by code unit, no whitespace, `undefined` members
 * left out (as JSON.stringify does). Bytes (a Buffer or Uint8Array body) become
 * `{"$bytes":"<base64>"}`. Throws a TypeError for anything a request body cannot hold
 * (functions, symbols, bigints, class instances, non-finite numbers).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: numbers must be finite');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: a ${typeof value} has no JSON form`);
  }
  if (value instanceof Uint8Array) {
    return `{"$bytes":${JSON.stringify(Buffer.from(value).toString('base64'))}}`;
  }
  if (Array.isArray(value)) {
    const items = value.map((item: unknown) => (item === undefined ? 'null' : canonicalJson(item)));
    return `[${items.join(',')}]`;
  }
  if (!isPlainObject(value)) {
    throw new TypeError('canonicalJson: only plain objects have a JSON form');
  }
  const object = value as Record<string, unknown>;
  const members = Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
  return `{${members.join(',')}}`;
}

/**
 * The fingerprint of a request: `sha256:<hex>` over the canonical JSON of
 * `[METHOD, route template, path params, body]` (a missing body counts as null). The params'
 * own properties count, whatever object holds them (Fastify's has a prototype of its own).
 */
export function fingerprintRequest(
  method: string,
  route: string,
  params: object,
  body: unknown,
): string {
  const canonical = canonicalJson([method.toUpperCase(), route, { ...params }, body ?? null]);
  return FINGERPRINT_PREFIX + createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** True if two fingerprints are equal; compared in constant time (for equal lengths). */
export function fingerprintsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
