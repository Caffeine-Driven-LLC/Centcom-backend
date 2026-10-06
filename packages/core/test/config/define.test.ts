/** defineConfig: aggregated value-free errors, defaults, strict coercion, blanks, freezing. */
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  deepFreeze,
  defineConfig,
  envBool,
  envInt,
  envUrl,
  Secret,
  secretString,
  z,
} from '../../src/index.js';

const schema = z.object({
  NAME: z.string().min(2).max(10),
  COUNT: envInt({ min: 1, max: 5 }).default(3),
  ENABLED: envBool().default(false),
  MODE: z.enum(['a', 'b']).default('a'),
  TOKEN: secretString(),
});

/** Asserts that `fn` throws a ConfigError and that no value from `env` leaks through it. */
function configError(fn: () => unknown, env: Record<string, string>): ConfigError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    const err = e as ConfigError;
    const surfaces = [
      err.message,
      err.stack ?? '',
      JSON.stringify(err),
      JSON.stringify(err.issues),
      inspect(err, { depth: 5 }),
    ];
    for (const value of Object.values(env)) {
      if (value.length < 4) continue; // short values (e.g. "0") occur in ordinary words
      for (const s of surfaces)
        expect(s, `value ${JSON.stringify(value)} leaked`).not.toContain(value);
    }
    return err;
  }
  throw new Error('expected a ConfigError');
}

describe('defineConfig', () => {
  it('parses, applies defaults and wraps secrets', () => {
    const c = defineConfig(schema, { NAME: 'svc', TOKEN: 'tok-abcdef' });
    expect(c).toMatchObject({ NAME: 'svc', COUNT: 3, ENABLED: false, MODE: 'a' });
    expect(c.TOKEN).toBeInstanceOf(Secret);
    expect(c.TOKEN.reveal()).toBe('tok-abcdef');
  });

  it('lists every invalid key in one error, by name, without values', () => {
    const env = { NAME: 'way-too-long-name', COUNT: '99', ENABLED: 'yes-please', MODE: 'zzzz' };
    const err = configError(() => defineConfig(schema, env), env);
    expect(err.issues).toEqual([
      { key: 'NAME', problem: 'must be at most 10 characters' },
      { key: 'COUNT', problem: 'must be at most 5' },
      { key: 'ENABLED', problem: 'must be one of: 0, 1, true, false' },
      { key: 'MODE', problem: 'must be one of: a, b' },
      { key: 'TOKEN', problem: 'is required' },
    ]);
    expect(err.message).toBe(
      'Invalid configuration:\n  NAME: must be at most 10 characters\n  COUNT: must be at most 5\n  ENABLED: must be one of: 0, 1, true, false\n  MODE: must be one of: a, b\n  TOKEN: is required',
    );
    expect(Object.isFrozen(err.issues)).toBe(true);
  });

  it('treats whitespace-only values as unset', () => {
    const c = defineConfig(schema, {
      NAME: 'svc',
      TOKEN: 'tok-abcdef',
      COUNT: '   ',
      ENABLED: '\t',
    });
    expect(c.COUNT).toBe(3);
    expect(c.ENABLED).toBe(false);
    const err = configError(() => defineConfig(schema, { NAME: '  ', TOKEN: '\n' }), {});
    expect(err.issues).toEqual([
      { key: 'NAME', problem: 'is required' },
      { key: 'TOKEN', problem: 'is required' },
    ]);
  });

  it('reads only declared keys (other variables are ignored and never parsed)', () => {
    const c = defineConfig(schema, {
      NAME: 'svc',
      TOKEN: 'tok-abcdef',
      PATH: '/usr/bin',
      COUNT_FILE: '',
    });
    expect(Object.keys(c).sort()).toEqual(['COUNT', 'ENABLED', 'MODE', 'NAME', 'TOKEN']);
  });

  it('works with refined and transformed schemas', () => {
    const shaped = schema
      .refine((v) => v.COUNT !== 4, { path: ['COUNT'], message: 'must not be 4' })
      .transform((v) => ({ name: v.NAME, nested: { count: v.COUNT } }));
    expect(defineConfig(shaped, { NAME: 'svc', TOKEN: 'tok-abcdef' })).toEqual({
      name: 'svc',
      nested: { count: 3 },
    });
    expect(
      configError(() => defineConfig(shaped, { NAME: 'svc', TOKEN: 'tok-abcdef', COUNT: '4' }), {})
        .issues,
    ).toEqual([{ key: 'COUNT', problem: 'must not be 4' }]);
  });

  it('scrubs a value that a schema author put into a custom message', () => {
    const careless = z.object({
      KEY: z.string().refine((v) => v.startsWith('ok'), { message: 'bad value sekret-123 here' }),
    });
    const err = configError(() => defineConfig(careless, { KEY: 'sekret-123' }), {
      KEY: 'sekret-123',
    });
    expect(err.issues).toEqual([{ key: 'KEY', problem: 'bad value [redacted] here' }]);
  });

  it('rejects a schema that is not an object of environment keys', () => {
    expect(() => defineConfig(z.string(), {})).toThrow(TypeError);
  });

  it('returns a deep-frozen object; assigning throws in strict mode', () => {
    const shaped = schema.transform((v) => ({
      name: v.NAME,
      nested: { count: v.COUNT, list: [1, 2] },
    }));
    const c = defineConfig(shaped, { NAME: 'svc', TOKEN: 'tok-abcdef' }) as unknown as {
      name: string;
      nested: { count: number; list: number[] };
    };
    expect(() => {
      c.name = 'other';
    }).toThrow(TypeError);
    expect(() => {
      c.nested.count = 9;
    }).toThrow(TypeError);
    expect(() => c.nested.list.push(3)).toThrow(TypeError);
  });
});

