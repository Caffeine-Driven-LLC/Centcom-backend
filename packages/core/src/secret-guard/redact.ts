/**
 * Redaction (B101): `redactText` replaces each match with `[redacted:<pattern id>]`; `redactJson`
 * does the same inside a deep copy (keys too). The output never matches a pattern, so scanning it
 * again finds nothing.
 *
 * Owns: the replacement. Must not: mutate the input, keep any part of a match, or follow a cycle.
 */
import { performance } from 'node:perf_hooks';
import { MAX_JSON_DEPTH, MAX_JSON_NODES, ScanLimitError, scanTextRaw, type Hit } from './scan.js';

/** The replacement for a match of `patternId`. */
export const markerFor = (patternId: string): string => `[redacted:${patternId}]`;

/** True for a string that is exactly one marker (it holds only a pattern id). */
export const isMarker = (value: string): boolean => /^\[redacted:[a-z0-9_]{1,40}\]$/.test(value);

/** Passes of redaction: replacing a match can leave a neighbour that was glued to it exposed. */
const MAX_PASSES = 8;

function replaceHits(text: string, hits: readonly Hit[]): string {
  let out = '';
  let from = 0;
  for (const h of hits) {
    out += text.slice(from, h.offset) + markerFor(h.pattern);
    from = h.offset + h.length;
  }
  return out + text.slice(from);
}

/**
 * `text` with every match replaced, and the hits that were replaced. Runs until the output holds
 * no match: `AKIA...` glued in front of `sk-ant-...` hides the second from the contract's
 * lookbehind, and the marker that replaces the first would expose it.
 */
export function redactTextCollect(text: string): { text: string; hits: Hit[] } {
  let current = text;
  const all: Hit[] = [];
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const hits = scanTextRaw(current);
    if (hits.length === 0) return { text: current, hits: all };
    // offsets of the first pass are offsets in the caller's text; later passes only add to the count
    for (const h of hits) all.push(pass === 0 ? h : { ...h, offset: -1 });
    current = replaceHits(current, hits);
  }
  return { text: current, hits: all };
}

/** `text` with every match replaced by `[redacted:<pattern id>]`. */
export function redactText(text: string): string {
  return redactTextCollect(text).text;
}

const isPlain = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * A deep copy of `value` with matches replaced in every key and string, and the hits found.
 * Plain objects and arrays are copied; an Error becomes `{type, message, stack, ...properties}`;
 * other objects (dates, buffers, Secret) are returned as they are for the logger's own redaction.
 * Throws `ScanLimitError` past the depth or node cap or the optional `budgetMs`.
 */
export function redactJsonCollect<T>(
  value: T,
  o: { budgetMs?: number } = {},
): { value: T; hits: Hit[] } {
  const hits: Hit[] = [];
  let nodes = 0;
  const deadline = o.budgetMs === undefined ? undefined : performance.now() + o.budgetMs;
  const ancestors = new Set<object>();
  const text = (s: string): string => {
    const r = redactTextCollect(s);
    for (const h of r.hits) hits.push(h);
    return r.text;
  };
  const copy = (v: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new ScanLimitError('nodes');
    if (deadline !== undefined && (nodes & 255) === 0 && performance.now() > deadline) {
      throw new ScanLimitError('budget');
    }
    if (typeof v === 'string') return text(v);
    if (typeof v !== 'object' || v === null) return v;
    if (depth >= MAX_JSON_DEPTH) throw new ScanLimitError('depth');
    if (ancestors.has(v)) return '[circular]';
    const isError = v instanceof Error;
    if (!Array.isArray(v) && !isError && !isPlain(v)) return v;
    ancestors.add(v);
    try {
      if (Array.isArray(v)) return (v as unknown[]).map((item) => copy(item, depth + 1));
      const out: Record<string, unknown> = {};
      const set = (key: string, item: unknown): void => {
        const safeKey = text(key);
        Object.defineProperty(out, safeKey, {
          value: item,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      };
      const source = v as Record<string, unknown>;
      if (isError) {
        set('type', copy(v.name, depth + 1));
        set('message', copy(v.message, depth + 1));
        if (typeof v.stack === 'string') set('stack', copy(v.stack, depth + 1));
        if (v.cause !== undefined) set('cause', copy(v.cause, depth + 1));
      }
      for (const key of Object.keys(source)) set(key, copy(source[key], depth + 1));
      return out;
    } finally {
      ancestors.delete(v);
    }
  };
  return { value: copy(value, 0) as T, hits };
}

/** A deep copy of `value` with every match replaced; see `redactJsonCollect`. */
export function redactJson<T>(value: T): T {
  return redactJsonCollect(value).value;
}
