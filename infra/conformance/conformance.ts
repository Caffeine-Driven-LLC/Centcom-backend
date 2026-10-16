/**
 * `pnpm conformance [--only CT-A,CT-B] [--strict] [--target local|stage] [--report file]` (B100): runs the
 * tests that prove each contract the backend implements (the map in `map.ts`), runs every event fixture
 * through its schema, and writes `conformance-report.json`.
 *
 * Exit codes: 0 all pass; 1 any failure; 2 usage; 3 `--strict` and a contract without fixtures or without
 * a run. Needs Postgres and Redis for the suites that use them (DATABASE_URL and REDIS_URL, or Docker);
 * a suite that is skipped for lack of them counts as skipped, and a contract with nothing but skipped
 * cases is a failure, never a silent pass.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { checkFixture } from '@centcom/testkit';
import { CONFORMANCE_MAP } from './map.js';
import {
  exitCode,
  summarize,
  type CaseReport,
  type ConformanceReport,
  type ContractReport,
} from './report.js';
import { ROOT, runVitest, type FileResult } from './run-vitest.js';

interface IndexContract {
  id: string;
  implemented_by: string[];
}

export interface Options {
  only: string[] | null;
  strict: boolean;
  report: string;
  target: 'local' | 'stage';
}

/** Parses the command line; throws a usage message. */
export function parseArgs(argv: readonly string[]): Options {
  const o: Options = {
    only: null,
    strict: false,
    report: 'conformance-report.json',
    target: 'local',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      i += 1;
      const v = argv[i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '--strict') o.strict = true;
    else if (arg === '--only') o.only = value().split(',').filter(Boolean);
    else if (arg === '--report') o.report = value();
    else if (arg === '--target') {
      const t = value();
      if (t !== 'local' && t !== 'stage') throw new Error('--target is local or stage');
      o.target = t;
    } else throw new Error(`unknown argument ${arg}`);
  }
  return o;
}

/** The contracts the backend implements, from contracts/index.json. */
export function backendContracts(root: string = ROOT): { version: string; ids: string[] } {
  const index = JSON.parse(readFileSync(join(root, 'contracts/index.json'), 'utf8')) as {
    contract_version: string;
    contracts: IndexContract[];
  };
  return {
    version: index.contract_version,
    ids: index.contracts.filter((c) => c.implemented_by.includes('backend')).map((c) => c.id),
  };
}

/** Every file under contracts/fixtures/<area>, sorted. */
const fixtureFiles = (area: string, root: string): string[] => {
  const dir = join(root, 'contracts/fixtures', area);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : [];
};

/** One case per event fixture: the frame (and its secret payload) must validate against the events schema. */
export function eventFixtureCases(root: string = ROOT): CaseReport[] {
  const schemaFile = join(root, 'contracts/schemas/events.schema.json');
  return fixtureFiles('events', root).map((name) => {
    const started = Date.now();
    const result = checkFixture(join(root, 'contracts/fixtures/events', name), { schemaFile });
    return {
      name: `fixture events/${name}`,
      fixture: name,
      status: result.ok ? 'pass' : 'fail',
      duration_ms: Date.now() - started,
      error: result.ok
        ? null
        : { message: result.message, pointer: `contracts/fixtures/events/${name}` },
    };
  });
}

/** True when result file `file` belongs to a map entry (equal, or inside a folder entry). */
const covers = (entry: string, file: string): boolean =>
  file === entry || file.startsWith(`${entry}/`);

