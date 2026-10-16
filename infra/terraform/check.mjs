// @ts-check
/**
 * `pnpm infra:check` (B091): terraform fmt, terraform validate for each environment root, tflint,
 * and a policy scan (checkov), each in a throwaway container. Needs Docker and the public
 * registries (provider schemas, container images); no Fly or Cloudflare account, no token.
 *
 *   node infra/terraform/check.mjs [--fix]     --fix runs `terraform fmt` instead of checking
 *
 * Exits 1 with the failing step named. The plan-JSON policy tests (envs.test.ts) run with
 * `pnpm test`; they need no Docker because they read committed plans.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TERRAFORM_IMAGE = 'hashicorp/terraform:1.10.5';
export const TFLINT_IMAGE = 'ghcr.io/terraform-linters/tflint:v0.54.0';
export const CHECKOV_IMAGE = 'bridgecrew/checkov:3.2.344';
export const ENVS = ['dev', 'stage', 'prod'];

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const out = (/** @type {string} */ text) => process.stdout.write(`${text}\n`);

/**
 * Runs a shell script in a container with infra/terraform mounted read-only at /m.
 * @param {string} image
 * @param {string} script
 * @param {string[]} [extra] extra docker arguments
 * @returns {boolean}
 */
function inContainer(image, script, extra = []) {
  const result = spawnSync(
    'docker',
    ['run', '--rm', '--entrypoint', 'sh', ...extra, '-v', `${ROOT}:/m:ro`, image, '-c', script],
    { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  return result.status === 0;
}

const copy = 'cp -r /m /tmp/w && cd /tmp/w';

/** @type {{ name: string; run: (fix: boolean) => boolean }[]} */
const STEPS = [
  {
    name: 'terraform fmt',
    run: (fix) =>
      fix
        ? inContainer(
            TERRAFORM_IMAGE,
            `${copy} && terraform fmt -recursive && cp -r /tmp/w/. /m/`,
            ['--user', '0'],
          )
        : inContainer(TERRAFORM_IMAGE, `${copy} && terraform fmt -check -recursive -diff`),
  },
  ...ENVS.map((env) => ({
    name: `terraform validate envs/${env}`,
    run: () =>
      inContainer(
        TERRAFORM_IMAGE,
        `${copy}/envs/${env} && terraform init -backend=false -input=false >/dev/null && terraform validate`,
      ),
  })),
  {
    name: 'tflint',
    run: () =>
      inContainer(
        TFLINT_IMAGE,
        `${copy} && for d in modules/* envs/*; do (cd $d && tflint --config=/tmp/w/.tflint.hcl) || exit 1; done`,
      ),
  },
  {
    name: 'checkov',
    run: () =>
      inContainer(
        CHECKOV_IMAGE,
        `checkov -d /m --framework terraform --quiet --compact --config-file /m/.checkov.yaml`,
      ),
  },
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fix = process.argv.includes('--fix');
  for (const step of STEPS) {
    out(`\n== ${step.name}`);
    if (!step.run(fix)) {
      out(`\nFAILED: ${step.name}`);
      process.exit(1);
    }
  }
  out('\ninfra:check passed');
}
