// @ts-check
/**
 * Regenerates tests/fixtures/plan-<env>.json: the offline `terraform plan` of each environment root,
 * trimmed to the planned resources and outputs (B091). Needs Docker (hashicorp/terraform) and the
 * Terraform registry for the provider schemas; no Fly or Cloudflare account, no token: the tokens
 * are placeholders and new resources need no API call. The S3 backend block is removed from a copy
 * so that `plan` can run without a state bucket. Also writes tests/fixtures/inputs.sha256, the hash
 * of every Terraform file and tfvars the fixtures were generated from; envs.test.ts compares it to
 * catch a stale fixture.
 *
 *   node infra/terraform/tests/gen-plan.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures');
const IMAGE = 'hashicorp/terraform:1.10.5';
const ENVS = ['dev', 'stage', 'prod'];
const out = (/** @type {string} */ text) => process.stdout.write(`${text}\n`);

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'tests' || name === '.terraform' || name === 'waf') return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Hash of the module and root files the plans depend on. @returns {string} */
export function inputsHash() {
  const files = walk(ROOT)
    .filter((f) => /\.(tf|json|hcl)$/.test(f))
    .map((f) => relative(ROOT, f).replaceAll('\\', '/'))
    .sort();
  const hash = createHash('sha256');
  for (const f of files) {
    hash.update(f);
    hash.update(readFileSync(join(ROOT, f), 'utf8').replaceAll('\r\n', '\n'));
  }
  return hash.digest('hex');
}

/** @param {string} env @returns {any} */
function planOf(env) {
  const script = [
    'cp -r /m /tmp/w && cd /tmp/w/envs/' + env,
    'sed -i \'/backend "s3"/,/^  }$/d\' versions.tf',
    'terraform init -backend=false -input=false >/dev/null 2>&1',
    'terraform plan -refresh=false -lock=false -input=false -out=/tmp/plan >/dev/null',
    'terraform show -json /tmp/plan',
  ].join(' && ');
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      '-e',
      'FLY_API_TOKEN=placeholder',
      '-e',
      'CLOUDFLARE_API_TOKEN=0000000000000000000000000000000000000000',
      '-v',
      `${ROOT}:/m:ro`,
      IMAGE,
      '-c',
      script,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    },
  );
  if (result.status !== 0)
    throw new Error(`plan of ${env} failed:\n${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

/**
 * @param {any} node a planned_values module
 * @returns {{ address: string; type: string; name: string; values: any }[]}
 */
function flatten(node) {
  return [
    ...(node.resources ?? []).map((/** @type {any} */ r) => ({
      address: r.address,
      type: r.type,
      name: r.name,
      values: r.values,
    })),
    ...(node.child_modules ?? []).flatMap(flatten),
  ].sort((a, b) => a.address.localeCompare(b.address));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(FIXTURES, { recursive: true });
  for (const env of ENVS) {
    const plan = planOf(env);
    const outputs = Object.fromEntries(
      Object.entries(plan.output_changes).map(([k, v]) => [k, /** @type {any} */ (v).after]),
    );
    const fixture = { env, resources: flatten(plan.planned_values.root_module), outputs };
    writeFileSync(join(FIXTURES, `plan-${env}.json`), `${JSON.stringify(fixture, null, 1)}\n`);
    out(`${env}: ${fixture.resources.length} resources`);
  }
  writeFileSync(join(FIXTURES, 'inputs.sha256'), `${inputsHash()}\n`);
  out('fixtures written');
}
