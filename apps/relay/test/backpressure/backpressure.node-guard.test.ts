/**
 * The node guard (B046; tests "backpressure.node-guard.test.ts", acceptance 8, failure mode "many
 * connections hit the cap at once"): when every connection's buffered bytes together pass
 * RELAY_NODE_BUFFER_MAX, the largest buffers are closed first (4429) until the rest is under 90 %
 * of it, with the closes spread over 0-500 ms; while the total is over the max the node is not
 * ready: `/readyz` reports `checks.buffers.ok = false` and new connections are refused (4503).
 */
import { newId } from '@centcom/contracts';
import { createManualClock, SimClient, SimCloseError } from '@centcom/testkit/sim';
import { describe, expect, it } from 'vitest';
import { createBackpressure } from '../../src/backpressure/controller.js';
import type { RelayModule } from '../../src/modules.js';
import { connect, testRelay } from '../helpers.js';
import { mintTicket, signingKey } from '../handshake/helpers.js';
import { controllerUnit, MiB } from './helpers.js';

describe('the node guard (acceptance 8)', () => {
  it('closes the largest buffers first until under 90 %, spread over 0-500 ms', () => {
    const u = controllerUnit({ nodeMaxBytes: 100 * MiB });
    const sizes = [40, 5, 30, 25, 10, 2].map((n) => n * MiB);
    const conns = sizes.map((size) => {
      const conn = u.connect();
      conn.buffered = size;
      return conn;
    });
    u.controller.sweep();
    expect(u.controller.total()).toBe(112 * MiB);
    expect(u.controller.overloaded()).toBe(true);
    // 112 → close 40 (72 ≤ 90): one close, the largest.
    const closes = u.timers.pending.filter((t) => t.live && t.ms === 250);
    expect(closes).toHaveLength(1);
    for (const t of closes) t.fn();
    expect(conns.map((c) => c.closedWith)).toEqual([4429, null, null, null, null, null]);
    expect(u.recorded.count('relay_backpressure_closed_total', { reason: 'node' })).toBe(1);
    u.controller.sweep();
    expect(u.controller.overloaded()).toBe(false);
  });

  it('closes several when one is not enough, never the same one twice', () => {
    const u = controllerUnit({ nodeMaxBytes: 100 * MiB });
    const conns = [30, 30, 30, 30].map((n) => {
      const conn = u.connect();
      conn.buffered = n * MiB;
      return conn;
    });
    u.controller.sweep();
    u.controller.sweep();
    // 120 → 90 after one close; the target is ≤ 90: one close, scheduled once.
    expect(u.timers.pending.filter((t) => t.live && t.ms === 250)).toHaveLength(1);
    const second = conns[1];
    if (second === undefined) throw new Error('no connection');
    second.buffered = 60 * MiB;
    u.controller.sweep();
    // 150 → 120 (the closing one counted) → 60: one more.
    expect(u.timers.pending.filter((t) => t.live && t.ms === 250)).toHaveLength(2);
  });
});

/** Polls `check` until it holds (2 s at most). */
async function eventually(check: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 2_000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('readiness (acceptance 8)', () => {
  it('/readyz reports buffers not ok and new connections are refused while over the max', async () => {
    let fake = 0;
    const module: RelayModule = {
      name: 'backpressure',
      order: 55,
      register(ctx) {
        const controller = createBackpressure({
          config: { hardBytes: 2 * MiB, softBytes: MiB, graceMs: 5_000, nodeMaxBytes: MiB },
        });
        ctx.onConnection((conn) => {
          // A socket whose buffer the test sets.
          conn.bufferedBytes = () => fake;
          controller.attach(conn);
        });
        ctx.addReadinessCheck('buffers', () => !controller.overloaded());
        ctx.onShutdown(() => Promise.resolve(controller.stop()));
        return undefined;
      },
    };
    const relay = await testRelay({ modules: [module] });
    try {
      const ready = async () =>
        (await (await fetch(`${relay.base}/readyz`)).json()) as {
          status: string;
          checks: Record<string, { ok: boolean }>;
        };
      expect((await ready()).checks['buffers']).toEqual({ ok: true });
      const open = connect(relay.url);
      await open.opened;
      fake = 2 * MiB;
      await eventually(async () => (await ready()).checks['buffers']?.ok === false);
      expect((await ready()).status).toBe('degraded');
      const refused = await SimClient.connect({
        url: relay.url,
        ticket: await mintTicket(signingKey(), {
          sid: newId('ses'),
          mid: newId('mem'),
          role: 'editor',
          dev: newId('dev'),
          caps: [],
        }),
        clock: createManualClock(),
      }).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(SimCloseError);
      expect((refused as SimCloseError).code).toBe(4503);
      fake = 0;
      await eventually(async () => (await ready()).checks['buffers']?.ok === true);
      open.ws.close();
    } finally {
      await relay.stop();
    }
  }, 20_000);
});
