/**
 * The chaos runner (B096): scenarios load and validate, production and non-loopback targets are
 * refused, the engine runs steady state, fault, during, abort and expect in order and always heals,
 * and the probes read status and header. A fake injector, prober and clock stand in for Docker.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeProber } from './compose.js';
import { runScenario, type Clock, type Injector, type Prober } from './engine.js';
import { parseArgs, select } from './index.js';
import {
  assertAllowedEnv,
  CHAOS_DIR,
  EnvRefused,
  loadScenarios,
  parseScenario,
  scenarioProblems,
  ScenarioError,
  type Check,
  type Fault,
  type Scenario,
} from './scenario.js';

const scenario = (patch: Partial<Scenario> = {}): Scenario => ({
  id: 'demo-scenario',
  hypothesis: 'A demo hypothesis for the tests.',
  target: 'compose',
  steady_state: [{ name: 'up', http: '${API_URL}/readyz', status: [200] }],
  inject: [{ fault: 'pause', service: 'redis', duration_s: 5 }],
  expect: [{ name: 'up again', http: '${API_URL}/readyz', status: [200], within_s: 10 }],
  ...patch,
});

/** A clock that only moves when something sleeps. */
function fakeClock(): Clock & { t: number } {
  const c = {
    t: 0,
    now: () => c.t,
    sleep: (ms: number) => {
      c.t += ms;
      return Promise.resolve();
    },
  };
  return c;
}

/** A stack whose checks are answered by `holds(name, atMs)`; records what was applied and healed. */
function fakeStack(
  holds: (check: Check, ms: number, faults: Fault[]) => boolean,
  clock: { t: number },
) {
  const active: Fault[] = [];
  const log: string[] = [];
  const injector: Injector = {
    apply(f) {
      log.push(`apply ${f.fault} ${f.service}`);
      active.push(f);
      return Promise.resolve();
    },
    heal(f) {
      log.push(`heal ${f.fault} ${f.service}`);
      const i = active.findIndex((a) => a.service === f.service);
      if (i >= 0) active.splice(i, 1);
      return Promise.resolve();
    },
  };
  const prober: Prober = { holds: (check) => Promise.resolve(holds(check, clock.t, active)) };
  return { injector, prober, log, active };
}

describe('the shipped scenarios', () => {
  it('all load, validate and have a file named after their id', () => {
    const all = loadScenarios();
    expect(all.map((s) => s.id)).toEqual([
      'api-restart',
      'postgres-kill',
      'redis-outage',
      'relay-restart',
      'worker-kill',
    ]);
    for (const s of all) expect(s.hypothesis.length).toBeGreaterThan(30);
  });

  it('keep the validator and the published JSON schema in step on the required fields', () => {
    const schema = JSON.parse(readFileSync(join(CHAOS_DIR, 'scenario.schema.json'), 'utf8')) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required.sort()).toEqual([
      'expect',
      'hypothesis',
      'id',
      'inject',
      'steady_state',
      'target',
    ]);
    const problems = scenarioProblems({});
    for (const key of schema.required)
      expect(problems.join(' ')).toContain(key === 'id' ? 'id must' : key);
    expect(Object.keys(schema.properties).sort()).toEqual([
      'abort_if',
      'during',
      'expect',
      'hypothesis',
      'id',
      'inject',
      'steady_state',
      'target',
    ]);
  });

  it('are refused when malformed, with the reason', () => {
    const bad = (patch: object) => scenarioProblems({ ...scenario(), ...patch }).join(' | ');
    expect(bad({ id: 'X' })).toContain('id must');
    expect(bad({ target: 'prod' })).toContain('target must be compose');
    expect(bad({ inject: [{ fault: 'explode', service: 'redis', duration_s: 1 }] })).toContain(
      'fault is one of',
    );
    expect(bad({ inject: [{ fault: 'kill', service: 'rm -rf /', duration_s: 1 }] })).toContain(
      'compose service name',
    );
    expect(bad({ inject: [{ fault: 'kill', service: 'redis', duration_s: 9999 }] })).toContain(
      'duration_s',
    );
    expect(
      bad({ steady_state: [{ name: 'x1', http: 'http://evil.test/', status: [200] }] }),
    ).toContain('http must start with');
    expect(bad({ steady_state: [{ name: 'xyz', status: [200] }] })).toContain('either http');
    expect(bad({ surprise: 1 })).toContain('unknown field surprise');
    expect(() => parseScenario('id: [', 'broken.yaml')).toThrow(ScenarioError);
  });
});

