/** Validator facade: modes, unknown data, issue mapping and never-throw guarantees. */
import { describe, expect, it } from 'vitest';
import {
  EVENT_CATALOGUE,
  isEventKind,
  validate,
  validateEntitlements,
  validateEnvelope,
  validateEvent,
  validateEventSecret,
  validateLanPair,
  validateNotification,
  validateProblem,
  validateProviderPolicy,
  validateReleaseManifest,
  validateTelemetry,
  validateWebhook,
  type SchemaKey,
} from '../src/index.js';
import { clone, readContract, type EventFixture, type GenericFixture, type JsonObject } from './contracts.js';

const member = {
  id: 'mem_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
  user: 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
  display_name: 'Ada',
  role: 'admin',
  joined_at: '2026-10-05T18:07:41.123Z',
};
const fixture = (area: string, file: string) => readContract<GenericFixture>('fixtures', area, file);
const frame = (kind: string) => readContract<EventFixture>('fixtures', 'events', `${kind}.json`).frame;

describe('extensible enums (CT-VER: "documented as extensible")', () => {
  it('Role: strict rejects an unknown value, tolerant accepts it', () => {
    const next = { ...member, role: 'auditor' };
    expect(validate('api/Member', member).ok).toBe(true);
    expect(validate('api/Member', next)).toMatchObject({ ok: false, errors: [{ pointer: '/role', code: 'invalid_value' }] });
    expect(validate('api/Member', next, { mode: 'tolerant' }).ok).toBe(true);
  });

  it('tolerance reaches through references (a page of members)', () => {
    const page = { data: [member, { ...member, role: 'auditor' }], next_cursor: null, has_more: false };
    expect(validate('api/MemberPage', page).ok).toBe(false);
    expect(validate('api/MemberPage', page, { mode: 'tolerant' }).ok).toBe(true);
  });

  it('tolerant mode still rejects wrong types for an extensible field', () => {
    expect(validate('api/Member', { ...member, role: 7 }, { mode: 'tolerant' }).ok).toBe(false);
  });

  it('enums not documented as extensible stay strict in tolerant mode', () => {
    const fx = fixture('webhook', 'unknown_type.json');
    expect(validateWebhook(fx.data, { mode: 'tolerant' }).ok).toBe(false);
    expect(validate('api/Member', { ...member, role: 'admin' }, { mode: 'tolerant' }).ok).toBe(true);
  });

  it('keys without a tolerant variant fall back to the strict validator', () => {
    const fx = fixture('problem', 'validation.json');
    expect(validateProblem(fx.data, { mode: 'tolerant' }).ok).toBe(true);
  });
});

describe('unknown data', () => {
  it('unknown properties are ignored where the schema is open', () => {
    const fx = fixture('entitlements', 'pro.json');
    expect(validateEntitlements({ ...(fx.data as JsonObject), future_field: { any: ['thing'] } }).ok).toBe(true);
    const f: JsonObject = { ...clone(frame('agent.state')), x_future: 1 };
    (f.p as JsonObject).x_future = 'ok';
    expect(validateEnvelope(f).ok).toBe(true);
  });

  it('unknown properties fail where the schema is closed, with an escaped pointer', () => {
    const fx = fixture('telemetry', 'batch.json');
    const r = validateTelemetry({ ...(fx.data as JsonObject), 'a/b~c': 1 });
    expect(r).toMatchObject({ ok: false, errors: [{ pointer: '/a~1b~0c', code: 'not_allowed' }] });
  });

  it('an unknown event kind passes frame validation (CT-WS-SESSION-EVENTS "Unknown kinds")', () => {
    const f = { ...frame('agent.state'), k: 'agent.levitate', p: { anything: true } };
    expect(validateEnvelope(f).ok).toBe(true);
    expect(isEventKind('agent.levitate')).toBe(false);
    expect(validateEvent('agent.levitate' as never, {})).toMatchObject({ ok: false, errors: [{ code: 'unknown_kind' }] });
    expect(validateEventSecret('agent.levitate' as never, {})).toMatchObject({ ok: false, errors: [{ code: 'unknown_kind' }] });
  });

  it('an unknown frame type fails (the envelope lists every type)', () => {
    expect(validateEnvelope({ v: 1, t: 'sys.teleport' })).toMatchObject({ ok: false, errors: [{ pointer: '/t', code: 'invalid_value' }] });
  });
});

