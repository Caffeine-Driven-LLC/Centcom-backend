/**
 * Vitest global setup (B010) for projects whose tests use `startTestStack`. It runs once per test
 * run, before any worker starts, and drops throwaway databases older than an hour that crashed
 * runs left on the DATABASE_URL server. Containers need no such step: testcontainers' reaper
 * removes them when the process that started them ends. Wire it with
 * `globalSetup: ['vitest.setup.ts']` in the project's test options (vitest.workspace.ts does so
 * for this package).
 */
import { reapStaleTestDatabases } from './src/containers.js';

export default async function setup(): Promise<void> {
  try {
    await reapStaleTestDatabases();
  } catch (err) {
    // Housekeeping only: an unreachable server shows up in the tests that need it.
    process.stderr.write(
      `testkit: could not reap stale test databases: ${(err as Error).message}\n`,
    );
  }
}
