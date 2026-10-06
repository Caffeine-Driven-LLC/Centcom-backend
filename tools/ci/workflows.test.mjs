// @ts-check
/**
 * B002 workflow guardrails: third-party actions pinned to full commit SHAs, read-only default
 * permissions, no `pull_request_target`, the required check jobs present, and nothing allowed
 * to fail silently.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const workflowDir = join(root, '.github', 'workflows');
const workflows = Object.fromEntries(
  readdirSync(workflowDir)
    .filter((f) => f.endsWith('.yml'))
    .map((f) => [f, readFileSync(join(workflowDir, f), 'utf8')]),
);
/** @type {Record<string, string>} */
const actionFiles = {
  ...workflows,
  'actions/setup/action.yml': readFileSync(join(root, '.github/actions/setup/action.yml'), 'utf8'),
};

/** Job ids declared directly under `jobs:` (two-space indent). @param {string} yml */
const jobIds = (yml) =>
  [...(yml.split(/^jobs:\s*$/m)[1] ?? '').matchAll(/^ {2}([\w-]+):\s*$/gm)].map((m) => m[1]);

describe('workflow guardrails', () => {
  it('has the ci, security and pr-title workflows', () => {
    expect(Object.keys(workflows).sort()).toEqual(['ci.yml', 'pr-title.yml', 'security.yml']);
  });

  it.each(Object.keys(actionFiles))('%s pins every third-party action to a full SHA', (file) => {
    const uses = [...(actionFiles[file] ?? '').matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map(
      (m) => m[1] ?? '',
    );
    for (const ref of uses.filter((u) => !u.startsWith('./'))) {
      expect(ref, `${file}: ${ref}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });

  it.each(Object.keys(workflows))('%s defaults to contents: read', (file) => {
    expect(workflows[file]).toMatch(/^permissions:\n {2}contents: read\n/m);
  });

  it.each(Object.keys(workflows))(
    '%s never uses pull_request_target or continue-on-error',
    (file) => {
      expect(workflows[file]).not.toMatch(/pull_request_target/);
      expect(workflows[file]).not.toMatch(/continue-on-error/);
    },
  );

  it('declares the jobs behind the required status checks', () => {
    expect(jobIds(workflows['ci.yml'] ?? '')).toEqual(
      expect.arrayContaining([
        'typecheck',
        'lint',
        'test',
        'build',
        'contract-lock',
        'integration',
      ]),
    );
    expect(jobIds(workflows['security.yml'] ?? '')).toEqual(['audit', 'secrets', 'codeql']);
    expect(jobIds(workflows['pr-title.yml'] ?? '')).toEqual(['pr-title']);
  });

  it('the contract-lock job runs lock.py and is never conditional', () => {
    const ci = workflows['ci.yml'] ?? '';
    const job = ci.split(/^ {2}contract-lock:\s*$/m)[1] ?? '';
    expect(job).toContain('python3 tools/plan/lock.py --check');
    expect(job.split(/^ {4}steps:/m)[0]).not.toMatch(/^ {4}if:/m);
  });

  it('the secret scan covers only history reachable from HEAD, not every fetched branch', () => {
    // Regression (B002 dry run): a fake key on one scratch branch failed every other PR's scan.
    expect(workflows['security.yml']).toMatch(/gitleaks" git --log-opts="HEAD" /);
  });

  it('the PR title reaches the script through an env var, not inline interpolation', () => {
    const prTitle = workflows['pr-title.yml'] ?? '';
    expect(prTitle).toMatch(/TITLE: \$\{\{ github\.event\.pull_request\.title \}\}/);
    expect(prTitle).not.toMatch(/run:.*\$\{\{ github\.event\.pull_request\.title/);
  });
});