describe('issues', () => {
  it.each([
    ['required', { v: 1 }, '/t', 'required'],
    ['type', { v: 1, t: 'presence', k: 'x', sid: 7 }, '/sid', 'invalid_type'],
    ['const', { v: 2, t: 'sys.ping' }, '/v', 'invalid_value'],
    ['pattern', { v: 1, t: 'sys.ping', id: 'msg_lowercase' }, '/id', 'invalid_format'],
    ['format', { v: 1, t: 'sys.ping', ts: 'yesterday' }, '/ts', 'invalid_format'],
    ['minimum', { v: 1, t: 'sys.ping', seq: 0 }, '/seq', 'out_of_range'],
    ['maxLength', { v: 1, t: 'sys.ping', k: 'a'.repeat(65) }, '/k', 'too_long'],
  ])('%s maps to a pointer and a stable code', (_, value, pointer, code) => {
    const r = validate('envelope', value);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toMatchObject({ pointer, code });
      expect(r.errors[0]?.detail).toEqual(expect.any(String));
    }
  });

  it('minLength and minItems map to too_short and too_few', () => {
    const hello = (p: JsonObject) => ({ v: 1, t: 'sys.hello', p: { protocols: [1], ticket: 'x'.repeat(10), client: { name: 'c', version: '1' }, ...p } });
    expect(validate('envelope', hello({ ticket: 'short' }))).toMatchObject({ errors: [{ pointer: '/p/ticket', code: 'too_short' }] });
    expect(validate('envelope', hello({ protocols: [] }))).toMatchObject({ errors: [{ pointer: '/p/protocols', code: 'too_few' }] });
  });

  it('a forbidden part maps to not_allowed', () => {
    const f = { ...frame('message.user'), p: { leak: 'plaintext' } };
    expect(validateEnvelope(f)).toMatchObject({ ok: false, errors: [{ code: 'not_allowed' }] });
  });

  it('a oneOf mismatch maps to no_match', () => {
    expect(validate('api/TokenRequest', { grant_type: 'password', username: 'u' })).toMatchObject({ ok: false, errors: [{ code: 'no_match' }] });
  });

  it('an unknown schema key is reported, not thrown', () => {
    expect(validate('nope' as SchemaKey, {})).toMatchObject({ ok: false, errors: [{ code: 'unknown_schema' }] });
  });
});

describe('guarantees', () => {
  it('returns the same reference and never mutates the input', () => {
    const fx = fixture('entitlements', 'team.json');
    const before = clone(fx.data);
    const r = validateEntitlements(fx.data);
    expect(r.ok && r.value).toBe(fx.data);
    expect(fx.data).toEqual(before);
  });

  it('never throws, even for values whose property access throws', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
        has() {
          throw new Error('boom');
        },
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(validateEnvelope(hostile)).toMatchObject({ ok: false });
    expect(validate('api/Me', hostile)).toMatchObject({ ok: false });
  });

  it('encrypted kinds take no cleartext payload; clear kinds take no secret', () => {
    const encrypted = Object.entries(EVENT_CATALOGUE).find(([, e]) => e.mode === 'encrypted')?.[0];
    const clear = Object.entries(EVENT_CATALOGUE).find(([, e]) => e.mode === 'clear' && !e.secret)?.[0];
    expect(validateEvent(encrypted as never, undefined)).toEqual({ ok: true, value: undefined });
    expect(validateEvent(encrypted as never, {})).toMatchObject({ ok: false, errors: [{ code: 'not_allowed' }] });
    expect(validateEventSecret(clear as never, {})).toMatchObject({ ok: false, errors: [{ code: 'not_allowed' }] });
  });
});

describe('queue.reject (contract gap: clear kind with a secret schema)', () => {
  // 04-session-events.md lists queue.reject as clear but also a secret `note`; events.schema.json
  // forbids ct for it yet defines s_queue_reject. The frame rule wins until a Contract PR decides.
  it('is clear in the catalogue, and a frame carrying ct is rejected', () => {
    expect(EVENT_CATALOGUE['queue.reject']).toMatchObject({ t: 'queue', mode: 'clear', secret: true });
    const withCt = {
      ...frame('queue.reject'),
      ct: { alg: 'xchacha20poly1305', kid: 'k1', n: 'A'.repeat(32), c: 'AAAA' },
      sig: 'AAAA',
    };
    expect(validate('envelope', withCt).ok).toBe(true); // a well-formed ct ...
    expect(validateEnvelope(withCt)).toMatchObject({ ok: false, errors: [{ pointer: '', code: 'not_allowed' }] }); // ... that the kind forbids
    expect(validateEnvelope(frame('queue.reject')).ok).toBe(true);
  });
});

describe('named helpers', () => {
  it.each([
    [validateLanPair, 'lan', 'pair1.json'],
    [validateNotification, 'notification', 'approval.json'],
    [validateProblem, 'problem', 'quota.json'],
    [validateProviderPolicy, 'providers', 'policy-reference.json'],
    [validateReleaseManifest, 'release', 'stable.json'],
    [validateTelemetry, 'telemetry', 'batch.json'],
    [validateWebhook, 'webhook', 'member_joined.json'],
    [validateEntitlements, 'entitlements', 'free.json'],
  ] as const)('%o accepts its valid fixture', (fn, area, file) => {
    expect(fn(fixture(area, file).data).ok).toBe(true);
  });
});
