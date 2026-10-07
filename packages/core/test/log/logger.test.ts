/**
 * createLogger(): the line format, redaction of fields, messages, errors and child bindings, the
 * request context ids, level filtering, and destination failures (B005 acceptance 2, 3 and 5, and
 * the card's failure modes).
 */
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { Writable } from 'node:stream';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createLogger,
  MAX_LOG_BUFFER_BYTES,
  MAX_LOG_STRING_LENGTH,
  REDACTED,
  runWithContext,
  type Logger,
  type LoggerOptions,
  type LogLevel,
} from '../../src/index.js';
import {
  captureStream,
  JWT,
  LIVE_KEY,
  recordingMetrics,
  REQUEST_ID,
  SESSION_ID,
  USER_ID,
} from './helpers.js';

const NOW = Date.UTC(2026, 9, 6, 18, 7, 41, 123);

function setup(options: Partial<LoggerOptions> = {}) {
  const out = captureStream();
  const log = createLogger({
    level: 'trace',
    service: 'api',
    version: '1.2.3',
    env: 'test',
    destination: out.stream,
    now: () => NOW,
    ...options,
  });
  return { log, ...out };
}

describe('line format', () => {
  it('writes one JSON line per call: level, time, service, env, version, fields, msg', () => {
    const { log, raw, lines } = setup();
    log.info('hello');
    log.warn({ count: 2, ok: true }, 'with fields');
    log.debug({ only: 'fields' });
    expect(lines()).toEqual([
      {
        level: 'info',
        time: '2026-10-06T18:07:41.123Z',
        service: 'api',
        env: 'test',
        version: '1.2.3',
        msg: 'hello',
      },
      {
        level: 'warn',
        time: '2026-10-06T18:07:41.123Z',
        service: 'api',
        env: 'test',
        version: '1.2.3',
        count: 2,
        ok: true,
        msg: 'with fields',
      },
      {
        level: 'debug',
        time: '2026-10-06T18:07:41.123Z',
        service: 'api',
        env: 'test',
        version: '1.2.3',
        only: 'fields',
      },
    ]);
    expect(raw()[0]).toMatch(
      /^\{"level":"info","time":"2026-10-06T18:07:41\.123Z","service":"api"/,
    );
  });

  it('leaves env out when it is not given', () => {
    const { log, lines } = setup({ env: undefined });
    log.info('x');
    expect(lines()[0]).not.toHaveProperty('env');
  });

  it('keeps printf-style placeholders in a message as they are', () => {
    const { log, lines } = setup();
    log.info('100%s done %d %j %o');
    expect(lines()[0]?.['msg']).toBe('100%s done %d %j %o');
  });

  it('falls back to the system clock when the injected one is unusable', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 9e15]) {
      const { log, lines } = setup({ now: () => bad });
      expect(() => log.info('x')).not.toThrow();
      expect(Date.parse(String(lines()[0]?.['time']))).not.toBeNaN();
    }
  });

  it('acceptance 5: 1 000 generated lines are each single-line valid JSON', () => {
    const { log, raw } = setup();
    const nasty = ['\n', '\r\n', '"', '\\', '\u0000', '\u001b[31m', ' ', '\ud800', '😀', '%s'];
    const inputs = fc.sample(
      fc.record({
        msg: fc.oneof(fc.string({ unit: 'binary', maxLength: 200 }), fc.constantFrom(...nasty)),
        fields: fc.dictionary(
          fc.string({ unit: 'binary', maxLength: 12 }),
          fc.oneof(
            fc.string({ unit: 'binary', maxLength: 80 }),
            fc.integer(),
            fc.constantFrom(...nasty),
          ),
          { maxKeys: 5 },
        ),
      }),
      { numRuns: 1000, seed: 20261006 },
    );
    for (const { msg, fields } of inputs) log.info(fields, msg);
    const written = raw();
    expect(written).toHaveLength(1000);
    let failures = 0;
    for (const line of written) {
      try {
        JSON.parse(line);
      } catch {
        failures += 1;
      }
    }
    expect(failures).toBe(0);
  }, 60_000);
});

