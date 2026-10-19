/**
 * `pnpm chaos --scenario <id|all> --env local [--duration-s N] [--api-url URL] [--project NAME]
 * [--env-file FILE] [--file FILE] [--report FILE]`, `pnpm chaos heal ...`, `pnpm chaos list` (B096).
 *
 * Runs the scenarios in `infra/chaos/scenarios/` against a compose stack on this machine (the
 * production compose file; `infra/deploy/bluegreen-drill.sh --keep` brings one up) and writes
 * `chaos-report.json`. Refuses `--env prod` and any address that is not loopback (exit 2); `--env stage`
 * is not built (exit 2). `heal` unpauses and starts whatever a crashed run left down.
 *
 * Exit codes: 0 every scenario passed; 1 a scenario failed; 2 usage or a refused environment.
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { composeInjector, composeProber, healAll, type ComposeTarget } from './compose.js';
import { realClock, runScenario, type ScenarioReport } from './engine.js';
import {
  assertAllowedEnv,
  EnvRefused,
  loadScenarios,
  ScenarioError,
  type Scenario,
} from './scenario.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');

export interface Args {
  command: 'run' | 'heal' | 'list';
  scenario: string;
  env: string;
  durationS: number | null;
  apiUrl: string;
  /** The compose service that serves the API (`api` is blue, `api-green` is green). */
  apiService: string;
  project: string;
  envFile: string;
  file: string;
  report: string;
}

/** Parses argv; throws a usage message. */
export function parseArgs(argv: readonly string[]): Args {
  const a: Args = {
    command: 'run',
    scenario: '',
    env: '',
    durationS: null,
    apiUrl: 'http://localhost:18080',
    apiService: 'api',
    project: 'centcom-bgdrill',
    envFile: '/tmp/centcom-bgdrill/production.env',
    file: join(ROOT, 'infra/deploy/docker-compose.prod.yml'),
    report: 'chaos-report.json',
  };
  const rest = [...argv];
  if (rest[0] === 'heal' || rest[0] === 'list') a.command = rest.shift() as 'heal' | 'list';
  while (rest.length > 0) {
    const flag = rest.shift() ?? '';
    const value = (): string => {
      const v = rest.shift();
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--scenario':
        a.scenario = value();
        break;
      case '--env':
        a.env = value();
        break;
      case '--duration-s': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 0 || n > 600)
          throw new Error('--duration-s is a whole number of seconds, 0 to 600');
        a.durationS = n;
        break;
      }
      case '--api-service': {
        const v = value();
        if (!/^[a-z][a-z0-9-]*$/.test(v))
          throw new Error('--api-service is a compose service name');
        a.apiService = v;
        break;
      }
      case '--api-url':
        a.apiUrl = value();
        break;
      case '--project':
        a.project = value();
        break;
      case '--env-file':
        a.envFile = value();
        break;
      case '--file':
        a.file = value();
        break;
      case '--report':
        a.report = value();
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }
  if (a.command === 'run' && a.scenario === '') throw new Error('--scenario <id|all> is required');
  if (a.command !== 'list' && a.env === '') throw new Error('--env local is required');
  return a;
}

/** The scenarios `id` names ("all" is every one), with `--duration-s` applied. */
export function select(
  all: Scenario[],
  id: string,
  durationS: number | null,
  apiService = 'api',
): Scenario[] {
  const chosen = id === 'all' ? all : all.filter((s) => s.id === id);
  if (chosen.length === 0)
    throw new ScenarioError(`no scenario "${id}" (have: ${all.map((s) => s.id).join(', ')})`);
  return chosen.map((s) => ({
    ...s,
    inject: s.inject.map((f) => ({
      ...f,
      service: f.service === '${API_SERVICE}' ? apiService : f.service,
      duration_s: durationS ?? f.duration_s,
    })),
  }));
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.command !== 'list') assertAllowedEnv(args.env, args.apiUrl);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return err instanceof EnvRefused || err instanceof Error ? 2 : 2;
  }
  const target: ComposeTarget = {
    file: args.file,
    envFile: args.envFile,
    project: args.project,
    profiles: ['bluegreen'],
  };
  try {
    const all = loadScenarios();
    if (args.command === 'list') {
      for (const s of all) process.stdout.write(`${s.id}\t${s.hypothesis}\n`);
      return 0;
    }
    if (args.command === 'heal') {
      const healed = healAll(target);
      process.stdout.write(
        healed.length === 0 ? 'nothing to heal\n' : `healed: ${healed.join(', ')}\n`,
      );
      return 0;
    }
    const injector = composeInjector(target);
    const prober = composeProber(target, args.apiUrl);
    const reports: ScenarioReport[] = [];
    const onSignal = (): void => {
      healAll(target);
      process.exit(130);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    for (const scenario of select(all, args.scenario, args.durationS, args.apiService)) {
      process.stdout.write(`${scenario.id}: ${scenario.hypothesis}\n`);
      const report = await runScenario(scenario, injector, prober, realClock);
      reports.push(report);
      process.stdout.write(
        `  ${report.passed ? 'PASSED' : 'FAILED'}${report.violations.map((v) => `\n    - ${v}`).join('')}\n`,
      );
    }
    writeFileSync(resolve(process.cwd(), args.report), `${JSON.stringify(reports, null, 2)}\n`);
    return reports.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return err instanceof ScenarioError ? 2 : 1;
  }
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  void main().then((code) => process.exit(code));
}
