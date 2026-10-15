// @ts-check
/**
 * `pnpm infra:plan -- <env>` and `pnpm infra:apply -- <env> [plan-file]` (B091). Runs the local
 * `terraform` binary against envs/<env> with the remote state of that environment. Credentials come
 * from the environment (FLY_API_TOKEN, CLOUDFLARE_API_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY).
 *
 *   plan  <env>              writes envs/<env>/plan.tfplan (git-ignored) and prints the plan
 *   apply <env> [plan-file]  dev and stage: plans and applies after Terraform's own confirmation;
 *                            prod: refused unless CI=true and a saved plan file is given
 *
 * Production is never applied from a laptop; a human approves the saved plan in CI.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const ENVS = ['dev', 'stage', 'prod'];

/**
 * What a command line may do. Pure, so envs.test.ts can check the refusals.
 * @param {string[]} argv arguments after the script name
 * @param {Record<string, string | undefined>} env process environment
 * @returns {{ ok: true; action: 'plan' | 'apply'; env: string; planFile?: string } | { ok: false; error: string }}
 */
export function decide(argv, env) {
  const [action, name, planFile] = argv;
  if (action !== 'plan' && action !== 'apply') {
    return { ok: false, error: 'usage: run.mjs plan <env> | apply <env> [plan-file]' };
  }
  if (name === undefined || !ENVS.includes(name)) {
    return { ok: false, error: `the environment must be one of ${ENVS.join(', ')}` };
  }
  if (action === 'apply' && name === 'prod') {
    if (env.CI !== 'true') {
      return { ok: false, error: 'prod is applied from CI only (CI=true), never from a laptop' };
    }
    if (planFile === undefined) {
      return { ok: false, error: 'prod needs a saved plan file: apply <env> <plan-file>' };
    }
  }
  return { ok: true, action, env: name, ...(planFile === undefined ? {} : { planFile }) };
}

/** @param {string[]} args @param {string} dir @returns {number} */
function terraform(args, dir) {
  return spawnSync('terraform', args, { cwd: dir, stdio: 'inherit' }).status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = (/** @type {string} */ text) => process.stderr.write(`${text}\n`);
  const decision = decide(
    process.argv.slice(2).filter((a) => a !== '--'),
    process.env,
  );
  if (!decision.ok) {
    out(decision.error);
    process.exit(2);
  }
  const dir = join(ROOT, 'envs', decision.env);
  let status = terraform(['init', '-input=false', '-backend-config=backend.hcl'], dir);
  if (status === 0 && decision.action === 'plan') {
    status = terraform(['plan', '-input=false', '-out=plan.tfplan'], dir);
  } else if (status === 0) {
    // terraform runs inside envs/<env>, so the plan path is made absolute against the caller's cwd.
    const planPath = decision.planFile === undefined ? undefined : resolve(decision.planFile);
    if (planPath !== undefined && !existsSync(planPath)) {
      out(`no such plan file: ${decision.planFile}`);
      process.exit(2);
    }
    status = terraform(
      planPath === undefined ? ['apply'] : ['apply', '-input=false', planPath],
      dir,
    );
  }
  process.exit(status);
}