describe('envInt', () => {
  const int = z.object({ N: envInt({ min: -5, max: 100 }) });
  it.each([
    ['0', 0],
    ['-5', -5],
    ['100', 100],
    ['042', 42],
  ])('accepts %s', (raw, value) => {
    expect(defineConfig(int, { N: raw }).N).toBe(value);
  });
  it.each([
    ['1e2', 'must be a whole number'],
    ['0x10', 'must be a whole number'],
    ['3.5', 'must be a whole number'],
    ['12abc', 'must be a whole number'],
    ['101', 'must be at most 100'],
    ['-6', 'must be at least -5'],
  ])('rejects %s', (raw, problem) => {
    expect(configError(() => defineConfig(int, { N: raw }), {}).issues).toEqual([
      { key: 'N', problem },
    ]);
  });
});

describe('envBool', () => {
  const bool = z.object({ B: envBool() });
  it.each([
    ['1', true],
    ['true', true],
    ['0', false],
    ['false', false],
  ])('%s is %s', (raw, value) => {
    expect(defineConfig(bool, { B: raw }).B).toBe(value);
  });
  it.each(['TRUE', 'yes', 'on', '2'])('rejects %s', (raw) => {
    expect(configError(() => defineConfig(bool, { B: raw }), {}).issues[0]?.key).toBe('B');
  });
});

describe('envUrl', () => {
  const urls = z.object({ U: envUrl({ protocols: ['https:'], plain: true }) });
  it('accepts an absolute URL of an allowed scheme', () => {
    expect(defineConfig(urls, { U: 'https://api.centcom.dev/v1' }).U).toBe(
      'https://api.centcom.dev/v1',
    );
  });
  it.each([
    ['not a url', 'must be an absolute https:// URL'],
    ['http://api.centcom.dev', 'must start with https://'],
    ['https://user:pw@api.centcom.dev', 'must not contain credentials, a query or a fragment'],
    ['https://api.centcom.dev/?x=1', 'must not contain credentials, a query or a fragment'],
    ['https://api.centcom.dev/#top', 'must not contain credentials, a query or a fragment'],
  ])('rejects %s', (raw, problem) => {
    expect(configError(() => defineConfig(urls, { U: raw }), { U: raw }).issues).toEqual([
      { key: 'U', problem },
    ]);
  });
  it('allows credentials and queries unless plain', () => {
    const db = z.object({ U: envUrl({ protocols: ['postgres:'] }) });
    expect(defineConfig(db, { U: 'postgres://u:p@h:5432/db?sslmode=require' }).U).toContain(
      'sslmode',
    );
  });
});

describe('deepFreeze', () => {
  it('freezes nested objects and arrays but leaves typed arrays alone', () => {
    const v = deepFreeze({ a: { b: [1, { c: 2 }] }, bytes: new Uint8Array([1, 2]) });
    expect(Object.isFrozen(v.a.b[1])).toBe(true);
    expect(Object.isFrozen(v.bytes)).toBe(false);
    expect(deepFreeze(5)).toBe(5);
  });
});
