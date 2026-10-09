/**
 * The relay's log scrubber (B050): a logger over B005's that keeps only allowlisted fields
 * (`allowlists.ts`) of every line and every child's bindings, at any depth up to MAX_DEPTH, and
 * drops everything else, whatever the level (debug and trace included). Objects are walked once
 * (circular references are cut, never followed); nothing here throws into a caller. B005's own
 * redaction still runs after it.
 *
 * Owns: the field filter. Must not: let a field outside the allowlist through, or throw.
 */
import type { LogFields, Logger, LogFn } from '@centcom/core';
import { LOG_FIELDS, NEVER_LOGGED } from './allowlists.js';

/** Deeper values are dropped. */
export const MAX_DEPTH = 5;

/** `value` with only allowlisted keys (recursively), cycles and depth cut. */
export function scrubFields(
  value: unknown,
  allowed: ReadonlySet<string> = LOG_FIELDS,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_DEPTH || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => scrubFields(item, allowed, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (!allowed.has(key) || NEVER_LOGGED.has(key)) continue;
    const kept = scrubFields(inner, allowed, depth + 1, seen);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/** The card's `createRelayLogger`: `base` with every line's fields scrubbed. */
export function createRelayLogger(base: Logger): Logger {
  const wrap = (method: LogFn): LogFn =>
    ((first: unknown, msg?: string) => {
      if (typeof first === 'string') {
        method(first);
        return;
      }
      let fields: LogFields;
      try {
        fields = (scrubFields(first) ?? {}) as LogFields;
      } catch {
        fields = {};
      }
      if (msg === undefined) method(fields);
      else method(fields, msg);
    }) as LogFn;
  const logger = {
    get level() {
      return base.level;
    },
    isLevelEnabled: (level: Parameters<Logger['isLevelEnabled']>[0]) => base.isLevelEnabled(level),
    child: (bindings: LogFields) =>
      createRelayLogger(base.child((scrubFields(bindings) ?? {}) as LogFields)),
  } as Logger;
  for (const level of LEVELS) {
    (logger as unknown as Record<string, LogFn>)[level] = wrap(base[level].bind(base) as LogFn);
  }
  return logger;
}