describe('where a run may happen', () => {
  it('refuses production, stage, unknown environments and anything not on loopback', () => {
    expect(() => assertAllowedEnv('prod', 'http://localhost:1')).toThrow(EnvRefused);
    expect(() => assertAllowedEnv('production', 'http://localhost:1')).toThrow(
      /never runs against production/,
    );
    expect(() => assertAllowedEnv('stage', 'http://localhost:1')).toThrow(/not built/);
    expect(() => assertAllowedEnv('moon', 'http://localhost:1')).toThrow(/unknown --env/);
    expect(() => assertAllowedEnv('local', 'https://api.centcom.dev')).toThrow(/loopback/);
    expect(() => assertAllowedEnv('local', 'not a url')).toThrow(/not a URL/);
    expect(() => assertAllowedEnv('local', 'http://localhost:18080')).not.toThrow();
    expect(() => assertAllowedEnv('local', 'http://127.0.0.1:3000')).not.toThrow();
  });

  it('is refused by the command line before anything runs (exit 2 is main()’s answer to a throw)', () => {
    expect(() => parseArgs(['--scenario', 'all'])).toThrow(/--env local is required/);
    expect(() => parseArgs(['--env', 'local'])).toThrow(/--scenario/);
    expect(() =>
      parseArgs(['--scenario', 'all', '--env', 'local', '--duration-s', '9999']),
    ).toThrow(/duration/);
    expect(() => parseArgs(['--scenario', 'all', '--env', 'local', '--bogus'])).toThrow(
      /unknown argument/,
    );
    expect(
      parseArgs(['--scenario', 'redis-outage', '--env', 'local', '--duration-s', '3']),
    ).toMatchObject({ scenario: 'redis-outage', durationS: 3 });
    expect(parseArgs(['heal', '--env', 'local']).command).toBe('heal');
    expect(parseArgs(['list']).command).toBe('list');
  });

  it('selects one scenario or all, and applies --duration-s', () => {
    const all = loadScenarios();
    expect(select(all, 'all', null)).toHaveLength(5);
    expect(select(all, 'redis-outage', 4)[0]?.inject[0]?.duration_s).toBe(4);
    expect(() => select(all, 'nope', null)).toThrow(/no scenario/);
  });
});

