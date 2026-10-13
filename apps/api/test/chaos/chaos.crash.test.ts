/**
 * Postgres crash and restart (B096): the database container is killed with SIGKILL while writers
 * are creating workspaces, stays down for a while, and is started again. The API must answer 503
 * (never a 200 for a write that did not happen) while it is down, resume within 120 s after the
 * restart, and every create it acknowledged (201) must be in the database afterwards: crash
 * recovery loses no committed write. Needs Docker; run by `pnpm chaos`.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, type TestStack } from '@centcom/testkit';
import { CHAOS_ON, OUTAGE_S, record, sleep, startNode, within, type Node } from './harness.js';

const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });
const HAS_DOCKER = CHAOS_ON && docker('version').status === 0;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe.runIf(HAS_DOCKER)('Postgres crash and restart under write load', () => {
  const name = `chaos-pg-${process.pid}`;
  let port = 0;
  let redisHolder: TestStack;
  let stack: TestStack;
  let node: Node;

  beforeAll(async () => {
    port = await freePort();
    const run = docker(
      'run',
      '-d',
      '--name',
      name,
      '-e',
      'POSTGRES_PASSWORD=chaos',
      '-p',
      `127.0.0.1:${port}:5432`,
      'postgres:16',
    );
    expect(run.status, run.stderr).toBe(0);
    const up = await within(
      60_000,
      async () => docker('exec', name, 'pg_isready', '-U', 'postgres').status === 0,
    );
    expect(up, 'postgres started').not.toBeNull();
    await sleep(1500); // pg_isready answers during the init restart
    await within(
      30_000,
      async () => docker('exec', name, 'pg_isready', '-U', 'postgres').status === 0,
    );
    redisHolder = await startTestStack();
    stack = await startTestStack({
      env: {
        DATABASE_URL: `postgres://postgres:chaos@127.0.0.1:${port}/postgres`,
        REDIS_URL: redisHolder.redisUrl,
      },
    });
    node = await startNode({ stack });
  }, 180_000);
  afterAll(async () => {
    await node?.stop();
    await stack?.stop().catch(() => undefined);
    await redisHolder?.stop();
    docker('rm', '-f', name);
  }, 60_000);

  it('answers 503 while down, resumes within 120 s, and loses no acknowledged write', async () => {
    let writing = true;
    const writers = Array.from({ length: 4 }, async () => {
      while (writing) {
        await node.createWorkspace();
        await sleep(50);
      }
    });
    await sleep(2000);
    const before = node.ledger.filter((e) => e.status === 201).length;
    expect(before).toBeGreaterThan(0);

    const killedAt = Date.now();
    expect(docker('kill', '--signal', 'KILL', name).status).toBe(0);
    await sleep(OUTAGE_S * 1000);
    const startedAt = Date.now();
    expect(docker('start', name).status).toBe(0);
    const resumed = await within(120_000, async () => {
      const res = await node.createWorkspace();
      return res.statusCode === 201;
    });
    await sleep(1500);
    writing = false;
    await Promise.all(writers);
    expect(resumed, 'writes resume within 120 s of the restart').not.toBeNull();

    const during = node.ledger.filter((e) => e.at >= killedAt + 500 && e.at < startedAt);
    // While the database was down: only 503s, none acknowledged as created.
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((e) => e.status === 503)).toBe(true);
    // Whatever the API acknowledged is in the database after crash recovery.
    const lost = await node.lost();
    expect(lost).toEqual([]);
    record({
      scenario: 'postgres-crash-restart',
      passed: true,
      steady_state_before: { acknowledged_writes: before },
      during: { answers: [...new Set(during.map((e) => e.status))], requests: during.length },
      after: {
        resumed_after_ms: resumed,
        acknowledged_total: node.ledger.filter((e) => e.status === 201).length,
      },
      violations: [],
    });
  }, 300_000);
});
