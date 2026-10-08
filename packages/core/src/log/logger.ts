/**
 * Structured logger (B005): `createLogger(opts)` returns a pino-based logger that writes one JSON
 * line per event, carrying `level`, `time`, `service`, `env`, `version`, the request context ids
 * and the caller's fields. pino's logMethod hook runs every line's fields and message through
 * `redact()` before serialisation, so no call site can skip redaction, and the pino instance is
 * never handed out.
 *
 * Owns: the line format, the level methods and the destination guard. Must not: expose pino or
 * its stream, throw into a caller because a write failed, or buffer without a bound.
 */
import { isId, type IdPrefix } from '@centcom/contracts';
import { pino, type Logger as PinoLogger } from 'pino';
import { LOG_LEVELS, type LogLevel } from '../config/base.js';
import { REDACTED } from '../config/secret.js';
import { getRequestContext } from './context.js';
import { noopMetrics, type Counter, type Metrics } from './metrics.js';
import { redact, redactText } from './redact.js';

/** Fields of one log line, or of a child logger's bindings. Redacted before they are written. */
export type LogFields = Readonly<Record<string, unknown>>;

/** One level method: a message, or fields and an optional message. */
export interface LogFn {
  (msg: string): void;
  (fields: LogFields, msg?: string): void;
}

/**
 * A structured logger. Put an error under `err` (`log.error({ err }, 'msg')`). The keys `level`,
 * `time`, `msg`, `service`, `env`, `version`, `request_id`, `session_id`, `user_id` and `trace_id` are set by
 * the logger; don't pass them as fields.
 */
export interface Logger {
  /** The least severe level that is written. */
  readonly level: LogLevel;
  /** False when lines at `level` are discarded, so expensive fields need not be built. */
  isLevelEnabled(level: LogLevel): boolean;
  fatal: LogFn;
  error: LogFn;
  warn: LogFn;
  info: LogFn;
  debug: LogFn;
  trace: LogFn;
  /** A logger that adds `bindings` (redacted) to every line. */
  child(bindings: LogFields): Logger;
}

/** Options for `createLogger`. */
export interface LoggerOptions {
  /** From `baseConfig().logLevel`. */
  level: LogLevel;
  /** From `baseConfig().serviceName`. */
  service: string;
  /** The service's build version. */
  version: string;
  /** From `baseConfig().nodeEnv`. */
  env?: string;
  /** Where lines go; default stdout through an asynchronous writer capped at MAX_LOG_BUFFER_BYTES. */
  destination?: NodeJS.WritableStream;
  /** Receives `log_dropped_total`; default no-op. */
  metrics?: Metrics;
  /** Milliseconds since the epoch, for `time`; default `Date.now`. */
  now?: () => number;
}

/** Bytes of lines waiting for a slow destination; past this, new lines are dropped and counted. */
export const MAX_LOG_BUFFER_BYTES = 4 * 1024 * 1024;

const MAX_DATE_MS = 8.64e15;

const isoTime = (ms: number): string =>
  new Date(Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? ms : Date.now()).toISOString();

/** Fields as an object pino can merge; a value that redacts to a placeholder is kept under `fields`. */
function redactFields(fields: unknown): Record<string, unknown> {
  if (fields === undefined || fields === null) return {};
  const safe = redact(fields);
  return typeof safe === 'object' && safe !== null && !Array.isArray(safe)
    ? (safe as Record<string, unknown>)
    : { fields: safe };
}

/**
 * pino's logMethod hook: the single path every line of this logger and its children takes, so
 * redaction cannot be skipped. Runs only for enabled levels. Messages are redacted like values.
 */
function logMethod(this: PinoLogger, args: unknown[], method: (...a: unknown[]) => void): void {
  const [first, second] = args;
  if (typeof first === 'string') {
    method.call(this, redactText(first));
    return;
  }
  // Untyped callers may pass an Error directly; it is logged under `err`, as pino would.
  const fields = redactFields(first instanceof Error ? { err: first } : first);
  if (typeof second === 'string') method.call(this, fields, redactText(second));
  else method.call(this, fields);
}

const contextId = (value: string, prefix: IdPrefix): string =>
  isId(prefix, value) ? value : REDACTED;

/** Request context ids for every line (ids only: anything else is redacted). */
function contextFields(): Record<string, string> {
  const ctx = getRequestContext();
  if (ctx === undefined) return {};
  const fields: Record<string, string> = { request_id: contextId(ctx.requestId, 'req') };
  if (ctx.sessionId !== undefined) fields['session_id'] = contextId(ctx.sessionId, 'ses');
  if (ctx.userId !== undefined) fields['user_id'] = contextId(ctx.userId, 'usr');
  if (ctx.traceId !== undefined) {
    fields['trace_id'] = /^[0-9a-f]{32}$/.test(ctx.traceId) ? ctx.traceId : REDACTED;
  }
  return fields;
}

