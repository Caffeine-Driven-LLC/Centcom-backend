/**
 * Property tests (B003 acceptance 6): generated validators and helpers never throw on hostile
 * input, unknown properties are ignored where a schema is open, and generated IDs always parse
 * and sort. The raw generated validators are called directly (no facade try/catch), with a fixed
 * seed so failures reproduce.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { VALIDATORS } from '#generated/validators';
import {
  checkName,
  checkSlug,
  createIdGenerator,
  EVENT_CATALOGUE,
  EVENT_KINDS,
  ID_PREFIXES,
  isId,
  isTimestamp,
  normaliseEmail,
  parseId,
  parseMoney,
  parseTimestamp,
  validate,
  validateEnvelope,
  type SchemaKey,
} from '../src/index.js';
import { fixtureFiles, readContract, type EventFixture, type GenericFixture, type JsonObject } from './contracts.js';

const SEED = 20261006;
/** These run tens of thousands of cases; well inside the 60 s lane budget, but not Vitest's 5 s default. */
const TIMEOUT = 60_000;
const ALL_VALIDATORS = Object.values(VALIDATORS);
const FRAME_TYPES = ['sys.hello', 'sys.welcome', 'sys.ping', 'sys.error', 'event', 'queue', 'control', 'presence', 'ack'];

const call = (key: string, value: unknown): boolean => {
  const fn = VALIDATORS[key];
  if (!fn) throw new Error(`no validator ${key}`);
  return fn(value);
};

const ulid = fc.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const frameArb = fc.record(
  {
    v: fc.oneof(fc.constant(1), fc.jsonValue()),
    t: fc.oneof(fc.constantFrom(...FRAME_TYPES), fc.string()),
    k: fc.oneof(fc.constantFrom(...EVENT_KINDS), fc.string()),
    sid: fc.oneof(ulid.map((u) => `ses_${u}`), fc.jsonValue()),
    id: fc.oneof(ulid.map((u) => `msg_${u}`), fc.jsonValue()),
    from: fc.oneof(fc.constant('srv'), ulid.map((u) => `mem_${u}`), fc.jsonValue()),
    ts: fc.oneof(fc.constant('2026-10-05T18:07:41.123Z'), fc.string()),
    seq: fc.oneof(fc.integer(), fc.jsonValue()),
    p: fc.oneof(fc.dictionary(fc.string(), fc.jsonValue()), fc.jsonValue()),
    ct: fc.oneof(fc.constant({ alg: 'xchacha20poly1305', kid: 'k1', n: 'A'.repeat(32), c: 'AAAA' }), fc.jsonValue()),
    sig: fc.oneof(fc.constant('AAAA'), fc.string()),
  },
  { requiredKeys: [] },
);

const eventFixtures = fixtureFiles()
  .filter(([area]) => area === 'events')
  .map(([, f]) => readContract<EventFixture>('fixtures', 'events', f));

describe('validators never throw', { timeout: TIMEOUT }, () => {
  it(`on 10 000 random JSON values, across all ${ALL_VALIDATORS.length} generated validators`, () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        for (const fn of ALL_VALIDATORS) fn(value);
      }),
      { numRuns: 10_000, seed: SEED },
    );
  });

  it('on 10 000 near-valid frames (envelope, events and the kind payload)', () => {
    fc.assert(
      fc.property(frameArb, (frame) => {
        call('envelope', frame);
        call('events', frame);
        const kind = frame.k;
        if (typeof kind === 'string' && kind in EVENT_CATALOGUE && VALIDATORS[`event/${kind}`]) call(`event/${kind}`, frame.p);
        if (typeof validateEnvelope(frame).ok !== 'boolean') throw new Error('validateEnvelope returned no result');
      }),
      { numRuns: 10_000, seed: SEED },
    );
  });

  it('on 5 000 fixture payloads with random fields replaced', () => {
    const withPayload = eventFixtures.filter((fx) => fx.frame.p !== undefined);
    fc.assert(
      fc.property(
        fc.constantFrom(...withPayload),
        fc.dictionary(fc.string({ maxLength: 12 }), fc.jsonValue(), { maxKeys: 4 }),
        fc.boolean(),
        (fx, replacements, overwriteKnown) => {
          const p = { ...(fx.frame.p as JsonObject) };
          const known = Object.keys(p);
          for (const [i, [key, value]] of Object.entries(replacements).entries()) {
            p[overwriteKnown && known.length > 0 ? (known[i % known.length] ?? key) : key] = value;
          }
          call(`event/${fx.kind}`, p);
          call('events', { ...fx.frame, p });
        },
      ),
      { numRuns: 5_000, seed: SEED },
    );
  });
});

