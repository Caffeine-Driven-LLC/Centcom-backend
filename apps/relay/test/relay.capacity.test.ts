/**
 * Capacity (B037, card test relay.capacity.test.ts, acceptance 3): with RELAY_MAX_CONNECTIONS=2
 * the third connection is accepted, gets a `sys.error` (503 with `retry_after_s`) and is closed
 * 4503 within 1 s; the same while a dependency is down. The registry: the cap, every close path
 * removing its entry, and no remote address kept. A handler that throws closes its connection
 * (1011) and nothing else.
 */
import { validate } from '@centcom/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CloseCode,
  ConnectionRegistry,
  OVERLOAD_RETRY_AFTER_S,
  RELAY_METRICS,
  STAGE_ORDER,
  type RelayModule,
} from '../src/index.js';
import { connect, stubProbe, testRelay, until, type TestRelay } from './helpers.js';

let relay: TestRelay | undefined;
afterEach(async () => {
  await relay?.stop();
  relay = undefined;
});

describe('the connection cap (acceptance 3)', () => {
  it('accepts the third connection, sends sys.error 503 with retry_after_s, closes it 4503 within 1 s', async () => {
    relay = await testRelay({ config: { maxConnections: 2 } });
    const first = connect(relay.url);
    const second = connect(relay.url);
    await Promise.all([first.opened, second.opened]);
    const started = Date.now();
    const third = connect(relay.url);
    await third.opened;
    const closed = await third.closed;
    expect(closed.code).toBe(CloseCode.Overloaded);
    expect(closed.at - started).toBeLessThan(1_000);
    expect(third.messages).toHaveLength(1);
    const error = third.messages[0] as { t: string; p: Record<string, unknown> };
    expect(error).toMatchObject({
      v: 1,
      t: 'sys.error',
      p: { status: 503, code: 'service_unavailable', retry_after_s: OVERLOAD_RETRY_AFTER_S },
    });
    expect(validate('envelope', error).ok).toBe(true);
    expect(relay.registry.size).toBe(2);
    await until(() => relay?.recorded.count(RELAY_METRICS.closes, { code: '4503' }) === 1);
    // The first two are untouched; once one leaves, a new one fits.
    expect(first.ws.readyState).toBe(first.ws.OPEN);
    first.ws.close(1000);
    await first.closed;
    await until(() => relay?.registry.size === 1);
    const fourth = connect(relay.url);
    await fourth.opened;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fourth.ws.readyState).toBe(fourth.ws.OPEN);
    expect(relay.registry.size).toBe(2);
  });

  it('refuses connections with 4503 while a dependency is down, and takes them once it is back', async () => {
    const probe = stubProbe({ redis: { ok: false } });
    relay = await testRelay({ probe });
    const refused = connect(relay.url);
    expect((await refused.closed).code).toBe(CloseCode.Overloaded);
    expect(refused.messages[0]).toMatchObject({ t: 'sys.error', p: { status: 503 } });
    probe.checks = { redis: { ok: true } };
    await relay.readiness.refresh();
    const accepted = connect(relay.url);
    await accepted.opened;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(accepted.ws.readyState).toBe(accepted.ws.OPEN);
  });
});

describe('the registry', () => {
  it('holds at most max entries and removes on every close path', async () => {
    relay = await testRelay();
    const clients = Array.from({ length: 4 }, () => connect(relay?.url ?? ''));
    await Promise.all(clients.map((c) => c.opened));
    await until(() => relay?.registry.size === 4);
    const [byClient, byTerminate, byServerClose, byServerTerminate] = clients;
    byClient?.ws.close(1000);
    byTerminate?.ws.terminate();
    const live = relay.server.connections();
    live[2]?.close(CloseCode.Normal);
    live[3]?.terminate();
    await Promise.all(clients.map((c) => c.closed));
    await until(() => relay?.registry.size === 0);
    expect(relay.server.connections()).toEqual([]);
    expect(byServerClose).toBeDefined();
    expect(byServerTerminate).toBeDefined();
  });

  it('keeps a keyed hash of the address, never the address', () => {
    const registry = new ConnectionRegistry({ max: 3, clock: () => 0 });
    const a = registry.add('203.0.113.7');
    const b = registry.add('203.0.113.7');
    const c = registry.add('198.51.100.1');
    expect(a.remoteHash).toBe(b.remoteHash);
    expect(a.remoteHash).not.toBe(c.remoteHash);
    expect(a.remoteHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(registry.entries())).not.toContain('203.0.113.7');
    expect(a).toMatchObject({ state: 'open', sessionId: null, createdAt: new Date(0) });
    expect(registry.full).toBe(true);
    expect(() => registry.add('192.0.2.1')).toThrow(RangeError);
    expect(new ConnectionRegistry({ max: 3 }).add('203.0.113.7').remoteHash).not.toBe(a.remoteHash);
    expect(registry.remove(a.id)).toBe(true);
    expect(registry.remove(a.id)).toBe(false);
    expect(() => new ConnectionRegistry({ max: 0 })).toThrow(TypeError);
  });

  it('resolves whenEmpty once the last entry goes', async () => {
    const registry = new ConnectionRegistry({ max: 2 });
    await registry.whenEmpty();
    const a = registry.add(undefined);
    const b = registry.add(undefined);
    let empty = false;
    const waiting = registry.whenEmpty().then(() => (empty = true));
    registry.remove(a.id);
    await Promise.resolve();
    expect(empty).toBe(false);
    registry.remove(b.id);
    await waiting;
    expect(empty).toBe(true);
  });
});

describe('a failing handler', () => {
  it('closes its connection 1011 with a generic sys.error, counts it, and serves the others', async () => {
    let calls = 0;
    const flaky: RelayModule = {
      name: 'flaky',
      order: 10,
      register(ctx) {
        ctx.onConnection(() => {
          calls++;
          if (calls === 1) throw new Error('secret internal detail');
        });
        ctx.pipeline.use(STAGE_ORDER.decode, (fc) => {
          if (fc.raw === 'boom') return Promise.reject(new Error('stage failed'));
          fc.connection.send({ v: 1, t: 'sys.pong', p: {} });
          return Promise.resolve();
        });
        return undefined;
      },
    };
    relay = await testRelay({ modules: [flaky] });
    const failing = connect(relay.url);
    const closed = await failing.closed;
    expect(closed.code).toBe(CloseCode.InternalError);
    expect(failing.messages[0]).toMatchObject({
      t: 'sys.error',
      p: { status: 500, code: 'internal_error' },
    });
    expect(JSON.stringify(failing.messages)).not.toContain('secret internal detail');

    const ok = connect(relay.url);
    await ok.opened;
    ok.ws.send('ping');
    await until(() => ok.messages.length === 1);
    expect(ok.messages[0]).toMatchObject({ t: 'sys.pong' });
    ok.ws.send('boom');
    expect((await ok.closed).code).toBe(CloseCode.InternalError);
    expect(relay.recorded.count(RELAY_METRICS.handlerErrors)).toBe(2);
    expect(relay.log.raw()).not.toContain('secret internal detail');
    // Still serving.
    const after = connect(relay.url);
    await after.opened;
    after.ws.close(1000);
    await after.closed;
  });
});
