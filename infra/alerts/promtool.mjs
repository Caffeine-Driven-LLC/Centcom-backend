// @ts-check
/**
 * `pnpm alerts:test` (B094): `promtool check rules` over every rule file the alerts load (B093's SLO
 * rules, the 30m windows, infra/alerts/rules/*.rules.yaml) and `promtool test rules` over every
 * infra/alerts/rules/*.test.yaml, with `promtool` from the PATH or, failing that, Docker
 * (`prom/prometheus`, the image the container tests use). CI runs the same checks through
 * infra/alerts/test/alerts.containers.test.ts.
 *
 * Usage: node infra/alerts/promtool.mjs   Exits 0 when every check passes, 1 when one fails, 2
 * when neither promtool nor Docker is available.
 *
 * Owns: running promtool. Must not: change a file.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The repository root. */
export const REPO = fileURLToPath(new URL('../../', import.meta.url));
/** The Prometheus image for promtool; the same as @centcom/testkit's PROMETHEUS_IMAGE. */
export const PROMETHEUS_IMAGE = 'prom/prometheus:v2.54.1';

/**
 * The rule files, relative to the root, in load order.
 * @param {string} [root]
 * @returns {string[]}
 */
export function ruleFiles(root = REPO) {
  const list = (/** @type {string} */ dir, /** @type {RegExp} */ pattern) =>
    readdirSync(`${root}/${dir}`)
      .filter((f) => pattern.test(f))
      .sort()
      .map((f) => `${dir}/${f}`);
  return [
    'infra/observability/slo/rules.yaml',
    ...list('infra/alerts/recording', /\.yaml$/),
    ...list('infra/alerts/rules', /\.rules\.yaml$/),
  ];
}

/**
 * The promtool unit test files, relative to the root.
 * @param {string} [root]
 * @returns {string[]}
 */
export function testFiles(root = REPO) {
  return readdirSync(`${root}/infra/alerts/rules`)
    .filter((f) => f.endsWith('.test.yaml'))
    .sort()
    .map((f) => `infra/alerts/rules/${f}`);
}

/**
 * The promtool invocations, as argument lists.
 * @param {string} [root]
 * @returns {string[][]}
 */
export function promtoolRuns(root = REPO) {
  return [
    ['check', 'rules', ...ruleFiles(root)],
    ['test', 'rules', ...testFiles(root)],
  ];
}

/** @param {string} command @param {string[]} args */
const available = (command, args) => spawnSync(command, args, { stdio: 'ignore' }).status === 0;

/**
 * Runs the checks; returns the exit code.
 * @returns {number}
 */
export function main() {
  /** @type {(args: string[]) => number | null} */
  let run;
  if (available('promtool', ['--version'])) {
    run = (args) => spawnSync('promtool', args, { cwd: REPO, stdio: 'inherit' }).status;
  } else if (available('docker', ['version'])) {
    run = (args) =>
      spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${REPO}:/work:ro`,
          '-w',
          '/work',
          '--entrypoint',
          '/bin/promtool',
          PROMETHEUS_IMAGE,
          ...args,
        ],
        { stdio: 'inherit' },
      ).status;
  } else {
    process.stderr.write('alerts:test needs promtool on the PATH or Docker.\n');
    return 2;
  }
  let failed = false;
  for (const args of promtoolRuns()) {
    process.stdout.write(`promtool ${args.slice(0, 2).join(' ')} (${args.length - 2} files)\n`);
    if (run(args) !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