describe('redaction on every line', () => {
  it('acceptance 2: authorization and a nested refresh_token are [redacted], other keys kept', () => {
    const { log, raw, lines } = setup();
    log.info({ authorization: 'Bearer abc', nested: { refresh_token: 'x', kept: 'yes' }, n: 1 });
    expect(lines()[0]).toMatchObject({
      authorization: REDACTED,
      nested: { refresh_token: REDACTED, kept: 'yes' },
      n: 1,
    });
    expect(raw()[0]).not.toContain('Bearer abc');
  });

  it('acceptance 3: API keys and JWTs are replaced in fields and in the message', () => {
    const { log, raw, lines } = setup();
    log.info({ note: `key=${LIVE_KEY}`, list: [JWT] }, `ticket ${JWT} and ${LIVE_KEY}`);
    expect(lines()[0]).toMatchObject({
      note: `key=${REDACTED}`,
      list: [REDACTED],
      msg: `ticket ${REDACTED} and ${REDACTED}`,
    });
    expect(raw()[0]).not.toContain('cen_live');
    expect(raw()[0]).not.toContain('eyJ');
  });

  it(`caps messages and values at ${MAX_LOG_STRING_LENGTH} characters`, () => {
    const { log, lines } = setup();
    log.info({ long: 'v '.repeat(5000) }, 'm '.repeat(5000));
    const [line] = lines();
    expect(String(line?.['long'])).toHaveLength(MAX_LOG_STRING_LENGTH);
    expect(String(line?.['msg'])).toHaveLength(MAX_LOG_STRING_LENGTH);
  });

  it('logs an error under err with its type, message and stack, redacted', () => {
    const { log, raw, lines } = setup();
    const err = new Error(`login failed with ${LIVE_KEY}`);
    log.error({ err }, 'request failed');
    log.error({ err });
    (log.error as (value: unknown) => void)(new TypeError('untyped call'));
    const [withMsg, withoutMsg, untyped] = lines();
    expect(withMsg).toMatchObject({
      level: 'error',
      msg: 'request failed',
      err: { type: 'Error', message: `login failed with ${REDACTED}` },
    });
    expect(String((withMsg?.['err'] as Record<string, unknown>)['stack'])).toContain(
      'login failed with',
    );
    // pino uses the error's message when no message is given: it must be the redacted one.
    expect(withoutMsg?.['msg']).toBe(`login failed with ${REDACTED}`);
    expect(untyped).toMatchObject({ err: { type: 'TypeError', message: 'untyped call' } });
    expect(raw().join('\n')).not.toContain('cen_live');
  });

  it('redacts child bindings, at any depth, and keeps redacting the child’s lines', () => {
    const { log, lines } = setup();
    const child = log.child({ component: 'db', token: 'x', nested: { password: 'p' } });
    child.info({ cookie: 'c', rows: 3 }, 'query done');
    child.child({ ticket: 't', shard: 2 }).warn('grandchild');
    expect(lines()).toEqual([
      expect.objectContaining({
        component: 'db',
        token: REDACTED,
        nested: { password: REDACTED },
        cookie: REDACTED,
        rows: 3,
        msg: 'query done',
      }),
      expect.objectContaining({ component: 'db', ticket: REDACTED, shard: 2, msg: 'grandchild' }),
    ]);
    expect(child.level).toBe('trace');
  });

  it('cannot be told to skip redaction, and exposes no pino instance or stream', () => {
    const { log, lines } = setup();
    const sneaky = (log.child as (b: object, o: object) => Logger)(
      {},
      { formatters: { log: (o: object) => o }, serializers: {}, redact: [], msgPrefix: 'x' },
    );
    sneaky.info({ token: 'secret-value' });
    expect(lines()[0]).toMatchObject({ token: REDACTED });
    expect(Object.keys(log)).toEqual([]);
    expect(JSON.stringify(log)).toBe('{}');
  });
});

