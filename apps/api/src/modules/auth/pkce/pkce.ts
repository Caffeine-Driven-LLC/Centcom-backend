/**
 * PKCE (B018, RFC 7636): the `S256` transform and the shapes of a `code_verifier` and an `S256`
 * `code_challenge`. Only `S256` exists here; `plain` is never accepted (CT-AUTH).
 *
 * Owns: checking a verifier against a challenge, in constant time. Must not: accept `plain`, or
 * compare a challenge with `===`.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** RFC 7636 §4.1: 43 to 128 unreserved characters. */
export const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** BASE64URL(SHA256(verifier)) without padding: always 43 characters (RFC 7636 §4.2). */
export const S256_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** True for a well-formed `code_verifier`. */
export const isCodeVerifier = (value: unknown): value is string =>
  typeof value === 'string' && CODE_VERIFIER_PATTERN.test(value);

/** True for a well-formed `S256` `code_challenge`. */
export const isS256Challenge = (value: unknown): value is string =>
  typeof value === 'string' && S256_CHALLENGE_PATTERN.test(value);

/** The `S256` challenge of a verifier: BASE64URL(SHA256(ASCII(verifier))). */
export const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url');

/**
 * True when `verifier` is well formed and its `S256` transform equals `challenge`. The comparison
 * runs in constant time; a malformed verifier or challenge is false, never an exception.
 */
export function verifyS256(verifier: string, challenge: string): boolean {
  if (!isCodeVerifier(verifier) || !isS256Challenge(challenge)) return false;
  return timingSafeEqual(Buffer.from(s256(verifier), 'ascii'), Buffer.from(challenge, 'ascii'));
}
