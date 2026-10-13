/**
 * Relay restart under load (B096): B095's `storm` profile starts the real relay with synthetic
 * clients, SIGKILLs it, starts it again, and checks that nearly every client is welcome again
 * within 60 s and that no member is left behind or waiting on a seq gap. This runs it small (100
 * connections) and requires exit 0; `CHAOS_RELAY_CONNECTIONS=1000` runs the full size. Needs Docker.
 */
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, z } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { CHAOS_ON, record } from './harness.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const HAS_DOCKER = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const connections = defineConfig(
  z.object({ CHAOS_RELAY_CONNECTIONS: z.string().default('100') }),
).CHAOS_RELAY_CONNECTIONS;

describe.runIf(CHAOS_ON && HAS_DOCKER)('relay killed and restarted under load', () => {
  it('resumes the clients within 60 s with no seq gap (B095 storm profile)', () => {
    const run = spawnSync(
      'pnpm',
      [
        'exec',
        'tsx',
        '--tsconfig',
        'tsconfig.test.json',
        'infra/loadtest/relay-load.ts',
        '--profile',
        'storm',
        '--connections',
        connections,
        '--hold',
        '5',
        '--out',
        join(tmpdir(), `chaos-storm-${process.pid}.json`),
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 600_000 },
    );
    expect(run.status, `${run.stdout}\n${run.stderr}`.slice(-3000)).toBe(0);
    record({
      scenario: 'relay-kill-restart',
      passed: true,
      steady_state_before: { connections: Number(connections) },
      during: { fault: 'SIGKILL of the relay process, started again' },
      after: { thresholds: 'all passed (see the load runner report)' },
      violations: [],
    });
  }, 660_000);
});