describe('request context ids', () => {
  it('adds request_id, session_id and user_id from the request context', async () => {
    const { log, lines } = setup();
    await runWithContext(
      { requestId: REQUEST_ID, userId: USER_ID, sessionId: SESSION_ID },
      async () => {
        log.info('sync');
        await tick();
        log.child({ component: 'deep' }).info('after await');
      },
    );
    log.info('outside');
    const [sync, later, outside] = lines();
    for (const line of [sync, later]) {
      expect(line).toMatchObject({
        request_id: REQUEST_ID,
        session_id: SESSION_ID,
        user_id: USER_ID,
      });
    }
    expect(outside).not.toHaveProperty('request_id');
  });

  it('writes only ids: anything else in the context is [redacted]', () => {
    const { log, lines } = setup();
    runWithContext({ requestId: 'abc', userId: 'someone@example.com', sessionId: USER_ID }, () => {
      log.info('x');
    });
    expect(lines()[0]).toMatchObject({
      request_id: REDACTED,
      user_id: REDACTED,
      session_id: REDACTED,
    });
  });
});

describe('levels', () => {
  it('writes only lines at or above the level', () => {
    const { log, lines } = setup({ level: 'warn' });
    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    log.fatal('f');
    expect(lines().map((l) => l['level'])).toEqual(['warn', 'error', 'fatal']);
    expect(log.level).toBe('warn');
    expect(log.isLevelEnabled('info')).toBe(false);
    expect(log.isLevelEnabled('error')).toBe(true);
  });

  it('writes nothing at silent', () => {
    const { log, raw } = setup({ level: 'silent' });
    log.fatal('f');
    expect(raw()).toEqual([]);
  });

  it('rejects an unknown level', () => {
    expect(() => setup({ level: 'verbose' as LogLevel })).toThrow(TypeError);
  });

  it('writes to stdout when no destination is given', () => {
    const log = createLogger({ level: 'silent', service: 'api', version: '1' });
    expect(() => log.info('not written at silent')).not.toThrow();
  });
});

describe('destination failures (lines are dropped and counted, never thrown)', () => {
  const base = { level: 'info', service: 'api', version: '1' } as const;

  it('a destination that fails a write: that line and every later one', async () => {
    const { metrics, count } = recordingMetrics();
    const failing = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('disk full'));
      },
    });
    const log = createLogger({ ...base, destination: failing, metrics });
    expect(() => {
      log.info('one');
      log.info('two');
    }).not.toThrow();
    await tick();
    log.info('three');
    expect(count('log_dropped_total')).toBe(3);
  });

  it('a destination whose write throws', () => {
    const { metrics, count } = recordingMetrics();
    const throwing = Object.assign(new EventEmitter(), {
      write(): never {
        throw new Error('EBADF');
      },
    });
    const log = createLogger({
      ...base,
      destination: throwing as unknown as NodeJS.WritableStream,
      metrics,
    });
    expect(() => log.info('x')).not.toThrow();
    expect(count('log_dropped_total')).toBe(1);
  });

  it('an ended destination', () => {
    const { metrics, count } = recordingMetrics();
    const { stream } = captureStream();
    const log = createLogger({ ...base, destination: stream, metrics });
    stream.end();
    log.info('after end');
    expect(count('log_dropped_total')).toBe(1);
  });

  it(`a backed-up destination stops buffering at ${MAX_LOG_BUFFER_BYTES} bytes`, () => {
    const { metrics, count } = recordingMetrics();
    const stuck = new Writable({ write: () => undefined }); // never completes a write
    const log = createLogger({ ...base, destination: stuck, metrics });
    const message = 'x'.repeat(1900);
    const lines = Math.ceil(MAX_LOG_BUFFER_BYTES / 1900) + 200;
    for (let i = 0; i < lines; i++) log.info(message);
    expect(count('log_dropped_total')).toBeGreaterThan(100);
    expect(stuck.writableLength).toBeLessThanOrEqual(MAX_LOG_BUFFER_BYTES + 4096);
  });

  it('counts lines the default writer refuses at its cap (its drop event)', () => {
    const { metrics, count } = recordingMetrics();
    const writer = Object.assign(new EventEmitter(), { write: () => true });
    createLogger({ ...base, destination: writer as unknown as NodeJS.WritableStream, metrics });
    writer.emit('drop', 'a line');
    expect(count('log_dropped_total')).toBe(1);
  });
});
