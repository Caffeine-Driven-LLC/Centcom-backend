/**
 * Property tests for redact() (B005): random nested values never make it throw, its output is
 * always JSON-serialisable and stable under a second pass, it never mutates its input, and a
 * secret planted anywhere in a random object never reaches the output. Fixed seed, so failures
 * reproduce.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REDACTED, redact } from '../../src/index.js';
import { base62, JWE, JWT, LIVE_KEY, TEST_KEY } from './helpers.js';

const SEED = 20261006;
/** These run thousands of cases; well inside the 60 s lane budget, but not Vitest's 5 s default. */
const TIMEOUT = 60_000;

/** Every kind of value fast-check can make: Maps, Sets, typed arrays, boxed values, sparse arrays, ... */
const anything = fc.anything({
  maxDepth: 12,
  withBigInt: true,
  withBoxedValues: true,
  withDate: true,
  withMap: true,
  withNullPrototype: true,
  withObjectString: true,
  withSet: true,
  withSparseArray: true,
  withTypedArray: true,
});

/** Values that throw or refuse to be read in different ways. */
const HOSTILE: (() => unknown)[] = [
  () =>
    Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter');
      },
    }),
  () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  },
  () =>
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('trap');
        },
      },
    ),
  () => ({
    toJSON() {
      throw new Error('toJSON');
    },
  }),
  () => Object.assign(new Error('with props'), { code: 'E_X', path: '/tmp/x' }),
];

/** Every plain object or array reachable from `value` (cycle-safe). */
function containers(value: unknown, out: object[] = [], seen = new Set<object>()): object[] {
  if (typeof value !== 'object' || value === null || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype) out.push(value);
  if (Array.isArray(value) || !ArrayBuffer.isView(value)) {
    for (const key of Object.keys(value)) {
      containers((value as Record<string, unknown>)[key], out, seen);
    }
  }
  return out;
}

/** Adds `{ [key]: item }` to a container: as a property, or appended to an array. */
function put(target: object | undefined, key: string, item: unknown): void {
  if (Array.isArray(target)) target.push({ [key]: item });
  else if (target !== undefined) (target as Record<string, unknown>)[key] = item;
}

/**
 * A copy of a generated value inside a wrapper object: planting into the copy never mutates
 * fast-check's own values (which it reuses while shrinking), and there is always a container.
 */
const rootOf = (value: unknown): { value: unknown } => ({ value: structuredClone(value) });

/** Text that may surround a secret: separated from it, as in a log message. */
const words = fc.string({ maxLength: 40 }).map((s) => `${s} `);

describe('redact() fuzzing', () => {
  it(
    'never throws, and its output always serialises',
    () => {
      fc.assert(
        fc.property(anything, (value) => {
          const out = redact(value);
          expect(() => JSON.stringify(out)).not.toThrow();
        }),
        { numRuns: 3000, seed: SEED },
      );
    },
    TIMEOUT,
  );

  it(
    'never throws on cycles and hostile objects planted anywhere',
    () => {
      fc.assert(
        fc.property(
          anything,
          fc.array(fc.tuple(fc.nat(), fc.nat({ max: HOSTILE.length })), { maxLength: 6 }),
          (value, plants) => {
            const root = rootOf(value);
            // Chosen before planting: walking a planted hostile object would throw here.
            const targets = containers(root);
            for (const [pick, kind] of plants) {
              // kind === HOSTILE.length plants a cycle back to the root.
              const item = kind < HOSTILE.length ? HOSTILE[kind]?.() : root;
              put(targets[pick % targets.length], `h${pick}`, item);
            }
            const out = redact(root);
            expect(() => JSON.stringify(out)).not.toThrow();
          },
        ),
        { numRuns: 2000, seed: SEED },
      );
    },
    TIMEOUT,
  );

  it(
    'is stable: redacting its own output changes nothing',
    () => {
      fc.assert(
        fc.property(anything, (value) => {
          const once = redact(value);
          expect(redact(once)).toEqual(once);
        }),
        { numRuns: 2000, seed: SEED },
      );
    },
    TIMEOUT,
  );

  it(
    'never mutates its input',
    () => {
      fc.assert(
        fc.property(anything, (value) => {
          const before = fc.stringify(value);
          redact(value);
          expect(fc.stringify(value)).toBe(before);
        }),
        { numRuns: 2000, seed: SEED },
      );
    },
    TIMEOUT,
  );

  it(
    'removes a secret planted as a value, inside text or as a key, anywhere in a random object',
    () => {
      const secrets = fc.constantFrom(LIVE_KEY, TEST_KEY, JWT, JWE, `Bearer ${base62(24)}`);
      fc.assert(
        fc.property(
          anything,
          secrets,
          words,
          words,
          fc.nat(),
          fc.boolean(),
          (value, secret, before, after, pick, asKey) => {
            const root = rootOf(value);
            const targets = containers(root);
            const text = `${before}${secret} ${after}`;
            put(targets[pick % targets.length], asKey ? text : 'note', asKey ? 1 : text);
            const out = JSON.stringify(redact(root));
            expect(out).toContain(REDACTED);
            // The distinctive part of each secret: the key body, the JWT header, the credential.
            expect(out).not.toContain(base62(24));
            expect(out).not.toContain(JWT.split('.')[0]);
            expect(out).not.toContain(JWE.split('.')[3]);
          },
        ),
        { numRuns: 3000, seed: SEED },
      );
    },
    TIMEOUT,
  );
});
