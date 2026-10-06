/** Secret: every printable or serialisable form is [redacted]; only reveal() returns the value. */
import { format, inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { defineConfig, REDACTED, Secret, secretString, z } from '../../src/index.js';

const VALUE = 'hunter2-very-secret';

describe('Secret', () => {
  const s = new Secret(VALUE);

  it('reveal() returns the value', () => {
    expect(s.reveal()).toBe(VALUE);
    expect(new Secret({ key: 1 }).reveal()).toEqual({ key: 1 });
  });

  it('JSON shows [redacted]', () => {
    expect(JSON.stringify({ s })).toBe('{"s":"[redacted]"}');
    expect(JSON.stringify([s, { nested: s }])).toBe('["[redacted]",{"nested":"[redacted]"}]');
  });

  it('util.inspect (console.log) shows [redacted], also nested and with colours or depth', () => {
    expect(inspect(s)).toBe(REDACTED);
    expect(inspect({ db: s }, { colors: true, depth: 10 })).not.toContain(VALUE);
    expect(format('%o %O %s %j', s, { s }, s, { s })).not.toContain(VALUE);
  });

  it('template strings, String(), concatenation and toString() show [redacted]', () => {
    expect(`${s}`).toBe(REDACTED);
    expect(String(s)).toBe(REDACTED);
    expect(`url=${s}`).toBe('url=[redacted]');
    expect(s.toString()).toBe(REDACTED);
  });

  it('keeps the value out of enumerable properties (keys, spread, structuredClone)', () => {
    expect(Object.keys(s)).toEqual([]);
    expect(JSON.stringify({ ...s })).toBe('{}');
    expect(JSON.stringify(structuredClone({ s }))).not.toContain(VALUE);
    expect(inspect(structuredClone(s), { showHidden: true })).not.toContain(VALUE);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(s)).toBe(true);
  });
});

describe('secretString()', () => {
  const schema = z.object({ API_TOKEN: secretString() });

  it('wraps the parsed value in a Secret', () => {
    const c = defineConfig(schema, { API_TOKEN: VALUE });
    expect(c.API_TOKEN).toBeInstanceOf(Secret);
    expect(c.API_TOKEN.reveal()).toBe(VALUE);
    expect(JSON.stringify(c)).toBe('{"API_TOKEN":"[redacted]"}');
  });

  it('validates the raw string with the inner schema before wrapping', () => {
    const pinned = z.object({
      KEY: secretString(z.string().regex(/^cen_[a-z0-9]{8}$/, 'must look like cen_<8 chars>')),
    });
    expect(() => defineConfig(pinned, { KEY: 'nope-value' })).toThrow(
      'KEY: must look like cen_<8 chars>',
    );
    expect(defineConfig(pinned, { KEY: 'cen_abcd1234' }).KEY.reveal()).toBe('cen_abcd1234');
  });

  it('is marked secret for the config docs', () => {
    const json = z.toJSONSchema(schema, { io: 'input' }) as {
      properties: Record<string, { secret?: boolean }>;
    };
    expect(json.properties.API_TOKEN?.secret).toBe(true);
  });
});
