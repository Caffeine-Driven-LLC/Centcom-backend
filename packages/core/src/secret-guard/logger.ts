/**
 * Surface 1, the logger (B101): `createGuardedLogger(base)` runs every message and field set
 * through the scanner before the B005 logger sees them, replaces matches with
 * `[redacted:<pattern id>]`, counts the hit and writes one `secret_guard_hit` warning that holds the
 * pattern id and the surface, never the text. It fails open: text the scanner cannot handle (too
 * deep, too many nodes) is replaced by `[unscannable]` and the line is still written.
 *
 * Owns: the wrapping. Must not: put matched text anywhere, drop a log line, or throw into a caller.
 */
import type { LogFields, LogFn, Logger } from '../log/logger.js';
import type { LogLevel } from '../config/base.js';
import type { Metrics } from '../log/metrics.js';
import { guardMetrics } from './metrics.js';
import { redactJsonCollect, redactTextCollect } from './redact.js';
import { ScanLimitError } from './scan.js';

/** What replaces a value the scanner could not walk. */
export const UNSCANNABLE = '[unscannable]';

/** Options for `createGuardedLogger`. */
export interface GuardedLoggerOptions {
  metrics?: Metrics;
}

type EmitLevel = Exclude<LogLevel, 'silent'>;
const LEVELS: readonly EmitLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

/** Wraps `base`; the result is a `Logger` like any other, so it can replace it where it is created. */
export function createGuardedLogger(base: Logger, o: GuardedLoggerOptions = {}): Logger {
  const metrics = guardMetrics(o.metrics);

  const report = (log: Logger, pattern: string): void => {
    metrics.hit('log', pattern);
    log.warn({ surface: 'log', pattern }, 'secret_guard_hit');
  };

  const guardFields = (log: Logger, fields: LogFields): LogFields => {
    try {
      const { value, hits } = redactJsonCollect(fields);
      for (const h of hits) report(log, h.pattern);
      return value;
    } catch (err) {
      if (!(err instanceof ScanLimitError)) throw err;
      return { fields: UNSCANNABLE };
    }
  };

  const guardMessage = (log: Logger, msg: string): string => {
    const r = redactTextCollect(msg);
    for (const h of r.hits) report(log, h.pattern);
    return r.text;
  };

  const wrap = (log: Logger): Logger => {
    const method = (level: EmitLevel): LogFn =>
      ((a: string | LogFields, b?: string): void => {
        if (!log.isLevelEnabled(level)) return;
        try {
          if (typeof a === 'string') {
            log[level](guardMessage(log, a));
          } else {
            const fields = guardFields(log, a);
            if (b === undefined) log[level](fields);
            else log[level](fields, guardMessage(log, b));
          }
        } catch {
          // fail open with a fixed placeholder: the line is more useful than silence
          log[level]({ fields: UNSCANNABLE }, UNSCANNABLE);
        }
      }) as LogFn;
    const guarded: Record<string, unknown> = {
      get level() {
        return log.level;
      },
      isLevelEnabled: (level: LogLevel) => log.isLevelEnabled(level),
      child: (bindings: LogFields) => wrap(log.child(guardFields(log, bindings))),
    };
    for (const level of LEVELS) guarded[level] = method(level);
    return guarded as unknown as Logger;
  };

  return wrap(base);
}
