/**
 * Graceful shutdown (B037, card test relay.shutdown.test.ts, acceptance 4 and 5): `/readyz` turns
 * 503 at once and new upgrades get 503; 200 connections each get `sys.bye` (`server_restart`)
 * and close 1001, spread over the 5 s window rather than at once, all within 5.5 s, and the
 * shutdown resolves 0; a connection still open at the drain deadline is cut and
 * `shutdown.forced` logged with the count, still 0. A second call or signal changes nothing.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  CloseCode,
  createShutdown,
  onShutdownSignals,
  SHUTDOWN_JITTER_MS,
  SHUTDOWN_REASON,
} from '../src/index.js';
import { connect, testRelay, until, upgradeStatus, type Client } from './helpers.js';

const shutdownOf = (
  relay: Awaited<ReturnType<typeof testRelay>>,
  overrides: Partial<Parameters<typeof createShutdown>[0]> = {},
) =>
  createShutdown({
    server: relay.server,
    registry: relay.registry,
    drainMs: 25_000,
    steps: relay.shutdownSteps,
    logger: relay.log.logger,
    ...overrides,
  });

async function clients(url: string, n: number): Promise<Client[]> {
  const list = Array.from({ length: n }, () => connect(url));
  await Promise.all(list.map((c) => c.opened));
  return list;
}

describe('graceful shutdown (acceptance 4)', () => {
  it('drains 200 connections with sys.bye and 1001 spread over 5 s, then resolves 0', async () => {
    const relay = await testRelay();
    const open = await clients(relay.url, 200);
    await until(() => relay.registry.size === 200);
    const started = Date.now();
    const done = shutdownOf(relay)();

    // Readiness and upgrades flip at once.
    const ready = await fetch(`${relay.base}/readyz`);
    expect(ready.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(100);
    expect(await upgradeStatus(relay.url)).toBe(503);

    const closes = await Promise.all(open.map((c) => c.closed));
    expect(await done).toBe(0);
    const offsets = closes.map((c) => c.at - started).sort((a, b) => a - b);
    for (const close of closes) expect(close.code).toBe(CloseCode.GoingAway);
    for (const client of open) {
      expect(client.messages).toEqual([{ v: 1, t: 'sys.bye', p: { reason: SHUTDOWN_REASON } }]);
    }
    // Spread, not synchronised: across most of the window, the last within 5.5 s.
    expect(offsets.at(-1) ?? Infinity).toBeLessThan(5_500);
    expect((offsets.at(-1) ?? 0) - (offsets[0] ?? 0)).toBeGreaterThan(SHUTDOWN_JITTER_MS / 2);
    const firstSecond = offsets.filter((ms) => ms < 1_000).length;
    expect(firstSecond).toBeLessThan(100);
    expect(relay.registry.size).toBe(0);
    expect(relay.server.http.listening).toBe(false);
    expect(relay.log.lines().map((l) => l['msg'])).toEqual(
      expect.arrayContaining(['shutdown.started', 'shutdown.complete']),
    );
    expect(relay.log.lines().some((l) => l['msg'] === 'shutdown.forced')).toBe(false);
  }, 20_000);
});

describe('forced stop (acceptance 5)', () => {
  it('cuts connections still open at the drain deadline, logs shutdown.forced with the count, resolves 0', async () => {
    const relay = await testRelay();
    const open = await clients(relay.url, 5);
    await until(() => relay.registry.size === 5);
    const started = Date.now();
    // Every bye would come near the end of the window, long after the 300 ms deadline.
    const code = await shutdownOf(relay, { drainMs: 300, random: () => 0.99 })();
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_500);
    for (const c of open) expect((await c.closed).code).toBe(1006);
    expect(relay.log.lines().find((l) => l['msg'] === 'shutdown.forced')).toMatchObject({
      count: 5,
    });
    await until(() => relay.registry.size === 0);
  });

  it('runs the shutdown steps after the connections, once, and survives a failing one', async () => {
    const relay = await testRelay();
    const order: string[] = [];
    relay.shutdownSteps.push(
      () => {
        order.push(`step:${relay.registry.size}`);
        return Promise.reject(new Error('step failed'));
      },
      () => {
        order.push('second');
        return Promise.resolve();
      },
    );
    const client = connect(relay.url);
    await client.opened;
    const shutdown = shutdownOf(relay, { jitterMs: 50 });
    const [a, b] = await Promise.all([shutdown(), shutdown()]);
    expect([a, b]).toEqual([0, 0]);
    expect(order).toEqual(['step:0', 'second']);
    expect(relay.log.lines().some((l) => l['msg'] === 'shutdown.step_failed')).toBe(true);
    expect((await client.closed).code).toBe(CloseCode.GoingAway);
  });
});

describe('signals', () => {
  it('calls the handler on SIGTERM and SIGINT', () => {
    const source = new EventEmitter();
    const seen: string[] = [];
    onShutdownSignals(source, (signal) => seen.push(signal));
    source.emit('SIGTERM');
    source.emit('SIGINT');
    expect(seen).toEqual(['SIGTERM', 'SIGINT']);
  });
});
