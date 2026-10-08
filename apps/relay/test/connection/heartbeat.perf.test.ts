/**
 * 10 000 idle connections on one timer (B040 acceptance 6): heartbeat.bench.ts runs in a child
 * process (no coverage instrumentation) and serves 10 000 connections that answer every ping for
 * 10 minutes of fake time. One platform timer is ever armed, every connection gets its 29-30 pings
 * and stays open, and the CPU spent scheduling them stays under 5 % of one core over that time.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('heartbeat scheduling for 10 000 connections', () => {
  it('uses one shared timer and under 5 % of one core', () => {
    const bench = resolve(import.meta.dirname, 'heartbeat.bench.ts');
    const tsx = createRequire(import.meta.url).resolve('tsx/cli');
    const tsconfig = resolve(import.meta.dirname, '../../../../tsconfig.test.json');
    const out = execFileSync(process.execPath, [tsx, '--tsconfig', tsconfig, bench], {
      input: JSON.stringify({ connections: 10_000, simulatedMs: 600_000 }),
      encoding: 'utf8',
    });
    const result = JSON.parse(out) as {
      cpuMs: number;
      simulatedMs: number;
      pings: number;
      maxArmed: number;
      open: number;
      connections: number;
    };
    expect(result.connections).toBe(10_000);
    expect(result.maxArmed).toBe(1);
    expect(result.open).toBe(10_000);
    expect(result.pings).toBeGreaterThanOrEqual(10_000 * 29);
    expect(result.pings).toBeLessThanOrEqual(10_000 * 30);
    expect(result.cpuMs / result.simulatedMs).toBeLessThan(0.05);
  }, 120_000);
});
