/**
 * Fan-out cost (B044; acceptance 6, with `fanout.bench.ts`'s workload): delivering one frame to a
 * 50-connection room (in-memory sockets) takes under 5 ms at p95, and throughput is at least
 * 5 000 deliveries a second on one core. In-process and allocation-light, so it holds on shared
 * CI runners too.
 */
import { describe, expect, it } from 'vitest';
import { runFanoutBench } from './fanout.bench.js';

describe('fan-out cost (acceptance 6)', () => {
  it('fans one frame out to 50 connections under 5 ms p95, over 5 000 deliveries/s', async () => {
    const result = await runFanoutBench({ members: 50, frames: 2_000 });
    expect(result.p95Ms, JSON.stringify(result)).toBeLessThan(5);
    expect(result.deliveriesPerSecond, JSON.stringify(result)).toBeGreaterThan(5_000);
  });
});
