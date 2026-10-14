/**
 * The conformance tooling (B100): the map covers every contract the backend implements and names real
 * paths, the report builder judges contracts the way the card says (a skipped contract is not green, a
 * broken fixture fails the contract), the report validates and its exit codes hold, and G6 refuses
 * missing, stale or red evidence. No Postgres, no vitest child: results are fed in.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assemble,
  backendContracts,
  contractReport,
  eventFixtureCases,
  parseArgs,
} from './conformance.js';
import { evaluateG6, writeGate, type G6Env } from './gate.js';
import { CONFORMANCE_MAP, GATE_TESTS } from './map.js';
import { exitCode, reportProblems, type ConformanceReport } from './report.js';
import { ROOT, type FileResult } from './run-vitest.js';

const temps: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'conf-test-'));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const file = (name: string, statuses: string[]): FileResult => ({
  file: name,
  status: statuses.includes('failed') ? 'failed' : 'passed',
  message: '',
  assertions: statuses.map((status, i) => ({
    fullName: `case ${i}`,
    status,
    duration: 1,
    failureMessages: status === 'failed' ? ['boom'] : [],
  })),
});

describe('the map', () => {
  const { ids } = backendContracts();

  it('has an entry for every contract the backend implements, and for no other', () => {
    expect(Object.keys(CONFORMANCE_MAP).sort()).toEqual([...ids].sort());
    expect(ids.length).toBe(28);
  });

  it('names only paths that exist', () => {
    const paths = [
      ...Object.values(CONFORMANCE_MAP).flatMap((e) => e.tests),
      ...Object.values(GATE_TESTS).flatMap((g) => g.tests),
    ];
    for (const p of paths) expect(existsSync(join(ROOT, p)), p).toBe(true);
    for (const e of Object.values(CONFORMANCE_MAP)) {
      for (const area of e.fixtures ?? [])
        expect(existsSync(join(ROOT, 'contracts/fixtures', area)), area).toBe(true);
    }
  });
});

describe('contract judgement', () => {
  it('passes a contract whose tests passed and fixtures run', () => {
    const c = contractReport('CT-API-USAGE', [
      file('apps/api/test/usage/ingest/usage.ingest.test.ts', ['passed', 'passed']),
    ]);
    expect(c.status).toBe('pass');
    expect(c.cases).toHaveLength(2);
  });

  it('fails a contract with one failing case, with the message and the file as pointer', () => {
    const c = contractReport('CT-API-USAGE', [
      file('apps/api/test/usage/ingest/usage.ingest.test.ts', ['passed', 'failed']),
    ]);
    expect(c.status).toBe('fail');
    expect(c.cases.find((k) => k.status === 'fail')?.error).toEqual({
      message: 'boom',
      pointer: 'apps/api/test/usage/ingest/usage.ingest.test.ts',
    });
  });

  it('never calls a contract green when everything was skipped or nothing ran', () => {
    expect(
      contractReport('CT-API-USAGE', [
        file('apps/api/test/usage/ingest/usage.ingest.test.ts', ['skipped']),
      ]).status,
    ).toBe('fail');
    expect(contractReport('CT-API-USAGE', []).status).toBe('fail');
  });

  it('fails a contract whose test file failed to load', () => {
    const broken: FileResult = {
      file: 'apps/api/test/usage/aggregation/x.test.ts',
      status: 'failed',
      message: 'Cannot find module',
      assertions: [],
    };
    expect(contractReport('CT-API-USAGE', [broken]).status).toBe('fail');
  });

  it('reports missing fixtures when the folder it consumes is empty', () => {
    const root = tmp();
    mkdirSync(join(root, 'contracts/fixtures/telemetry'), { recursive: true });
    const c = contractReport(
      'CT-TELEMETRY',
      [file('apps/api/test/telemetry/telemetry.routes.test.ts', ['passed'])],
      root,
    );
    expect(c.status).toBe('missing_fixtures');
  });

  it('runs every event fixture of the directory, and a broken one fails CT-WS-SESSION-EVENTS', () => {
    const real = eventFixtureCases();
    expect(real.length).toBeGreaterThanOrEqual(42);
    expect(real.every((c) => c.status === 'pass')).toBe(true);
    const root = tmp();
    cpSync(join(ROOT, 'contracts/schemas'), join(root, 'contracts/schemas'), { recursive: true });
    mkdirSync(join(root, 'contracts/fixtures/events'), { recursive: true });
    writeFileSync(
      join(root, 'contracts/fixtures/events/broken.json'),
      JSON.stringify({
        kind: 'message.user',
        frame: { v: 1, t: 'event', id: 'not-an-id', k: 'message.user' },
        secret_payload: null,
      }),
    );
    const cases = eventFixtureCases(root);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ status: 'fail', fixture: 'broken.json' });
    expect(cases[0]?.error?.pointer).toBe('contracts/fixtures/events/broken.json');
  });
});

describe('the report', () => {
  const build = (results: FileResult[]): ConformanceReport =>
    assemble(
      { only: null, strict: false, report: 'x.json', target: 'local' },
      ['CT-API-USAGE', 'CT-API-FLAGS'],
      '1.0.0',
      results,
      Date.now(),
    );

  it('validates, and its summary adds up', () => {
    const report = build([
      file('apps/api/test/usage/ingest/usage.ingest.test.ts', ['passed']),
      file('apps/api/test/flags/flags.units.test.ts', ['passed', 'skipped']),
    ]);
    expect(reportProblems(report)).toEqual([]);
    expect(report.summary).toMatchObject({
      contracts_total: 2,
      contracts_passed: 2,
      cases_total: 3,
      passed: 2,
      skipped: 1,
      failed: 0,
    });
  });

  it('is stable: the same results give the same summary and case names', () => {
    const results = [
      file('apps/api/test/usage/ingest/usage.ingest.test.ts', ['passed']),
      file('apps/api/test/flags/flags.units.test.ts', ['passed']),
    ];
    const [a, b] = [build(results), build(results)];
    expect(a.summary).toEqual(b.summary);
    expect(a.contracts.map((c) => c.cases.map((k) => k.name))).toEqual(
      b.contracts.map((c) => c.cases.map((k) => k.name)),
    );
  });

  it('is refused when it is hand-edited out of shape', () => {
    const report = build([file('apps/api/test/usage/ingest/usage.ingest.test.ts', ['passed'])]);
    expect(reportProblems({ ...report, summary: { ...report.summary, passed: 99 } })).not.toEqual(
      [],
    );
    expect(reportProblems({ ...report, schema_version: 2 })).not.toEqual([]);
    expect(reportProblems(null)).toEqual(['not an object']);
  });

  it('exits 0 when green, 1 on a failure, 3 under --strict with a contract that did not run', () => {
    const green = build([
      file('apps/api/test/usage/ingest/usage.ingest.test.ts', ['passed']),
      file('apps/api/test/flags/flags.units.test.ts', ['passed']),
    ]);
    expect(exitCode(green, false)).toBe(0);
    expect(exitCode(green, true)).toBe(0);
    const red = build([
      file('apps/api/test/usage/ingest/usage.ingest.test.ts', ['failed']),
      file('apps/api/test/flags/flags.units.test.ts', ['passed']),
    ]);
    expect(exitCode(red, true)).toBe(1);
    const fixtureless: ConformanceReport = {
      ...green,
      contracts: green.contracts.map((c, i) =>
        i === 0 ? { ...c, status: 'missing_fixtures' as const } : c,
      ),
    };
    expect(exitCode(fixtureless, false)).toBe(0);
    expect(exitCode(fixtureless, true)).toBe(3);
  });

  it('writes a gate into the report file without losing the contracts', () => {
    const dir = tmp();
    const path = join(dir, 'report.json');
    writeGate(path, { id: 'G2', status: 'pass', checks: [] });
    writeGate(path, {
      id: 'G1',
      status: 'fail',
      checks: [{ name: 'x', status: 'fail', detail: 'y' }],
    });
    writeGate(path, { id: 'G2', status: 'fail', checks: [] });
    const written = JSON.parse(require_(path)) as ConformanceReport;
    expect(written.gates.map((g) => `${g.id}:${g.status}`)).toEqual(['G1:fail', 'G2:fail']);
  });
});

describe('arguments', () => {
  it('parses the flags and refuses the rest', () => {
    expect(parseArgs(['--strict', '--only', 'CT-ERR,CT-PAGE', '--report', 'r.json'])).toMatchObject(
      { strict: true, only: ['CT-ERR', 'CT-PAGE'], report: 'r.json', target: 'local' },
    );
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--target', 'moon'])).toThrow(/local or stage/);
  });
});

describe('G6 evidence', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');

  /** A repository-shaped folder with every piece of evidence green. */
  function green(): { env: G6Env; dir: string } {
    const dir = tmp();
    mkdirSync(join(dir, 'infra/loadtest/reports'), { recursive: true });
    for (const s of ['smoke', 'ramp', 'rate', 'soak', 'storm', 'crossnode']) {
      writeFileSync(
        join(dir, `infra/loadtest/reports/2026-10-13-relay-${s}.json`),
        JSON.stringify({ scenario: s, passed: true }),
      );
    }
    cpSync(join(ROOT, 'contracts/schemas'), join(dir, 'contracts/schemas'), { recursive: true });
    cpSync(join(ROOT, 'contracts/fixtures/release'), join(dir, 'contracts/fixtures/release'), {
      recursive: true,
    });
    const conformance: ConformanceReport = {
      ...assemble(
        { only: null, strict: false, report: 'x', target: 'local' },
        ['CT-API-USAGE'],
        '1.0.0',
        [file('apps/api/test/usage/ingest/usage.ingest.test.ts', ['passed'])],
        now,
      ),
      generated_at: new Date(now - 3600_000).toISOString(),
      gates: (['G1', 'G2', 'G3', 'G4', 'G5'] as const).map((id) => ({
        id,
        status: 'pass' as const,
        checks: [],
      })),
    };
    writeFileSync(join(dir, 'conformance.json'), JSON.stringify(conformance));
    writeFileSync(
      join(dir, 'chaos.json'),
      JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ scenario: `s${i}`, passed: true }))),
    );
    writeFileSync(
      join(dir, 'dr.json'),
      JSON.stringify({ started_at: new Date(now - 5 * 86400_000).toISOString(), verified: true }),
    );
    return {
      dir,
      env: {
        root: dir,
        now,
        conformanceReport: join(dir, 'conformance.json'),
        chaosReport: join(dir, 'chaos.json'),
        drReport: join(dir, 'dr.json'),
        exec: () => ({ code: 0, tail: 'ok' }),
      },
    };
  }

  it('passes with every piece of evidence fresh and green', () => {
    const { env } = green();
    const checks = evaluateG6(env);
    expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
  });

  it.each([
    [
      'a missing conformance report',
      (d: string) => rmSync(join(d, 'conformance.json')),
      'conformance report fresh and green',
    ],
    ['a missing chaos report', (d: string) => rmSync(join(d, 'chaos.json')), 'chaos report'],
    ['a missing drill report', (d: string) => rmSync(join(d, 'dr.json')), 'restore drill'],
    [
      'a red load profile',
      (d: string) =>
        writeFileSync(
          join(d, 'infra/loadtest/reports/2026-10-13-relay-soak.json'),
          JSON.stringify({ scenario: 'soak', passed: false }),
        ),
      'load reports',
    ],
    [
      'a missing load profile',
      (d: string) => rmSync(join(d, 'infra/loadtest/reports/2026-10-13-relay-storm.json')),
      'load reports',
    ],
    [
      'a drill older than 35 days',
      (d: string) =>
        writeFileSync(
          join(d, 'dr.json'),
          JSON.stringify({
            started_at: new Date(now - 40 * 86400_000).toISOString(),
            verified: true,
          }),
        ),
      'restore drill',
    ],
    [
      'an unverified drill',
      (d: string) =>
        writeFileSync(
          join(d, 'dr.json'),
          JSON.stringify({ started_at: new Date(now).toISOString(), verified: false }),
        ),
      'restore drill',
    ],
  ])('fails on %s', (_name, spoil, failing) => {
    const { env, dir } = green();
    spoil(dir);
    const failed = evaluateG6(env).filter((c) => c.status === 'fail');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.some((c) => c.name.includes(failing))).toBe(true);
  });

  it('fails on a stale conformance report, a gate that did not pass, and a failing command', () => {
    const { env, dir } = green();
    const stale = JSON.parse(require_(env.conformanceReport)) as ConformanceReport;
    stale.generated_at = new Date(now - 30 * 3600_000).toISOString();
    stale.gates = stale.gates.map((g) => (g.id === 'G3' ? { ...g, status: 'fail' as const } : g));
    writeFileSync(env.conformanceReport, JSON.stringify(stale));
    const names = evaluateG6({
      ...env,
      exec: (_c, args) => ({ code: args[0] === 'alerts:lint' ? 1 : 0, tail: 'lint broke' }),
    })
      .filter((c) => c.status === 'fail')
      .map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'conformance report is less than 24 h old',
        'gates G1 to G5 passed',
        'pnpm alerts:lint',
      ]),
    );
    void dir;
  });
});

import { readFileSync } from 'node:fs';
function require_(path: string): string {
  return readFileSync(path, 'utf8');
}
