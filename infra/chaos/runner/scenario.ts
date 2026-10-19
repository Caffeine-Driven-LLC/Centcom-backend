/**
 * Chaos scenarios (B096): the types, the loader (YAML, checked against `scenario.schema.json`) and
 * the rule that decides where a run may happen.
 *
 * Owns: reading scenarios and refusing environments. Must not: touch Docker or the network.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export const CHAOS_DIR = join(import.meta.dirname, '..');

export interface Check {
  name: string;
  /** `${API_URL}/path`: an HTTP GET. */
  http?: string;
  /** Statuses that satisfy an `http` check. */
  status?: number[];
  /** A response header that must be present (for example `retry-after`). */
  header?: string;
  /** A compose service whose running state is checked. */
  service_running?: string;
  running?: boolean;
  /** The check may take this long to become true (polled every 500 ms); default 0. */
  within_s?: number;
}

export interface Fault {
  fault: 'stop' | 'kill' | 'pause' | 'restart';
  service: string;
  duration_s: number;
}

export interface Scenario {
  id: string;
  hypothesis: string;
  target: 'compose';
  steady_state: Check[];
  inject: Fault[];
  during?: Check[];
  abort_if?: Check[];
  expect: Check[];
}

/** Why a scenario file is unusable. */
export class ScenarioError extends Error {
  override name = 'ScenarioError';
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const FAULTS = ['stop', 'kill', 'pause', 'restart'];

function checkProblems(c: unknown, where: string): string[] {
  if (!isObject(c)) return [`${where} must be an object`];
  const out: string[] = [];
  const allowed = ['name', 'http', 'status', 'header', 'service_running', 'running', 'within_s'];
  for (const k of Object.keys(c))
    if (!allowed.includes(k)) out.push(`${where}: unknown field ${k}`);
  if (typeof c['name'] !== 'string' || c['name'].length < 3)
    out.push(`${where}: name must be a string of 3 or more characters`);
  const isHttp = c['http'] !== undefined;
  const isService = c['service_running'] !== undefined;
  if (isHttp === isService)
    out.push(`${where}: give either http (with status) or service_running (with running)`);
  if (isHttp) {
    if (typeof c['http'] !== 'string' || !c['http'].startsWith('${API_URL}/'))
      out.push(`${where}: http must start with \${API_URL}/`);
    if (
      !Array.isArray(c['status']) ||
      c['status'].length === 0 ||
      !c['status'].every((n) => Number.isInteger(n))
    ) {
      out.push(`${where}: status must be a list of integers`);
    }
  }
  if (
    isService &&
    (typeof c['service_running'] !== 'string' || typeof c['running'] !== 'boolean')
  ) {
    out.push(`${where}: service_running needs a service name and running: true|false`);
  }
  const w = c['within_s'];
  if (w !== undefined && (!Number.isInteger(w) || (w as number) < 0 || (w as number) > 600))
    out.push(`${where}: within_s is 0 to 600`);
  return out;
}

/** Every way `data` is not a scenario (the rules of scenario.schema.json); empty when it is one. */
export function scenarioProblems(data: unknown): string[] {
  if (!isObject(data)) return ['a scenario must be an object'];
  const out: string[] = [];
  const allowed = [
    'id',
    'hypothesis',
    'target',
    'steady_state',
    'inject',
    'during',
    'abort_if',
    'expect',
  ];
  for (const k of Object.keys(data)) if (!allowed.includes(k)) out.push(`unknown field ${k}`);
  if (typeof data['id'] !== 'string' || !/^[a-z][a-z0-9-]{2,40}$/.test(data['id']))
    out.push('id must be 3 to 41 characters of a-z, 0-9 and -');
  if (typeof data['hypothesis'] !== 'string' || data['hypothesis'].length < 10)
    out.push('hypothesis must be a sentence');
  if (data['target'] !== 'compose') out.push('target must be compose');
  for (const key of ['steady_state', 'inject', 'expect'] as const) {
    if (!Array.isArray(data[key]) || data[key].length === 0)
      out.push(`${key} must be a non-empty list`);
  }
  for (const key of ['during', 'abort_if'] as const) {
    if (data[key] !== undefined && !Array.isArray(data[key])) out.push(`${key} must be a list`);
  }
  for (const key of ['steady_state', 'during', 'abort_if', 'expect'] as const) {
    const list = data[key];
    if (Array.isArray(list)) list.forEach((c, i) => out.push(...checkProblems(c, `${key}[${i}]`)));
  }
  if (Array.isArray(data['inject'])) {
    data['inject'].forEach((f: unknown, i) => {
      if (!isObject(f)) return void out.push(`inject[${i}] must be an object`);
      if (!FAULTS.includes(f['fault'] as string))
        out.push(`inject[${i}]: fault is one of ${FAULTS.join(', ')}`);
      if (
        typeof f['service'] !== 'string' ||
        !/^(\$\{API_SERVICE\}|[a-z][a-z0-9-]*)$/.test(f['service'])
      )
        out.push(`inject[${i}]: service must be a compose service name`);
      const d = f['duration_s'];
      if (!Number.isInteger(d) || (d as number) < 0 || (d as number) > 600)
        out.push(`inject[${i}]: duration_s is 0 to 600`);
      for (const k of Object.keys(f))
        if (!['fault', 'service', 'duration_s'].includes(k))
          out.push(`inject[${i}]: unknown field ${k}`);
    });
  }
  return out;
}

/** Parses and validates one scenario's YAML text. */
export function parseScenario(text: string, source = 'scenario'): Scenario {
  let data: unknown;
  try {
    data = parse(text);
  } catch (err) {
    throw new ScenarioError(`${source}: not YAML (${(err as Error).message})`);
  }
  const problems = scenarioProblems(data);
  if (problems.length > 0) throw new ScenarioError(`${source}: ${problems.join('; ')}`);
  return data as Scenario;
}

/** Every scenario in `dir` (default `infra/chaos/scenarios`), sorted by id; ids must be unique. */
export function loadScenarios(dir: string = join(CHAOS_DIR, 'scenarios')): Scenario[] {
  const all = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => {
      const s = parseScenario(readFileSync(join(dir, f), 'utf8'), f);
      if (f !== `${s.id}.yaml`)
        throw new ScenarioError(`${f}: the file name must be <id>.yaml (id is ${s.id})`);
      return s;
    });
  const seen = new Set<string>();
  for (const s of all) {
    if (seen.has(s.id)) throw new ScenarioError(`duplicate scenario id ${s.id}`);
    seen.add(s.id);
  }
  return all;
}

/** Hosts a local run may probe. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class EnvRefused extends Error {
  override name = 'EnvRefused';
}

/**
 * Throws EnvRefused unless `env` is `local` and `apiUrl` is a loopback address. Production is never
 * allowed, whatever the flags say; `stage` needs the owner's Fly CLI, which this runner does not have.
 */
export function assertAllowedEnv(env: string, apiUrl: string): void {
  if (env === 'prod' || env === 'production') {
    throw new EnvRefused('chaos never runs against production (--env prod is refused)');
  }
  if (env === 'stage') {
    throw new EnvRefused(
      '--env stage needs the owner-run Fly extension, which is not built; use --env local',
    );
  }
  if (env !== 'local') throw new EnvRefused(`unknown --env ${env} (local)`);
  let host: string;
  try {
    host = new URL(apiUrl).hostname;
  } catch {
    throw new EnvRefused(`--api-url is not a URL: ${apiUrl}`);
  }
  if (!LOCAL_HOSTS.has(host) && !LOCAL_HOSTS.has(`[${host}]`)) {
    throw new EnvRefused(`--env local only probes loopback addresses, not ${host}`);
  }
}
