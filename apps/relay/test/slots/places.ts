/**
 * The places the slot suites run (B031): in memory always, and on Postgres 16 when a test stack
 * can start. Each suite file gets its own database.
 */
import { afterAll, beforeAll } from 'vitest';
import {
  memoryEnv,
  postgresEnv,
  STACK,
  STACK_TIMEOUT_MS,
  startTestStack,
  type SlotEnv,
  type TestStack,
} from './helpers.js';

export interface Place {
  name: string;
  enabled: boolean;
  /** The place's environment; valid inside the suite's tests. */
  env(): SlotEnv;
  /** Registers the place's beforeAll/afterAll in the current describe. */
  hooks(): void;
}

export function places(): Place[] {
  let stack: TestStack | undefined;
  let pg: SlotEnv | undefined;
  return [
    { name: 'in memory', enabled: true, env: () => memoryEnv(), hooks: () => undefined },
    {
      name: 'on Postgres 16',
      enabled: STACK,
      env: () => {
        if (pg === undefined) throw new Error('the Postgres stack is not up');
        return pg;
      },
      hooks: () => {
        beforeAll(async () => {
          stack = await startTestStack();
          pg = postgresEnv(stack);
        }, STACK_TIMEOUT_MS);
        afterAll(async () => {
          await stack?.stop();
        });
      },
    },
  ];
}
