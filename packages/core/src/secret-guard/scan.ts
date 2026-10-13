/**
 * The scanner (B101): `scanText` finds provider credentials in a string and `scanJson` walks keys
 * and string values of a JSON-like value. A hit is `{pattern, offset, length}`, never the text.
 *
 * Speed: every pattern has trigger text (`indexOf`) that must be present before its regex runs, so
 * clean text costs a few memchr calls. The JWT pattern is matched by a linear walk over dot
 * segments instead of its regex, because `eyJ[...]{10,}\.` backtracks quadratically on a long run
 * of `eyJeyJ...` (a test proves the walk and the contract regex agree on random input).
 *
 * Owns: finding matches and removing overlapping ones. Must not: return, log or hash matched
 * text, decode anything, or run without the caps (depth 32, 100 000 nodes, the caller's deadline).
 */
import { performance } from 'node:perf_hooks';
import { EMPTY_ALLOW_LIST, type AllowList, type Location } from './allow.js';
import { loadPatterns, mayMatch, type Hit, type Pattern } from './patterns.js';

export type { Hit } from './patterns.js';

/** Deepest value `scanJson` walks. */
export const MAX_JSON_DEPTH = 32;
/** Most nodes (keys and values) `scanJson` visits. */
export const MAX_JSON_NODES = 100_000;
/** The per-request time budget of the rejecting surfaces (CT card: 20 ms). */
export const SCAN_BUDGET_MS = 20;

/** Why a scan stopped without an answer. Rejecting surfaces treat it as "reject". */
export class ScanLimitError extends Error {
  readonly reason: 'depth' | 'nodes' | 'budget';
  constructor(reason: 'depth' | 'nodes' | 'budget') {
    super(`secret-guard: scan stopped (${reason})`);
    this.name = 'ScanLimitError';
    this.reason = reason;
  }
}

/** Options of `scanText` and `scanJson`. */
export interface ScanOptions {
  /** Hits covered by an entry (pattern id plus location) are left out. */
  allow?: AllowList;
  /** Where the scan happens, for the allow-list. */
  location?: Location;
  /** `scanJson` only: default MAX_JSON_DEPTH (lower only). */
  maxDepth?: number;
  /** `scanJson` only: stop with `ScanLimitError('budget')` after this many milliseconds. */
  budgetMs?: number;
}

interface Raw {
  readonly idx: number;
  readonly pattern: string;
  readonly offset: number;
  readonly length: number;
}

const JWT_ID = 'openai_oauth_access';

/** `[A-Za-z0-9_-]`, the class every JWT segment is made of. */
function isSegmentChar(c: number): boolean {
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45
  );
}

function segmentEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && isSegmentChar(text.charCodeAt(i))) i += 1;
  return i;
}

/**
 * The matches of the contract's `openai_oauth_access` regex, in linear time: `eyJ`, 10 or more
 * segment characters, a dot, 10 or more, a dot, 10 or more (greedy). Only the first `eyJ` of a
 * segment can start a match, because a later one has fewer characters left in that segment.
 */
function jwtMatches(text: string, idx: number, out: Raw[]): void {
  let cursor = 0;
  for (;;) {
    const start = text.indexOf('eyJ', cursor);
    if (start < 0) return;
    const aEnd = segmentEnd(text, start + 3);
    cursor = aEnd;
    if (aEnd - (start + 3) < 10 || text.charCodeAt(aEnd) !== 46) continue;
    const bEnd = segmentEnd(text, aEnd + 1);
    if (bEnd - (aEnd + 1) < 10 || text.charCodeAt(bEnd) !== 46) continue;
    const cEnd = segmentEnd(text, bEnd + 1);
    if (cEnd - (bEnd + 1) < 10) continue;
    out.push({ idx, pattern: JWT_ID, offset: start, length: cEnd - start });
    cursor = cEnd;
  }
}

function regexMatches(pattern: Pattern, idx: number, text: string, out: Raw[]): void {
  const re = pattern.regex;
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    out.push({ idx, pattern: pattern.id, offset: m.index, length: m[0].length });
  }
  re.lastIndex = 0;
}

