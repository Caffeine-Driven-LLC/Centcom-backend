// Single ESLint flat config for the whole repo (B001). Workspaces must not add
// their own config or switch these rules off; change them here, in review.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/coverage/',
    'contracts/',
    'plan/',
    'site/',
    'tools/plan/',
    // Files that must fail lint; tools/repo/lint-fixtures.test.ts lints them on purpose.
    'tools/lint-fixtures/',
  ]),
  js.configs.recommended,
  tseslint.configs.strict,
  {
    files: ['**/*.{ts,mts,cts,js,mjs,cjs}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@centcom/*/*'],
              message:
                'Import a workspace package by its name only; its package.json "exports" map is the public surface.',
            },
            {
              group: ['**/apps/*/**', '**/packages/*/**'],
              message: 'Do not reach into another workspace by path; depend on it by package name.',
            },
          ],
        },
      ],
    },
  },
  {
    // Node globals for scripts and config files that run directly under Node.
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
  {
    // Console output is allowed only in process entrypoints and repo tooling, never in library code.
    files: ['apps/*/src/main.ts', 'tools/**/*.{ts,mjs}'],
    rules: { 'no-console': 'off' },
  },
]);
