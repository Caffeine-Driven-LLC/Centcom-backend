/**
 * Runs vitest on a set of test paths and returns what happened per file (B100). One vitest process
 * (low parallelism: the suites share Postgres and Redis), JSON reporter, no coverage.
 *
 * Owns: spawning vitest and reading its JSON. Must not: interpret results (that is the caller's job).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');

export interface AssertionResult {
  fullName: string;
  status: string;
  duration: number | null;
  failureMessages: string[];
}

export interface FileResult {
  /** Relative to the repository root. */
  file: string;
  status: string;
  assertions: AssertionResult[];
  message: string;
}

/**
 * `pnpm conformance` itself runs as `tsx --tsconfig tsconfig.test.json`, and tsx exports that choice to its
 * children as TSX_TSCONFIG_PATH=tsconfig.test.json, a path relative to the repository root. A test that
 * starts its own `node --import tsx` in another folder (cache-bench.ts, in packages/core) then looks for
 * that file there, does not find it and crashes inside tsx. The vitest child gets the environment without
 * tsx's own variables; its tests and workers load their own configuration.
 */
export function withoutTsxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('TSX_')));
}

/** Runs `paths`; resolves with one entry per test file vitest ran. Throws if vitest produced no report. */
export function runVitest(
  paths: readonly string[],
  options: { timeoutMs?: number } = {},
): FileResult[] {
  const dir = mkdtempSync(join(tmpdir(), 'conformance-'));
  const out = join(dir, 'result.json');
  try {
    spawnSync(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--config',
        'vitest.workspace.ts',
        ...paths,
        '--reporter=json',
        `--outputFile=${out}`,
        '--coverage.enabled=false',
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: options.timeoutMs ?? 40 * 60_000,
        maxBuffer: 1 << 28,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: withoutTsxEnv(process.env),
      },
    );
    let json: {
      testResults?: {
        name: string;
        status: string;
        message?: string;
        assertionResults?: AssertionResult[];
      }[];
    };
    try {
      json = JSON.parse(readFileSync(out, 'utf8')) as typeof json;
    } catch {
      throw new Error('vitest wrote no report');
    }
    return (json.testResults ?? []).map((t) => ({
      file: relative(ROOT, t.name),
      status: t.status,
      message: t.message ?? '',
      assertions: t.assertionResults ?? [],
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
