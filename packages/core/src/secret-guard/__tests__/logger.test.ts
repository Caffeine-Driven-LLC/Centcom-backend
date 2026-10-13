/**
 * Surface 1, the logger (B101): a credential in a field or message is redacted before the B005
 * logger writes it, counted once, and reported by a warning that holds only ids.
 */
import { describe, expect, it } from 'vitest';
import { createLogger, type Logger } from '../../log/logger.js';
import { captureStream, recordingMetrics } from '../../../test/log/helpers.js';
import { createGuardedLogger, UNSCANNABLE } from '../logger.js';
import { ANTHROPIC_KEY, AWS_KEY } from '../../../test/secret-guard/helpers.js';

function setup(level: 'trace' | 'info' = 'trace') {
  const out = captureStream();
  const base = createLogger({
    level,
    service: 'api',
    version: '1',
    env: 'test',
    destination: out.stream,
  });
  const m = recordingMetrics();
  return { log: createGuardedLogger(base, { metrics: m.metrics }), base, ...out, ...m };
}

describe('createGuardedLogger', () => {
  it('writes [redacted:<id>] instead of the key, counts one hit, and warns without the text', () => {
    const { log, raw, lines, count } = setup();
    log.info({ token: ANTHROPIC_KEY }, 'x');
    const text = raw().join('\n');
    expect(text).toContain('[redacted:anthropic_api_key]');
    expect(text).not.toContain(ANTHROPIC_KEY);
    expect(text).not.toContain('sk-ant');
    expect(count('secret_guard_hits_total', { surface: 'log', pattern: 'anthropic_api_key' })).toBe(
      1,
    );
    const warning = lines().find((l) => l['msg'] === 'secret_guard_hit');
    expect(warning).toMatchObject({ level: 'warn', surface: 'log', pattern: 'anthropic_api_key' });
  });

  it('redacts the message and nested fields, in child loggers too', () => {
    const { log, raw } = setup();
    log
      .child({ requestHeader: AWS_KEY })
      .error({ nested: { list: [AWS_KEY] } }, `failed for ${AWS_KEY}`);
    const text = raw().join('\n');
    expect(text).not.toContain('AKIA');
    expect(text.match(/\[redacted:aws_access_key\]/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('writes clean lines unchanged and counts nothing', () => {
    const { log, base, lines, count } = setup();
    log.info({ a: 1 }, 'hello');
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ msg: 'hello', a: 1 });
    expect(count('secret_guard_hits_total', { surface: 'log', pattern: 'aws_access_key' })).toBe(0);
    expect(log.level).toBe(base.level);
    expect(log.isLevelEnabled('trace')).toBe(true);
  });

  it('skips the scan for disabled levels', () => {
    const { log, raw } = setup('info');
    log.debug({ k: AWS_KEY }, 'x');
    expect(raw()).toEqual([]);
  });

  it('fails open: text it cannot walk is replaced by a placeholder and the line is still written', () => {
    const { log, raw } = setup();
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i++) deep = { n: deep };
    log.info(deep as Record<string, unknown>, 'deep');
    const text = raw().join('\n');
    expect(text).toContain(UNSCANNABLE);
    expect(text).toContain('deep');
  });

  it('never throws into a caller, even for a field that throws when read', () => {
    const { log } = setup();
    const bad = {
      get boom(): string {
        throw new Error('no');
      },
    };
    expect(() => (log as Logger).info(bad, 'm')).not.toThrow();
  });
});