describe('the engine', () => {
  it('passes a scenario whose checks hold, and heals the fault', async () => {
    const clock = fakeClock();
    const stack = fakeStack(() => true, clock);
    const report = await runScenario(scenario(), stack.injector, stack.prober, clock);
    expect(report).toMatchObject({ passed: true, violations: [] });
    expect(stack.log).toEqual(['apply pause redis', 'heal pause redis']);
    expect(clock.t).toBeGreaterThanOrEqual(5000); // the fault lasted its duration
  });

  it('injects nothing when the steady state does not hold', async () => {
    const clock = fakeClock();
    const stack = fakeStack(() => false, clock);
    const report = await runScenario(scenario(), stack.injector, stack.prober, clock);
    expect(report.passed).toBe(false);
    expect(report.violations[0]).toContain('nothing was injected');
    expect(stack.log).toEqual([]);
  });

  it('checks the during conditions while the fault is active and fails when one never holds', async () => {
    const clock = fakeClock();
    const during: Check = {
      name: 'readyz 503',
      http: '${API_URL}/readyz',
      status: [503],
      within_s: 3,
    };
    const holds = (c: Check, _ms: number, faults: Fault[]) =>
      c.name === 'readyz 503' ? false : faults.length === 0;
    const s1 = fakeStack(holds, clock);
    const failed = await runScenario(scenario({ during: [during] }), s1.injector, s1.prober, clock);
    expect(failed.passed).toBe(false);
    expect(failed.violations.join()).toContain('never held while the fault was active');
    expect(s1.log).toEqual(['apply pause redis', 'heal pause redis']);

    const clock2 = fakeClock();
    const s2 = fakeStack(
      (c, _ms, faults) => (c.name === 'readyz 503' ? faults.length > 0 : true),
      clock2,
    );
    const ok = await runScenario(scenario({ during: [during] }), s2.injector, s2.prober, clock2);
    expect(ok.passed).toBe(true);
    expect(ok.during['readyz 503']).toBe(0);
  });

  it('heals at once when an abort condition becomes true, and fails the scenario', async () => {
    const clock = fakeClock();
    const abort: Check = { name: 'API died', http: '${API_URL}/healthz', status: [500] };
    const stack = fakeStack(
      (c, ms, faults) => (c.name === 'API died' ? faults.length > 0 && ms >= 1000 : true),
      clock,
    );
    const report = await runScenario(
      scenario({
        abort_if: [abort],
        inject: [{ fault: 'kill', service: 'postgres', duration_s: 60 }],
      }),
      stack.injector,
      stack.prober,
      clock,
    );
    expect(report.passed).toBe(false);
    expect(report.violations.join()).toContain('abort condition "API died"');
    expect(clock.t).toBeLessThan(5000); // it did not wait out the 60 s
    expect(stack.log).toEqual(['apply kill postgres', 'heal kill postgres']);
  });

  it('fails when the expected recovery does not come within its time, and still healed', async () => {
    const clock = fakeClock();
    const stack = fakeStack((c) => c.name !== 'up again', clock);
    const report = await runScenario(scenario(), stack.injector, stack.prober, clock);
    expect(report.passed).toBe(false);
    expect(report.after['up again']).toBeNull();
    expect(report.violations.join()).toContain('"up again" did not hold within 10 s');
    expect(stack.active).toEqual([]);
  });

  it('turns an injector error into a violation and heals what was applied', async () => {
    const clock = fakeClock();
    const stack = fakeStack(() => true, clock);
    const broken: Injector = {
      apply: async (f) => {
        await stack.injector.apply(f);
        throw new Error('docker said no');
      },
      heal: stack.injector.heal,
    };
    const report = await runScenario(scenario(), broken, stack.prober, clock);
    expect(report.passed).toBe(false);
    expect(report.violations.join()).toContain('docker said no');
    expect(stack.log).toContain('heal pause redis');
  });
});

describe('the HTTP probe', () => {
  const target = { file: 'f', envFile: 'e', project: 'p' };
  const answer = (status: number, headers: Record<string, string> = {}): typeof fetch =>
    (() => Promise.resolve(new Response('x', { status, headers }))) as typeof fetch;

  it('matches the status and the required header, and reads ${API_URL}', async () => {
    let seen = '';
    const spy: typeof fetch = ((url: string) => {
      seen = url;
      return Promise.resolve(new Response('x', { status: 503, headers: { 'retry-after': '1' } }));
    }) as typeof fetch;
    const probe = composeProber(target, 'http://localhost:18080/', spy);
    expect(
      await probe.holds({
        name: 'abc',
        http: '${API_URL}/readyz',
        status: [503],
        header: 'retry-after',
      }),
    ).toBe(true);
    expect(seen).toBe('http://localhost:18080/readyz');
    expect(
      await composeProber(target, 'http://x', answer(200)).holds({
        name: 'abc',
        http: '${API_URL}/a',
        status: [503],
      }),
    ).toBe(false);
    expect(
      await composeProber(target, 'http://x', answer(503)).holds({
        name: 'abc',
        http: '${API_URL}/a',
        status: [503],
        header: 'retry-after',
      }),
    ).toBe(false);
  });

  it('treats no answer as status 0 only when the check allows it', async () => {
    const down: typeof fetch = (() => Promise.reject(new Error('refused'))) as typeof fetch;
    const probe = composeProber(target, 'http://x', down);
    expect(await probe.holds({ name: 'abc', http: '${API_URL}/a', status: [200] })).toBe(false);
    expect(await probe.holds({ name: 'abc', http: '${API_URL}/a', status: [0, 503] })).toBe(true);
  });
});