/** Hits of `text` before the allow-list: in order, none overlapping (the earliest, then the first pattern, wins). */
export function scanTextRaw(text: string): Hit[] {
  if (text.length < 20) return []; // the shortest match (AKIA plus 16) is 20 characters
  const raw: Raw[] = [];
  const patterns = loadPatterns();
  for (let idx = 0; idx < patterns.length; idx += 1) {
    const pattern = patterns[idx];
    if (pattern === undefined || !mayMatch(pattern, text)) continue;
    if (pattern.id === JWT_ID) jwtMatches(text, idx, raw);
    else regexMatches(pattern, idx, text, raw);
  }
  if (raw.length === 0) return [];
  raw.sort((a, b) => a.offset - b.offset || a.idx - b.idx);
  const hits: Hit[] = [];
  let end = 0;
  for (const r of raw) {
    if (r.offset < end) continue;
    hits.push({ pattern: r.pattern, offset: r.offset, length: r.length });
    end = r.offset + r.length;
  }
  return hits;
}

/** Finds provider credentials in `text`. */
export function scanText(text: string, o: ScanOptions = {}): Hit[] {
  const hits = scanTextRaw(text);
  const allow = o.allow ?? EMPTY_ALLOW_LIST;
  return allow.entries.length === 0
    ? hits
    : hits.filter((h) => !allow.allows(h.pattern, o.location));
}

type Visit = (text: string) => void;

const isPlain = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Calls `visit` with every key and string value of `value` (plain objects, arrays, and the name,
 * message, stack and properties of Errors; anything else is skipped). Throws `ScanLimitError` past
 * the depth or node cap, or the deadline.
 */
export function walkStrings(
  value: unknown,
  visit: Visit,
  o: { maxDepth?: number; deadline?: number } = {},
): void {
  const maxDepth = Math.min(o.maxDepth ?? MAX_JSON_DEPTH, MAX_JSON_DEPTH);
  let nodes = 0;
  const ancestors = new Set<object>();
  const tick = (): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new ScanLimitError('nodes');
    if (o.deadline !== undefined && (nodes & 255) === 0 && performance.now() > o.deadline) {
      throw new ScanLimitError('budget');
    }
  };
  const walk = (v: unknown, depth: number): void => {
    tick();
    if (typeof v === 'string') {
      visit(v);
      return;
    }
    if (typeof v !== 'object' || v === null) return;
    if (depth >= maxDepth) throw new ScanLimitError('depth');
    if (ancestors.has(v)) return;
    ancestors.add(v);
    try {
      if (Array.isArray(v)) {
        for (const item of v as unknown[]) walk(item, depth + 1);
      } else if (v instanceof Error) {
        walk(v.name, depth + 1);
        walk(v.message, depth + 1);
        if (typeof v.stack === 'string') walk(v.stack, depth + 1);
        if (v.cause !== undefined) walk(v.cause, depth + 1);
        for (const key of Object.keys(v)) {
          tick();
          visit(key);
          walk((v as unknown as Record<string, unknown>)[key], depth + 1);
        }
      } else if (isPlain(v)) {
        const record = v as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          tick();
          visit(key);
          walk(record[key], depth + 1);
        }
      }
    } finally {
      ancestors.delete(v);
    }
  };
  walk(value, 0);
  if (o.deadline !== undefined && performance.now() > o.deadline)
    throw new ScanLimitError('budget');
}

/** Finds provider credentials in the keys and string values of `value`. Offsets are per string. */
export function scanJson(value: unknown, o: ScanOptions = {}): Hit[] {
  const hits: Hit[] = [];
  const deadline = o.budgetMs === undefined ? undefined : performance.now() + o.budgetMs;
  walkStrings(
    value,
    (text) => {
      for (const h of scanText(text, o)) hits.push(h);
    },
    {
      ...(o.maxDepth === undefined ? {} : { maxDepth: o.maxDepth }),
      ...(deadline === undefined ? {} : { deadline }),
    },
  );
  return hits;
}
