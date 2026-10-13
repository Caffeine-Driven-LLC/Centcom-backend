/**
 * Surface 2b, WebSocket frames (B101): `guardFrame` scans the clear parts of an envelope (`t`, `k`,
 * ids, timestamps and the clear payload `p`) and answers `invalid_frame` when one holds a
 * provider credential. The relay lane that mounts it sends `sys.error` `invalid_frame`.
 *
 * Ciphertext rule (CT-CRYPTO): `ct` is never read, decoded or scanned, and neither is `sig`; the
 * module has no key material. `stripCiphertext` is the only way a frame reaches the scanner, and it
 * copies keys without reading those two properties.
 *
 * Owns: the clear-part scan. Must not: touch `ct`, log matched text, or let a scanner failure pass
 * a frame (it fails closed).
 */
import type { Logger } from '../log/logger.js';
import type { Metrics } from '../log/metrics.js';
import { performance } from 'node:perf_hooks';
import type { AllowList } from './allow.js';
import { guardMetrics } from './metrics.js';
import { SCAN_BUDGET_MS, scanJson } from './scan.js';

/** The fields that carry ciphertext or a signature over it: never scanned. */
const OPAQUE_FIELDS: ReadonlySet<string> = new Set(['ct', 'sig']);

/** A shallow copy of `frame` without `ct` and `sig`. Reads no property it leaves out. */
export function stripCiphertext(frame: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(frame)) {
    if (!OPAQUE_FIELDS.has(key)) out[key] = frame[key];
  }
  return out;
}

/** The result of `guardFrame`. */
export type FrameVerdict = { ok: true } | { ok: false; code: 'invalid_frame'; pattern: string };

/** Options for `guardFrame`. */
export interface GuardFrameOptions {
  allow?: AllowList;
  metrics?: Metrics;
  /** Gets `{surface, pattern, kind, size}` on a rejection. */
  logger?: Logger;
}

/** `pattern` of a verdict when the scan itself failed (too deep, too big, too slow, not an object). */
export const UNSCANNABLE_PATTERN = 'unscannable';

/** Scans the clear parts of `frame`. */
export function guardFrame(frame: unknown, o: GuardFrameOptions = {}): FrameVerdict {
  const metrics = guardMetrics(o.metrics);
  const started = performance.now();
  let pattern: string | undefined;
  try {
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
      pattern = UNSCANNABLE_PATTERN;
    } else {
      const clear = stripCiphertext(frame as Record<string, unknown>);
      const hits = scanJson(clear, {
        ...(o.allow === undefined ? {} : { allow: o.allow }),
        budgetMs: SCAN_BUDGET_MS,
      });
      pattern = hits[0]?.pattern;
    }
  } catch (err) {
    void err; // any failure (limits, a throwing getter) rejects the frame: fail closed
    pattern = UNSCANNABLE_PATTERN;
  }
  metrics.scanned('frame', (performance.now() - started) / 1000);
  if (pattern === undefined) return { ok: true };
  metrics.hit('frame', pattern);
  if (o.logger !== undefined) {
    const kind =
      typeof frame === 'object' &&
      frame !== null &&
      typeof (frame as { k?: unknown }).k === 'string'
        ? (frame as { k: string }).k.slice(0, 64)
        : 'unknown';
    o.logger.warn({ surface: 'frame', pattern, kind }, 'secret_guard_hit');
  }
  return { ok: false, code: 'invalid_frame', pattern };
}
