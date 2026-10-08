/**
 * Fragment safety (B033, CT-DEEPLINK, CT-CRYPTO §4). An invite's E2E key travels only in the
 * fragment of the link a client shares (`https://centcom.dev/j/<token>#k=<base64url>`), which no
 * browser sends to a server. So nothing the server builds may carry a fragment
 * (`assertServerUrl`), and `withKeyFragment` exists for tests that play a client.
 *
 * Owns: the two helpers. Must not: be called with a real key outside a test; server code never
 * calls `withKeyFragment` (a test in this package checks the sources).
 */

/** A key in a `#k=` fragment: base64url, 1 to 256 characters. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Returns `url` when it has no fragment; throws a TypeError otherwise. Builders pass every URL
 * through it, so a token or id with `#` in it can never put one there.
 */
export function assertServerUrl(url: string): string {
  if (url.includes('#')) throw new TypeError('a server-side URL must not carry a fragment');
  return url;
}

/**
 * `url#k=<key>`: what a client hands on after it adds an invite's key (tests only; see above).
 * Throws a TypeError when `url` already has a fragment or the key is not base64url.
 */
export function withKeyFragment(url: string, keyB64u: string): string {
  if (!KEY_PATTERN.test(keyB64u))
    throw new TypeError('the key must be 1 to 256 base64url characters');
  return `${assertServerUrl(url)}#k=${keyB64u}`;
}
