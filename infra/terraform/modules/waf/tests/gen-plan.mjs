// @ts-check
/**
 * Regenerates tests/fixtures/plan-<mode>.json: the offline `terraform plan` of tests/plan for each
 * mode, trimmed to the planned rulesets (B097). Needs Docker (hashicorp/terraform:1.9); no
 * Cloudflare account or token. Also writes tests/fixtures/module.sha256, the hash of the module's
 * .tf files the fixtures were generated from, which waf.test.ts compares to catch a stale fixture.
 *
 *   node infra/terraform/modules/waf/tests/gen-plan.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Writes a line to stdout / stderr (the repo's lint forbids `console` outside tools/). */
const out = (/** @type {string} */ text) => process.stdout.write(`${text}\n`);

const MODULE = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(MODULE, 'tests', 'fixtures');

/** Hash of the module's Terraform files and the plan root. @returns {string} */
export function moduleHash() {
  const files = [
    ...readdirSync(MODULE)
      .filter((f) => f.endsWith('.tf'))
      .map((f) => join(MODULE, f)),
    join(MODULE, 'tests', 'plan', 'main.tf'),
  ].sort();
  const hash = createHash('sha256');
  for (const f of files) hash.update(readFileSync(f));
  return hash.digest('hex');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(FIXTURES, { recursive: true });
  for (const mode of ['block', 'log', 'off']) {
    const script = [
      'cp -r /m /tmp/w && cd /tmp/w/tests/plan',
      'terraform init -backend=false -input=false >/dev/null 2>&1',
      `terraform plan -input=false -var mode=${mode} -out=/tmp/p >/dev/null 2>&1`,
      'terraform show -json /tmp/p',
    ].join(' && ');
    const json = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        '-v',
        `${MODULE}:/m:ro`,
        'hashicorp/terraform:1.9',
        '-c',
        script,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    const plan = JSON.parse(json);
    const resources = plan.planned_values.root_module.child_modules[0].resources.map(
      (/** @type {any} */ r) => ({ address: r.address, type: r.type, values: r.values }),
    );
    writeFileSync(
      join(FIXTURES, `plan-${mode}.json`),
      `${JSON.stringify({ mode, resources }, null, 2)}\n`,
    );
    out(`wrote plan-${mode}.json`);
  }
  writeFileSync(join(FIXTURES, 'module.sha256'), `${moduleHash()}\n`);
}
