/**
 * Root Vitest config (B001). Vitest 3.2+ replaced the separate workspace file with
 * `test.projects`, so this file is a full root config and `pnpm test` passes it via
 * `--config`. One project per workspace plus `repo` for the repository checks in tools/repo.
 */
import { basename, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

const workspaces = [
  'apps/api',
  'apps/relay',
  'apps/worker',
  'apps/admin',
  'packages/contracts',
  'packages/core',
  'packages/db',
  'packages/testkit',
];

export default defineConfig({
  // A workspace imported by package name resolves to its source, as in tsconfig.test.json, so
  // tests need no build first (their package.json "exports" point at dist/).
  resolve: {
    alias: workspaces.map((dir) => ({
      find: new RegExp(`^@centcom/${basename(dir)}$`),
      replacement: resolve(root, dir, 'src/index.ts'),
    })),
  },
  test: {
    passWithNoTests: true,
    projects: [
      ...workspaces.map((dir) => ({
        extends: true as const,
        test: {
          name: dir,
          root: resolve(root, dir),
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
        },
      })),
      {
        extends: true as const,
        test: {
          name: 'repo',
          root,
          include: ['tools/repo/**/*.test.ts', 'tools/ci/**/*.test.mjs'],
        },
      },
    ],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', 'packages/contracts/src/generated/**'],
      // Hard floor from GUIDELINES §4.1 (lanes target 90 %).
      thresholds: { lines: 80 },
    },
  },
});