/** One contract's report from the vitest results. */
export function contractReport(
  id: string,
  results: readonly FileResult[],
  root: string = ROOT,
): ContractReport {
  const evidence = CONFORMANCE_MAP[id];
  if (evidence === undefined) {
    return { id, status: 'not_run', fixtures_run: 0, tests: [], cases: [] };
  }
  const files = results.filter((r) => evidence.tests.some((t) => covers(t, r.file)));
  const cases: CaseReport[] = [];
  for (const f of files) {
    if (f.assertions.length === 0) {
      cases.push({
        name: `${f.file} (file)`,
        fixture: null,
        status: f.status === 'passed' ? 'skip' : 'fail',
        duration_ms: 0,
        error:
          f.status === 'passed'
            ? null
            : { message: f.message.slice(0, 500) || 'the file failed to run', pointer: f.file },
      });
    }
    for (const a of f.assertions) {
      const status = a.status === 'passed' ? 'pass' : a.status === 'failed' ? 'fail' : 'skip';
      cases.push({
        name: `${f.file} > ${a.fullName}`,
        fixture: null,
        status,
        duration_ms: Math.round(a.duration ?? 0),
        error:
          status === 'fail'
            ? { message: (a.failureMessages[0] ?? 'failed').slice(0, 500), pointer: f.file }
            : null,
      });
    }
  }
  let fixturesRun = 0;
  let missing = false;
  for (const area of evidence.fixtures ?? []) {
    const count = fixtureFiles(area, root).length;
    if (count === 0) missing = true;
    fixturesRun += count;
  }
  if (id === 'CT-WS-SESSION-EVENTS') {
    const fixtureCases = eventFixtureCases(root);
    cases.push(...fixtureCases);
    // The directory and the report must agree: a fixture the run skipped is a failure.
    if (fixtureCases.length !== fixtureFiles('events', root).length) {
      cases.push({
        name: 'fixture count',
        fixture: null,
        status: 'fail',
        duration_ms: 0,
        error: {
          message: 'event fixtures run differ from the directory',
          pointer: 'contracts/fixtures/events',
        },
      });
    }
  }
  const failed = cases.some((c) => c.status === 'fail');
  const ranSomething = cases.some((c) => c.status === 'pass');
  const status: ContractReport['status'] = failed
    ? 'fail'
    : !ranSomething
      ? 'fail'
      : missing
        ? 'missing_fixtures'
        : 'pass';
  if (!failed && !ranSomething) {
    cases.push({
      name: 'nothing ran',
      fixture: null,
      status: 'fail',
      duration_ms: 0,
      error: {
        message:
          'every test of this contract was skipped or missing (is Postgres/Redis available?)',
        pointer: null,
      },
    });
  }
  return { id, status, fixtures_run: fixturesRun, tests: files.map((f) => f.file), cases };
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Builds the report from results. Gates are carried over from `previous`, when given. */
export function assemble(
  options: Options,
  ids: string[],
  version: string,
  results: readonly FileResult[],
  startedAt: number,
  previous?: ConformanceReport,
  root: string = ROOT,
): ConformanceReport {
  const contracts = ids.map((id) => contractReport(id, results, root));
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const lock = existsSync(join(root, 'contracts/CONTRACTS.lock'))
    ? readFileSync(join(root, 'contracts/CONTRACTS.lock'), 'utf8')
    : '';
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    git_sha: git.stdout.trim() || 'unknown',
    contract_version: version,
    contracts_lock_hash: sha(lock),
    target: { kind: options.target, base_url: options.target === 'local' ? 'in-process' : 'stage' },
    duration_ms: Date.now() - startedAt,
    summary: summarize(contracts),
    contracts,
    gates: previous?.gates ?? [],
  };
}

function main(): number {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(
      `${(err as Error).message}\nusage: pnpm conformance [--only CT-ID,...] [--strict] [--target local|stage] [--report file]\n`,
    );
    return 2;
  }
  if (options.target === 'stage') {
    process.stderr.write(
      '--target stage needs a stage environment, which this repository does not have yet\n',
    );
    return 2;
  }
  const { version, ids: all } = backendContracts();
  const ids = options.only === null ? all : all.filter((id) => options.only?.includes(id));
  const unknown = (options.only ?? []).filter((id) => !all.includes(id));
  if (unknown.length > 0) {
    process.stderr.write(`not a backend contract: ${unknown.join(', ')}\n`);
    return 2;
  }
  const started = Date.now();
  const paths = [...new Set(ids.flatMap((id) => CONFORMANCE_MAP[id]?.tests ?? []))];
  process.stderr.write(`running ${paths.length} test paths for ${ids.length} contracts...\n`);
  const results = runVitest(paths);
  const path = resolve(process.cwd(), options.report);
  const previous = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as ConformanceReport)
    : undefined;
  const report = assemble(options, ids, version, results, started, previous);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  for (const c of report.contracts) {
    process.stdout.write(
      `${c.status.padEnd(16)} ${c.id} (${c.cases.length} cases, ${c.fixtures_run} fixtures)\n`,
    );
    // what failed, so a red run explains itself in the log (the report holds the same, 500 characters each)
    for (const k of c.cases) {
      if (k.status !== 'fail') continue;
      const first = (k.error?.message ?? 'failed').split('\n')[0]?.slice(0, 200) ?? 'failed';
      process.stdout.write(`    FAILED ${k.name}\n      ${first}\n`);
    }
  }
  const s = report.summary;
  process.stdout.write(
    `${s.contracts_passed}/${s.contracts_total} contracts, ${s.passed} cases passed, ${s.failed} failed, ${s.skipped} skipped, ${s.missing_fixtures} missing fixtures -> ${options.report}\n`,
  );
  return exitCode(report, options.strict);
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) process.exit(main());
