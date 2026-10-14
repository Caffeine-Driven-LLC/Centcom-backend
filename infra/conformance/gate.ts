/**
 * `pnpm gate:g1` ... `pnpm gate:g6` (B100): the provider-side checks of the integration gates, appended to the
 * `gates` section of `conformance-report.json`.
 *
 * G1 to G5 run the named test sets of `map.ts` (the strongest end-to-end suites for each gate) and pass when
 * no test fails and at least one passed. They are the **backend's** half: the joint gates also need the real
 * client. G6 aggregates the evidence files of the other lanes (conformance, load, chaos, dependencies, DR drill,
 * alert rules, release fixtures) and fails when any is missing, stale or red.
 *
 * Exit codes: 0 pass, 1 fail, 2 usage.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkFixture } from '@centcom/testkit';
import { GATE_TESTS } from './map.js';
import { summarize, type ConformanceReport, type GateCheck, type GateReport } from './report.js';
import { ROOT, runVitest } from './run-vitest.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where G6 looks for evidence, and how it runs commands; tests replace it. */
export interface G6Env {
  root: string;
  now: number;
  conformanceReport: string;
  chaosReport: string;
  drReport: string;
  /** Runs a repository command and returns its exit code and last output line. */
  exec(command: string, args: string[]): { code: number; tail: string };
}

const check = (name: string, ok: boolean, detail: string | null): GateCheck => ({
  name,
  status: ok ? 'pass' : 'fail',
  detail,
});

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

/** The G6 checks. A missing file is a failed check ("not found"), never a pass. */
export function evaluateG6(env: G6Env): GateCheck[] {
  const checks: GateCheck[] = [];

  const conf = readJson<ConformanceReport>(env.conformanceReport);
  if (conf === null)
    checks.push(
      check(
        'conformance report fresh and green',
        false,
        `${env.conformanceReport} not found: run pnpm conformance`,
      ),
    );
  else {
    const age = env.now - Date.parse(conf.generated_at);
    const gatesBad = ['G1', 'G2', 'G3', 'G4', 'G5'].filter(
      (id) => conf.gates.find((g) => g.id === id)?.status !== 'pass',
    );
    checks.push(
      check(
        'conformance report is less than 24 h old',
        age >= 0 && age < DAY_MS,
        `${Math.round(age / 3600000)} h old`,
      ),
    );
    checks.push(
      check(
        'no failed case in the conformance report',
        conf.summary.contracts_total > 0 &&
          conf.summary.failed === 0 &&
          conf.summary.contracts_failed === 0,
        `${conf.summary.failed} failed of ${conf.summary.cases_total}`,
      ),
    );
    checks.push(
      check(
        'gates G1 to G5 passed',
        gatesBad.length === 0,
        gatesBad.length === 0 ? null : `not passed: ${gatesBad.join(', ')}`,
      ),
    );
  }

  const loadDir = join(env.root, 'infra/loadtest/reports');
  const latest = new Map<string, { file: string; passed: boolean }>();
  if (existsSync(loadDir)) {
    for (const file of readdirSync(loadDir)
      .filter((f) => f.endsWith('.json'))
      .sort()) {
      const report = readJson<{ scenario?: string; passed?: boolean }>(join(loadDir, file));
      if (report?.scenario !== undefined)
        latest.set(report.scenario, { file, passed: report.passed === true });
    }
  }
  const required = ['smoke', 'ramp', 'rate', 'soak', 'storm', 'crossnode'];
  const missing = required.filter((s) => !latest.has(s));
  const red = required
    .filter((s) => latest.get(s)?.passed === false)
    .map((s) => latest.get(s)?.file ?? s);
  checks.push(
    check(
      'load reports (B095): all six profiles present and passed',
      missing.length === 0 && red.length === 0,
      missing.length > 0
        ? `missing: ${missing.join(', ')}`
        : red.length > 0
          ? `failed: ${red.join(', ')}`
          : null,
    ),
  );

  const chaos = readJson<{ scenario: string; passed: boolean }[]>(env.chaosReport);
  checks.push(
    check(
      'chaos report (B096): present and every scenario passed',
      chaos !== null && chaos.length >= 5 && chaos.every((c) => c.passed),
      chaos === null
        ? `${env.chaosReport} not found: run pnpm chaos with CHAOS_REPORT set`
        : `${chaos.filter((c) => c.passed).length}/${chaos.length} scenarios passed`,
    ),
  );

  const deps = env.exec('pnpm', ['security:deps']);
  checks.push(check('pnpm security:deps', deps.code === 0, deps.code === 0 ? null : deps.tail));

  const dr = readJson<{ started_at?: string; verified?: boolean }>(env.drReport);
  const drAge = dr?.started_at === undefined ? Infinity : env.now - Date.parse(dr.started_at);
  checks.push(
    check(
      'restore drill (B099): verified and less than 35 days old',
      dr?.verified === true && drAge < 35 * DAY_MS,
      dr === null
        ? `${env.drReport} not found: run pnpm dr:drill`
        : `verified ${String(dr.verified)}, ${Math.round(drAge / DAY_MS)} days old`,
    ),
  );

  const alerts = env.exec('pnpm', ['alerts:lint']);
  checks.push(check('pnpm alerts:lint', alerts.code === 0, alerts.code === 0 ? null : alerts.tail));

  const dir = join(env.root, 'contracts/fixtures/release');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  const schemaFile = join(env.root, 'contracts/schemas/release-manifest.schema.json');
  const bad = files.filter((f) => !checkFixture(join(dir, f), { schemaFile }).ok);
  checks.push(
    check(
      'release manifest fixtures validate',
      files.length > 0 && bad.length === 0,
      files.length === 0 ? 'no fixtures' : bad.length > 0 ? `invalid: ${bad.join(', ')}` : null,
    ),
  );
  return checks;
}

