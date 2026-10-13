/**
 * The provider-credential patterns (B101): the contract's `secret-patterns.json`, compiled once
 * from `patterns.generated.ts` (so a missing file at run time cannot switch the guard off), each
 * with the cheap text that must be present for it to match.
 *
 * Owns: the compiled patterns and their trigger prefilter. Must not: add or change a pattern (a
 * contract change), or expose a way to read what a pattern matched other than offsets.
 */
import { GENERATED_PATTERNS } from './patterns.generated.js';

/** What the guard reports about a match: never the matched text, a prefix, a suffix or a hash. */
export interface Hit {
  /** The contract pattern id, such as `anthropic_api_key`. */
  readonly pattern: string;
  /** UTF-16 offset of the match in the scanned string (or byte offset in a stream). */
  readonly offset: number;
  /** Length of the match, in the same units. */
  readonly length: number;
}

/** One compiled pattern. */
export interface Pattern {
  readonly id: string;
  /** Global, so it can be run with `lastIndex`; reset before every use. */
  readonly regex: RegExp;
  /** A match contains at least one of these; text with none of them cannot match. */
  readonly triggers: readonly string[];
}

/**
 * The trigger text of each contract pattern. A test proves that every `must_match` string of the
 * contract holds one of its pattern's triggers, so the prefilter never hides a real match; a new
 * contract pattern without an entry here makes `loadPatterns` throw at start-up.
 */
const TRIGGERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  anthropic_api_key: ['sk-ant-'],
  openai_api_key: ['sk-'],
  openai_oauth_access: ['eyJ'],
  codex_auth_json: ['access_token', 'refresh_token', 'id_token'],
  bearer_header: ['uthorization'],
  aws_access_key: ['AKIA'],
  google_api_key: ['AIza'],
});

/** Compiles `source` (the same list the contract file holds) into patterns. Throws on a bad entry. */
export function compilePatterns(
  source: readonly { readonly id: string; readonly regex: string }[],
): readonly Pattern[] {
  const seen = new Set<string>();
  return Object.freeze(
    source.map(({ id, regex }) => {
      if (seen.has(id)) throw new Error(`secret-guard: duplicate pattern id ${id}`);
      seen.add(id);
      const triggers = TRIGGERS[id];
      if (triggers === undefined) {
        throw new Error(`secret-guard: pattern ${id} has no trigger text; add it to TRIGGERS`);
      }
      return Object.freeze({ id, regex: new RegExp(regex, 'g'), triggers });
    }),
  );
}

let compiled: readonly Pattern[] | undefined;

/** The contract patterns, compiled on first use and then shared. */
export function loadPatterns(): readonly Pattern[] {
  compiled ??= compilePatterns(GENERATED_PATTERNS);
  return compiled;
}

/** True when `text` holds a trigger of `pattern`. */
export function mayMatch(pattern: Pattern, text: string): boolean {
  for (const trigger of pattern.triggers) if (text.includes(trigger)) return true;
  return false;
}