/** What the guard needs from a destination: a Node Writable or pino's SonicBoom writer. */
interface Destination {
  write(line: string): unknown;
  on(event: string, listener: () => void): unknown;
  readonly destroyed?: boolean;
  /** Set as soon as a write fails; Node destroys the stream only on the next tick. */
  readonly errored?: unknown;
  readonly writableEnded?: boolean;
  readonly writableLength?: number;
}

/**
 * Wraps the destination so a failed, ended or backed-up stream drops lines and counts them in
 * `log_dropped_total` instead of throwing into the code that logged, or buffering without bound.
 * After the stream reports an error, every later line is dropped.
 */
function guardDestination(stream: Destination, dropped: Counter): { write(line: string): void } {
  let broken = false;
  // An 'error' with no listener would crash the process.
  stream.on('error', () => {
    if (!broken) dropped.inc();
    broken = true;
  });
  // The default writer emits 'drop' for a line refused by its MAX_LOG_BUFFER_BYTES cap.
  stream.on('drop', () => dropped.inc());
  return {
    write(line: string): void {
      if (
        broken ||
        stream.destroyed === true ||
        (stream.errored !== undefined && stream.errored !== null) ||
        stream.writableEnded === true ||
        (stream.writableLength ?? 0) > MAX_LOG_BUFFER_BYTES
      ) {
        dropped.inc();
        return;
      }
      try {
        stream.write(line);
      } catch {
        dropped.inc();
      }
    },
  };
}

type WritingLevel = Exclude<LogLevel, 'silent'>;

/** The Logger handed to callers; the pino instance stays private. */
class RedactingLogger implements Logger {
  readonly #pino: PinoLogger;

  constructor(instance: PinoLogger) {
    this.#pino = instance;
  }

  get level(): LogLevel {
    return this.#pino.level as LogLevel;
  }

  isLevelEnabled(level: LogLevel): boolean {
    return this.#pino.isLevelEnabled(level);
  }

  fatal(fieldsOrMsg: LogFields | string, msg?: string): void {
    this.#write('fatal', fieldsOrMsg, msg);
  }

  error(fieldsOrMsg: LogFields | string, msg?: string): void {
    this.#write('error', fieldsOrMsg, msg);
  }

  warn(fieldsOrMsg: LogFields | string, msg?: string): void {
    this.#write('warn', fieldsOrMsg, msg);
  }

  info(fieldsOrMsg: LogFields | string, msg?: string): void {
    this.#write('info', fieldsOrMsg, msg);
  }

  debug(fieldsOrMsg: LogFields | string, msg?: string): void {
    this.#write('debug', fieldsOrMsg, msg);
  }

  trace(fieldsOrMsg: LogFields | string, msg?: string): void {
    this.#write('trace', fieldsOrMsg, msg);
  }

  child(bindings: LogFields): Logger {
    // pino does not run child bindings through formatters.bindings, so they are redacted here.
    return new RedactingLogger(this.#pino.child(redactFields(bindings)));
  }

  #write(level: WritingLevel, fieldsOrMsg: LogFields | string, msg: string | undefined): void {
    if (typeof fieldsOrMsg === 'string') this.#pino[level](fieldsOrMsg);
    else if (msg === undefined) this.#pino[level](fieldsOrMsg);
    else this.#pino[level](fieldsOrMsg, msg);
  }
}

/**
 * Creates the service's root logger; call once per process, at the entrypoint, and pass it on.
 * Throws a TypeError for an unknown level.
 */
export function createLogger(options: LoggerOptions): Logger {
  if (!(LOG_LEVELS as readonly string[]).includes(options.level)) {
    throw new TypeError(`unknown log level ${JSON.stringify(options.level)}`);
  }
  const now = options.now ?? Date.now;
  const dropped = (options.metrics ?? noopMetrics).counter('log_dropped_total');
  const destination: Destination =
    options.destination ??
    pino.destination({ dest: 1, sync: false, minLength: 0, maxLength: MAX_LOG_BUFFER_BYTES });
  const instance = pino(
    {
      level: options.level,
      base: { service: options.service, env: options.env, version: options.version },
      timestamp: () => `,"time":"${isoTime(now())}"`,
      formatters: {
        level: (label) => ({ level: label }),
        bindings: (bindings) => redactFields(bindings),
      },
      // redact() has already turned errors into plain objects; pino's own err serializer would
      // re-read them as errors and rename their type to "Object".
      serializers: { err: (value: unknown) => value },
      mixin: contextFields,
      hooks: { logMethod: logMethod as NonNullable<pino.LoggerOptions['hooks']>['logMethod'] },
    },
    guardDestination(destination, dropped),
  );
  return new RedactingLogger(instance);
}