describe('helpers never throw', { timeout: TIMEOUT }, () => {
  it('on arbitrary values', () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        parseId(v);
        isId('ses', v);
        parseTimestamp(v);
        isTimestamp(v);
        parseMoney(v);
        checkName('displayName', v);
        checkSlug(v);
        normaliseEmail(v);
        validate('api/Me', v);
      }),
      { numRuns: 5_000, seed: SEED },
    );
  });

  it('on near-valid strings', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.string({ unit: 'binary' }),
          fc.tuple(fc.constantFrom(...ID_PREFIXES), fc.string({ maxLength: 30 })).map(([p, s]) => `${p}_${s}`),
          fc
            .tuple(fc.date({ noInvalidDate: true }), fc.integer({ min: 1, max: 30 }))
            .map(([d, n]) => d.toISOString().slice(0, n)),
        ),
        (s) => {
          parseId(s);
          parseTimestamp(s);
          checkName('sessionName', s);
          checkSlug(s);
          normaliseEmail(s);
        },
      ),
      { numRuns: 5_000, seed: SEED },
    );
  });
});

describe('properties', { timeout: TIMEOUT }, () => {
  it('generated ids parse, keep their prefix and strictly increase whatever the clock does', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ID_PREFIXES),
        fc.array(fc.integer({ min: 0, max: 2 ** 48 - 2 }), { minLength: 1, maxLength: 50 }),
        (prefix, clock) => {
          let i = 0;
          const gen = createIdGenerator({ now: () => clock[Math.min(i++, clock.length - 1)] ?? 0 });
          let previous = '';
          for (let n = 0; n < clock.length; n++) {
            const id = gen(prefix);
            expect(parseId(id)?.prefix).toBe(prefix);
            expect(id > previous).toBe(true);
            previous = id;
          }
        },
      ),
      { numRuns: 1_000, seed: SEED },
    );
  });

  it('unknown properties are ignored where a schema is open (valid fixtures stay valid)', () => {
    const open = fixtureFiles()
      .filter(([area, f]) => area !== 'events' && area !== 'crypto' && f !== 'secret-patterns.json')
      .map(([area, f]) => readContract<GenericFixture>('fixtures', area, f))
      .filter((fx) => fx.valid && readContract('schemas', fx.schema).additionalProperties !== false);
    expect(open.length).toBeGreaterThan(0);
    fc.assert(
      fc.property(fc.constantFrom(...open), fc.string({ minLength: 1, maxLength: 12 }), fc.jsonValue(), (fx, name, value) => {
        const data = fx.data as JsonObject;
        const key = `x_${name}`;
        fc.pre(!(key in data));
        expect(validate(fx.schema.replace(/\.schema\.json$/, '') as SchemaKey, { ...data, [key]: value }).ok).toBe(true);
      }),
      { numRuns: 2_000, seed: SEED },
    );
  });

  it('unknown frame properties are ignored for every event kind', () => {
    fc.assert(
      fc.property(fc.constantFrom(...eventFixtures), fc.string({ minLength: 1, maxLength: 12 }), fc.jsonValue(), (fx, name, value) => {
        expect(validateEnvelope({ ...fx.frame, [`x_${name}`]: value }).ok).toBe(true);
      }),
      { numRuns: 2_000, seed: SEED },
    );
  });
});
