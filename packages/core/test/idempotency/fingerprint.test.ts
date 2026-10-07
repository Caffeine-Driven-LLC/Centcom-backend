/**
 * Request fingerprints (B024, card test fingerprint.test.ts): canonical JSON, key-order
 * independence (property tests), what changes a fingerprint, and the constant-time comparison.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  FINGERPRINT_PREFIX,
  fingerprintRequest,
  fingerprintsEqual,
} from '../../src/index.js';

/** `value` with every object's keys in reverse insertion order. */
const reordered = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reordered);
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value).reverse();
  return Object.fromEntries(entries.map(([k, v]) => [k, reordered(v)]));
};

describe('canonicalJson', () => {
  it('sorts keys at every depth, drops undefined members and writes no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: true, y: null }], c: 'x' }, u: undefined })).toBe(
      '{"a":{"c":"x","d":[1,{"y":null,"z":true}]},"b":1}',
    );
  });

  it('keeps array order and writes undefined items as null', () => {
    expect(canonicalJson([3, undefined, 'a'])).toBe('[3,null,"a"]');
  });

  it('writes bytes as base64, and objects without a prototype like any other', () => {
    expect(canonicalJson(Buffer.from('hi'))).toBe('{"$bytes":"aGk="}');
    expect(canonicalJson(new Uint8Array([1, 2]))).toBe('{"$bytes":"AQI="}');
    const bare = Object.assign(Object.create(null) as object, { b: 2, a: 1 });
    expect(canonicalJson(bare)).toBe('{"a":1,"b":2}');
  });

  it.each([
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
    ['a bigint', 10n],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a Map', new Map()],
    ['a Date', new Date(0)],
    ['a class instance', new URL('https://example.test/')],
  ])('refuses %s', (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it('is a fixed point for anything JSON can hold (property)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const canonical = canonicalJson(value);
        expect(canonicalJson(JSON.parse(canonical))).toBe(canonical);
      }),
      { numRuns: 500 },
    );
  });
});

describe('fingerprintRequest', () => {
  it('is sha256: and 64 hex digits', () => {
    expect(fingerprintRequest('POST', '/v1/things', {}, { a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(FINGERPRINT_PREFIX).toBe('sha256:');
  });

  it('does not depend on key order (property)', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.jsonValue()),
        fc.dictionary(fc.string(), fc.string()),
        (body, params) => {
          expect(
            fingerprintRequest('POST', '/v1/x/:id', reordered(params) as object, reordered(body)),
          ).toBe(fingerprintRequest('POST', '/v1/x/:id', params, body));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('changes with the route, a path parameter, or one field of the body, but not the method case', () => {
    const base = fingerprintRequest('POST', '/v1/x/:id', { id: '1' }, { a: 1, b: 2 });
    expect(fingerprintRequest('post', '/v1/x/:id', { id: '1' }, { b: 2, a: 1 })).toBe(base);
    for (const other of [
      fingerprintRequest('PUT', '/v1/x/:id', { id: '1' }, { a: 1, b: 2 }),
      fingerprintRequest('POST', '/v1/y/:id', { id: '1' }, { a: 1, b: 2 }),
      fingerprintRequest('POST', '/v1/x/:id', { id: '2' }, { a: 1, b: 2 }),
      fingerprintRequest('POST', '/v1/x/:id', { id: '1' }, { a: 1, b: 3 }),
      fingerprintRequest('POST', '/v1/x/:id', { id: '1' }, { a: 1 }),
      fingerprintRequest('POST', '/v1/x/:id', { id: '1' }, [1, 2]),
    ]) {
      expect(other).not.toBe(base);
    }
  });

  it("counts the params' own properties, whatever object holds them", () => {
    // Like find-my-way's params: an object whose prototype is a null-prototype object.
    const routerParams = Object.assign(Object.create(Object.create(null) as object) as object, {
      id: '1',
    });
    expect(fingerprintRequest('POST', '/v1/x/:id', routerParams, {})).toBe(
      fingerprintRequest('POST', '/v1/x/:id', { id: '1' }, {}),
    );
  });

  it('treats a missing body as null, and strings and bytes as themselves', () => {
    expect(fingerprintRequest('POST', '/v1/x', {}, undefined)).toBe(
      fingerprintRequest('POST', '/v1/x', {}, null),
    );
    expect(fingerprintRequest('POST', '/v1/x', {}, 'hi')).not.toBe(
      fingerprintRequest('POST', '/v1/x', {}, Buffer.from('hi')),
    );
  });
});

describe('fingerprintsEqual', () => {
  it('compares whole fingerprints', () => {
    const a = fingerprintRequest('POST', '/v1/x', {}, { a: 1 });
    const b = fingerprintRequest('POST', '/v1/x', {}, { a: 2 });
    expect(fingerprintsEqual(a, a)).toBe(true);
    expect(fingerprintsEqual(a, `${a}`)).toBe(true);
    expect(fingerprintsEqual(a, b)).toBe(false);
    expect(fingerprintsEqual(a, a.slice(0, -1))).toBe(false);
    expect(fingerprintsEqual('', '')).toBe(true);
  });
});
