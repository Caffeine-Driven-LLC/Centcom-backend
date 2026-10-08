/**
 * Link tokens (B033, CT-DEEPLINK): single-purpose, 160 bits from the platform CSPRNG, written as 27
 * base64url characters, and expiring (`LINK_TTL`: invites 7 days, share links 24 h at most).
 *
 * Owns: making tokens and their lifetimes. Must not: derive a token from an id or the time, fall
 * back to a weaker source when the CSPRNG fails, or use a non-cryptographic generator (a test in
 * this package checks the sources).
 */
import { randomBytes } from 'node:crypto';

/** Token bytes: 160 bits. */
export const LINK_TOKEN_BYTES = 20;

/** How long links last, in seconds: an invite exactly, a share link at most. */
export const LINK_TTL = Object.freeze({ invite_s: 604_800, share_link_max_s: 86_400 });

/** Where token bytes come from. Tests pass a seeded source; production uses the CSPRNG. */
export interface RandomSource {
  bytes(n: number): Uint8Array;
}

/** The platform CSPRNG. */
export const cryptoRandomSource: RandomSource = { bytes: (n) => randomBytes(n) };

/**
 * A new link token: 20 bytes from `rng` (default the CSPRNG) as base64url. Throws when the source
 * fails or gives the wrong number of bytes; callers answer 500, never a weaker token.
 */
export function generateLinkToken(rng: RandomSource = cryptoRandomSource): string {
  const bytes = rng.bytes(LINK_TOKEN_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.length !== LINK_TOKEN_BYTES) {
    throw new Error('the random source did not give 20 bytes for a link token');
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}
