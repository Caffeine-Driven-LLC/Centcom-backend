/**
 * `return_to` (B015, shared with B014): where a browser login sends the user back to. Only URLs
 * on the configured allow-list (`LOGIN_RETURN_TO_ALLOWLIST`), compared exactly, are honoured;
 * anything else (another host, `//evil.example`, `javascript:`, a path) becomes the default, the
 * list's first entry. There is no open redirect.
 *
 * Owns: the decision. Must not: match by prefix, host or pattern.
 */
import { z } from '@centcom/core';

/** At most this many entries, of at most 2048 characters each. */
export const MAX_RETURN_TO_ENTRIES = 32;

/** The checked allow-list: absolute http(s) URLs without credentials or fragments, the first being the default. */
export const returnToAllowlistSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  )
  .superRefine((entries, ctx) => {
    if (entries.length === 0 || entries.length > MAX_RETURN_TO_ENTRIES) {
      ctx.addIssue({
        code: 'custom',
        message: `must list 1 to ${MAX_RETURN_TO_ENTRIES} URLs, comma-separated`,
      });
    }
    for (const [i, entry] of entries.entries()) {
      let url: URL | undefined;
      try {
        url = new URL(entry);
      } catch {
        url = undefined;
      }
      if (
        url === undefined ||
        entry.length > 2048 ||
        (url.protocol !== 'https:' && url.protocol !== 'http:') ||
        url.username !== '' ||
        url.password !== '' ||
        url.hash !== ''
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `entry ${i + 1} must be an absolute http(s) URL without credentials or a fragment`,
        });
      }
    }
  });

/** Resolves `return_to` candidates against an allow-list. */
export interface ReturnToPolicy {
  /** The first entry: where a login goes when `return_to` is missing or not allowed. */
  readonly fallback: string;
  /** `candidate` when it is exactly an allow-listed URL, else `fallback`. */
  resolve(candidate: unknown): string;
}

/** A policy over checked entries (see `returnToAllowlistSchema`). */
export function returnToPolicy(allowlist: readonly string[]): ReturnToPolicy {
  const [fallback] = allowlist;
  if (fallback === undefined) throw new TypeError('returnToPolicy: the allow-list is empty');
  const allowed = new Set(allowlist);
  return {
    fallback,
    resolve: (candidate) =>
      typeof candidate === 'string' && allowed.has(candidate) ? candidate : fallback,
  };
}
