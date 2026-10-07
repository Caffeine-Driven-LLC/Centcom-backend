/**
 * Workspace slugs (B027, CT-IDS `[a-z0-9-]{3,40}`). Without one from the caller, the slug comes
 * from the name: accents dropped, lower case, every run of other characters one `-`; a name with
 * no letters or digits a slug can keep gives `workspace`. A taken slug gets the next numeric
 * suffix after the highest in use (`acme`, `acme-2`, `acme-3`).
 *
 * Owns: making slugs. Must not: produce anything outside the CT-IDS slug pattern.
 */
import { SLUG_PATTERN } from '@centcom/contracts';

/** Longest slug made from a name: room is left for a suffix of up to six digits (`-999999`). */
export const SLUG_BASE_MAX = 33;
/** The slug of a name with nothing a slug can keep. */
export const FALLBACK_SLUG = 'workspace';
/** A base shorter than three characters is padded to a valid slug with this. */
const SHORT_PADDING = '-ws';

/** The slug a name suggests (CT-IDS pattern, at most SLUG_BASE_MAX characters). */
export function slugFromName(name: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLowerCase();
  let slug = ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_BASE_MAX)
    .replace(/-+$/, '');
  if (slug.length === 0) return FALLBACK_SLUG;
  if (slug.length < 3) slug = `${slug}${SHORT_PADDING}`;
  return slug;
}

/**
 * `base` if it is free, else `base-<n>` with n one above the highest numeric suffix in `taken`
 * (at least 2). `taken` holds the slugs in use that are `base` or start with `base-`.
 */
export function nextSlug(base: string, taken: readonly string[]): string {
  if (!SLUG_PATTERN.test(base)) throw new TypeError('nextSlug: the base is not a slug');
  if (!taken.includes(base)) return base;
  let highest = 1;
  for (const slug of taken) {
    const suffix = slug.startsWith(`${base}-`) ? slug.slice(base.length + 1) : '';
    if (/^[1-9]\d{0,5}$/.test(suffix)) highest = Math.max(highest, Number(suffix));
  }
  const candidate = `${base}-${highest + 1}`;
  // A base of 34-40 characters (a caller's own slug is never suffixed, so only in theory) or a
  // seven-digit suffix would overflow: cut the base, never the suffix.
  return candidate.length <= 40
    ? candidate
    : `${base.slice(0, 40 - String(highest + 1).length - 1).replace(/-+$/, '')}-${highest + 1}`;
}