const defaultExec: G6Env['exec'] = (command, args) => {
  const r = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout: 10 * 60_000 });
  const lines = `${r.stdout}\n${r.stderr}`.trim().split('\n');
  return { code: r.status ?? 1, tail: lines[lines.length - 1] ?? '' };
};

/** Merges `gate` into the report file (creating a gate-only skeleton when there is none). */
export function writeGate(path: string, gate: GateReport): void {
  const existing = readJson<ConformanceReport>(path);
  const report: ConformanceReport = existing ?? {
    schema_version: 1,
    generated_at: new Date(0).toISOString(),
    git_sha: 'unknown',
    contract_version: 'unknown',
    contracts_lock_hash: 'unknown',
    target: { kind: 'local', base_url: 'in-process' },
    duration_ms: 0,
    summary: summarize([]),
    contracts: [],
    gates: [],
  };
  report.gates = [...report.gates.filter((g) => g.id !== gate.id), gate].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

function main(): number {
  const id = process.argv[2]?.toUpperCase();
  if (id === undefined || !['G1', 'G2', 'G3', 'G4', 'G5', 'G6'].includes(id)) {
    process.stderr.write('usage: gate.ts G1|G2|G3|G4|G5|G6 [--report file]\n');
    return 2;
  }
  const reportFlag = process.argv.indexOf('--report');
  const reportPath = resolve(
    process.cwd(),
    reportFlag > 0 ? (process.argv[reportFlag + 1] ?? '') : 'conformance-report.json',
  );
  let checks: GateCheck[];
  if (id === 'G6') {
    checks = evaluateG6({
      root: ROOT,
      now: Date.now(),
      conformanceReport: reportPath,
      chaosReport: join(process.cwd(), 'chaos-report.json'),
      drReport: join(process.cwd(), 'dr-drill-report.json'),
      exec: defaultExec,
    });
  } else {
    const set = GATE_TESTS[id as keyof typeof GATE_TESTS];
    process.stderr.write(`${id}: ${set.title}\n`);
    const results = runVitest(set.tests);
    checks = set.tests.map((entry) => {
      const files = results.filter((r) => r.file === entry || r.file.startsWith(`${entry}/`));
      const assertions = files.flatMap((f) => f.assertions);
      const failed =
        assertions.filter((a) => a.status === 'failed').length +
        files.filter((f) => f.assertions.length === 0 && f.status !== 'passed').length;
      const passed = assertions.filter((a) => a.status === 'passed').length;
      return check(
        entry,
        failed === 0 && passed > 0,
        failed > 0
          ? `${failed} failed`
          : passed === 0
            ? 'nothing ran (skipped or missing)'
            : `${passed} passed in ${files.length} files`,
      );
    });
  }
  const gate: GateReport = {
    id: id as GateReport['id'],
    status: checks.every((c) => c.status === 'pass') ? 'pass' : 'fail',
    checks,
  };
  writeGate(reportPath, gate);
  for (const c of checks)
    process.stdout.write(
      `${c.status === 'pass' ? 'ok  ' : 'FAIL'} ${c.name}${c.detail === null ? '' : `: ${c.detail}`}\n`,
    );
  process.stdout.write(`${id} ${gate.status}\n`);
  return gate.status === 'pass' ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) process.exit(main());
