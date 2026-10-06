/**
 * Every contract fixture against the generated validators (B003 acceptance 5), plus the
 * required-field removal check: dropping a required field must fail with a pointer to it.
 */
import { describe, expect, it } from 'vitest';
import {
  EVENT_CATALOGUE,
  EVENT_KINDS,
  validate,
  validateEnvelope,
  validateEvent,
  validateEventSecret,
  type EventKind,
  type Result,
  type SchemaKey,
} from '../src/index.js';
import { clone, fixtureFiles, readContract, type EventFixture, type GenericFixture, type JsonObject } from './contracts.js';

/** Not schema fixtures; tools/plan/validate_contracts.py checks them (crypto vectors, secret patterns). */
const NON_SCHEMA_FIXTURES = ['crypto/vectors.json', 'providers/secret-patterns.json'];

const files = fixtureFiles();
const generic = files.filter(([area, f]) => area !== 'events' && !NON_SCHEMA_FIXTURES.includes(`${area}/${f}`));
const eventFiles = files.filter(([area]) => area === 'events').map(([, f]) => f);
const eventsSchema = readContract<{ $defs: Record<string, { required?: string[] }> }>('schemas', 'events.schema.json');

/** A copy of `obj` without `key` (the field-removal checks below). */
const without = (obj: JsonObject, key: string): JsonObject =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
const pointers = (r: Result<unknown>): string[] => (r.ok ? [] : r.errors.map((e) => e.pointer));
const defRequired = (prefix: 'p' | 's', kind: string): string[] =>
  eventsSchema.$defs[`${prefix}_${kind.replace(/\./g, '_')}`]?.required ?? [];

/** Frame fields that envelope.schema.json and events.schema.json require for this frame. */
function requiredFrameFields(frame: JsonObject, kind: EventKind): string[] {
  const t = String(frame.t);
  const { mode } = EVENT_CATALOGUE[kind];
  return [
    'v',
    't',
    ...(['event', 'queue', 'control', 'presence'].includes(t) ? ['k', 'sid'] : []),
    ...(['event', 'queue', 'control'].includes(t) ? ['id'] : []),
    ...('ct' in frame ? ['sig'] : []),
    ...(mode !== 'encrypted' ? ['p'] : []),
    ...(mode !== 'clear' ? ['ct'] : []),
  ];
}

describe('fixture inventory', () => {
  it('covers every file under contracts/fixtures', () => {
    for (const f of NON_SCHEMA_FIXTURES) {
      const [area = '', file = ''] = f.split('/');
      expect(files).toContainEqual([area, file]);
      expect(readContract('fixtures', area, file)).not.toHaveProperty('schema');
    }
    expect(generic.length + eventFiles.length + NON_SCHEMA_FIXTURES.length).toBe(files.length);
  });

  it('has exactly one event fixture per catalogue kind (45 at contract 1.2.0)', () => {
    const kinds = eventFiles.map((f) => readContract<EventFixture>('fixtures', 'events', f).kind);
    expect([...kinds].sort()).toEqual([...EVENT_KINDS].sort());
    expect(kinds).toHaveLength(EVENT_KINDS.length);
  });
});

describe.each(generic)('fixtures/%s/%s', (area, file) => {
  const fx = readContract<GenericFixture>('fixtures', area, file);
  const key = fx.schema.replace(/\.schema\.json$/, '') as SchemaKey;

  it(`is ${fx.valid ? 'valid' : 'invalid'} against ${fx.schema}`, () => {
    const r = validate(key, fx.data);
    expect(r.ok, JSON.stringify(r)).toBe(fx.valid);
    if (!r.ok) for (const e of r.errors) expect(e.pointer === '' || e.pointer.startsWith('/')).toBe(true);
  });
});

describe.each(eventFiles)('fixtures/events/%s', (file) => {
  const fx = readContract<EventFixture>('fixtures', 'events', file);
  const kind = fx.kind as EventKind;
  const entry = EVENT_CATALOGUE[kind];

  it('the frame validates (envelope + events)', () => {
    expect(validateEnvelope(fx.frame)).toEqual({ ok: true, value: fx.frame });
  });

  it('the cleartext payload validates', () => {
    expect(validateEvent(kind, fx.frame.p).ok).toBe(true);
    if (entry.mode === 'encrypted') expect(fx.frame.p).toBeUndefined();
    else expect(fx.frame.p).toBeDefined();
  });

  it('the secret payload validates', () => {
    if (fx.secret_payload === null) {
      expect(entry.mode).toBe('clear');
    } else {
      expect(entry.secret).toBe(true);
      expect(validateEventSecret(kind as never, fx.secret_payload).ok).toBe(true);
    }
  });

  it('is rejected in the wrong payload mode', () => {
    const wrong = clone(fx.frame);
    if (entry.mode === 'clear') {
      wrong.ct = { alg: 'xchacha20poly1305', kid: 'k1', n: 'A'.repeat(32), c: 'AAAA' };
      wrong.sig = 'AAAA';
    } else {
      wrong.p = {};
    }
    if (entry.mode !== 'hybrid') expect(validateEnvelope(wrong).ok).toBe(false);
    if (entry.mode === 'encrypted') expect(validateEvent(kind, {}).ok).toBe(false);
  });

  it('fails with a pointer to any removed required frame field', () => {
    for (const field of requiredFrameFields(fx.frame, kind)) {
      const r = validateEnvelope(without(fx.frame, field));
      expect(r.ok, `without ${field}`).toBe(false);
      expect(pointers(r), `without ${field}`).toContain(`/${field}`);
    }
  });

  it('fails with a pointer to any removed required cleartext field', () => {
    const required = defRequired('p', kind);
    if (entry.mode !== 'encrypted') expect(required.length).toBeGreaterThan(0);
    for (const field of required) {
      const p = without(fx.frame.p as JsonObject, field);
      expect(pointers(validateEnvelope({ ...fx.frame, p })), `frame without p.${field}`).toContain(`/p/${field}`);
      expect(pointers(validateEvent(kind, p)), `payload without ${field}`).toContain(`/${field}`);
    }
  });

  it('fails with a pointer to any removed required secret field', () => {
    if (fx.secret_payload === null) return;
    for (const field of defRequired('s', kind)) {
      const secret = without(fx.secret_payload, field);
      expect(pointers(validateEventSecret(kind as never, secret)), `secret without ${field}`).toContain(`/${field}`);
    }
  });
});
