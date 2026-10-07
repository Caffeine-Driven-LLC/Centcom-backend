/**
 * Contract fixture runner (B010 acceptance 5): one registered test per file of
 * contracts/fixtures/events (45 at contract 1.2.0), all passing, and a deliberately broken copy
 * failing; `{schema, valid, data}` fixtures judged by their declared verdict; `defKey` payload
 * checks; and fixtures the runner cannot judge fail rather than pass.
 */
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkFixture, runFixtureSuite } from '../../src/index.js';
import { CONTRACTS } from './helpers.js';

const EVENTS = join(CONTRACTS, 'fixtures', 'events');
const EVENTS_SCHEMA = join(CONTRACTS, 'schemas', 'events.schema.json');
const PROBLEMS = join(CONTRACTS, 'fixtures', 'problem');
const PROBLEM_SCHEMA = join(CONTRACTS, 'schemas', 'problem.schema.json');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function copyOf(dir: string): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), 'centcom-fixtures-'));
  cleanups.push(() => rm(target, { recursive: true, force: true }));
  await cp(dir, target, { recursive: true });
  return target;
}

/** Collects what runFixtureSuite registers, instead of handing it to vitest. */
function collect(opts: Parameters<typeof runFixtureSuite>[0]): Map<string, () => void> {
  const cases = new Map<string, () => void>();
  runFixtureSuite({ ...opts, register: (name, check) => cases.set(name, check) });
  return cases;
}

describe('the events fixtures, registered as vitest cases', () => {
  // The real thing: one `it` per fixture file, here in the test report.
  runFixtureSuite({ fixturesDir: EVENTS, schemaFile: EVENTS_SCHEMA });
});

describe('runFixtureSuite', () => {
  it('registers one case per events fixture file (45 at contract 1.2.0), and every one passes (acceptance 5)', async () => {
    const files = (await readdir(EVENTS)).filter((f) => f.endsWith('.json')).sort();
    const cases = collect({ fixturesDir: EVENTS, schemaFile: EVENTS_SCHEMA });
    expect([...cases.keys()]).toEqual(files);
    expect(cases.size).toBe(45);
    for (const [name, check] of cases) expect(check, name).not.toThrow();
  });

  it('checks the same frames against the envelope schema with a second suite', () => {
    const cases = collect({
      fixturesDir: EVENTS,
      schemaFile: join(CONTRACTS, 'schemas', 'envelope.schema.json'),
    });
    expect(cases.size).toBe(45);
    for (const [name, check] of cases) expect(check, name).not.toThrow();
  });

  it('fails the case of a fixture that was made invalid (acceptance 5)', async () => {
    const dir = await copyOf(EVENTS);
    const file = join(dir, 'agent.exit.json');
    const fixture = JSON.parse(await readFile(file, 'utf8')) as {
      frame: { p: Record<string, unknown> };
    };
    // events.schema.json holds the per-kind rules (the envelope's own fields are envelope.schema.json's).
    fixture.frame.p['outcome'] = 'exploded';
    await writeFile(file, JSON.stringify(fixture));
    const cases = collect({ fixturesDir: dir, schemaFile: EVENTS_SCHEMA });
    expect(cases.get('agent.exit.json')).toThrow(/agent\.exit\.json: the event does not validate/);
    expect(cases.get('agent.spawn.json')).not.toThrow();
  });

  it('fails an event whose secret payload breaks its schema', async () => {
    const dir = await copyOf(EVENTS);
    const file = join(dir, 'message.user.json');
    const fixture = JSON.parse(await readFile(file, 'utf8')) as {
      secret_payload: Record<string, unknown>;
    };
    delete fixture.secret_payload['text'];
    await writeFile(file, JSON.stringify(fixture));
    expect(checkFixture(file, { schemaFile: EVENTS_SCHEMA })).toMatchObject({
      ok: false,
      message: expect.stringContaining('the secret payload does not validate'),
    });
  });

  it('judges {schema, valid, data} fixtures by their declared verdict', async () => {
    const cases = collect({ fixturesDir: PROBLEMS, schemaFile: PROBLEM_SCHEMA });
    expect([...cases.keys()]).toEqual([
      'missing_code.json',
      'quota.json',
      'status_200.json',
      'validation.json',
    ]);
    for (const [name, check] of cases) expect(check, name).not.toThrow();

    // Flip a verdict: the fixture no longer gets the result it declares.
    const dir = await copyOf(PROBLEMS);
    const file = join(dir, 'missing_code.json');
    const fixture = JSON.parse(await readFile(file, 'utf8')) as { valid: boolean };
    fixture.valid = true;
    await writeFile(file, JSON.stringify(fixture));
    expect(checkFixture(file, { schemaFile: PROBLEM_SCHEMA })).toMatchObject({
      ok: false,
      message: expect.stringContaining('missing_code.json should validate'),
    });
  });

  it('checks a cleartext payload against a $defs entry with defKey, and fails a missing definition', () => {
    const defKey = (name: string): string => `p_${name.replace(/\.json$/, '').replace(/\./g, '_')}`;
    expect(
      checkFixture(join(EVENTS, 'agent.exit.json'), { schemaFile: EVENTS_SCHEMA, defKey }),
    ).toEqual({
      ok: true,
      message: '',
    });
    // message.user is encrypted: there is no cleartext payload definition to check against.
    expect(
      checkFixture(join(EVENTS, 'message.user.json'), { schemaFile: EVENTS_SCHEMA, defKey }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('has no $defs/p_message_user'),
    });
  });

  it('fails what it cannot judge instead of passing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'centcom-fixtures-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, 'odd.json'), JSON.stringify({ hello: 'world' }));
    await writeFile(join(dir, 'broken.json'), '{ not json');
    await writeFile(
      join(dir, 'other.json'),
      JSON.stringify({ schema: 'envelope.schema.json', valid: true, data: {} }),
    );
    expect(checkFixture(join(dir, 'odd.json'), { schemaFile: PROBLEM_SCHEMA }).message).toContain(
      'neither',
    );
    expect(
      checkFixture(join(dir, 'broken.json'), { schemaFile: PROBLEM_SCHEMA }).message,
    ).toContain('not readable JSON');
    expect(checkFixture(join(dir, 'other.json'), { schemaFile: PROBLEM_SCHEMA }).message).toContain(
      'is a fixture for envelope.schema.json, not problem.schema.json',
    );
  });
});
