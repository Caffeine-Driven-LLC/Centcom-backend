/**
 * What the harness tests can run against. With DATABASE_URL and REDIS_URL (CI's integration job)
 * stacks use those servers; without them but with Docker (CI's test job) they use containers;
 * with neither (a laptop without Docker) the stack tests are skipped and only the pure ones run.
 */
import { join } from 'node:path';
import { defineConfig, z } from '@centcom/core';
import { testcontainersRuntime } from '../../src/index.js';

const env = defineConfig(
  z.object({ DATABASE_URL: z.string().optional(), REDIS_URL: z.string().optional() }),
);

/** Both URLs are set: stacks use those servers and no container starts. */
export const ENV_SERVERS = env.DATABASE_URL !== undefined && env.REDIS_URL !== undefined;
/** A container runtime answers, whether or not the URLs are set (CI's integration job has both). */
export const RUNTIME = await testcontainersRuntime.check().then(
  () => true,
  () => false,
);
/** No URLs, but a container runtime answers: stacks run on containers. */
export const CONTAINERS = !ENV_SERVERS && RUNTIME;
/** Stacks can start here. */
export const STACK = ENV_SERVERS || CONTAINERS;

/** The repository's contracts directory. */
export const CONTRACTS = join(import.meta.dirname, '..', '..', '..', '..', 'contracts');

/** Generous limits for tests that may start containers on a cold machine. */
export const CONTAINER_TEST_TIMEOUT_MS = 180_000;
