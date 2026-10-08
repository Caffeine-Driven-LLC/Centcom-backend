/**
 * Ping scheduling (B040, CT-WS-ENVELOPE "Heartbeat"), on a fake clock:
 *
 * - an idle welcomed connection gets its first `sys.ping` 18-22 s after the welcome (20 s ±10 %),
 *   then one every 20 s;
 * - the jitter spreads connections across the whole band and stays inside it at both ends;
 * - pings carry the server's monotonic time and are valid envelope frames written straight to the
 *   connection; nothing is pinged before its welcome or once it is closing;
 * - on a running relay, `sys.welcome` advertises the values the relay enforces (here 10 s and
 *   25 s) and the first ping follows them.
 */
import { randomInt } from 'node:crypto';
import { validateEnvelope } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { closeConnection } from '../../src/connection/close.js';
import { inbound, liveRelay, unitHeartbeat, type FakeConnection } from './helpers.js';

const pingTimes = (fake: FakeConnection, since: number): number[] =>
  fake.events.flatMap((e) =>
    e.kind === 'send' && e.frame['t'] === 'sys.ping' ? [e.at - since] : [],
  );

describe('pings', () => {
  it('first comes 18-22 s after the welcome, then one every 20 s', async () => {
    const { heartbeat, timers, welcome } = unitHeartbeat();
    const fake = await welcome();
    const welcomedAt = timers.clock.now();
    for (let i = 0; i < 300; i += 1) {
      timers.clock.advance(1_000);
      // The client answers each ping.
      if (fake.sent().at(-1)?.['t'] === 'sys.ping') {
        await inbound(heartbeat, fake, { v: 1, t: 'sys.pong', p: { t: 0 } });
      }
    }
    const times = pingTimes(fake, welcomedAt);
    expect(times[0]).toBeGreaterThanOrEqual(18_000);
    expect(times[0]).toBeLessThanOrEqual(22_000);
    expect(times.length).toBe(15);
    const gaps = times.slice(1).map((t, i) => t - (times[i] ?? 0));
    // Due times are exactly 20 s apart; a tick runs at most one slot (100 ms) after its due time.
    for (const gap of gaps) expect(Math.abs(gap - 20_000)).toBeLessThanOrEqual(100);
  });

  it.each([
    [0, 18_000],
    [0.999_999, 22_000],
  ])('with random() = %d the first ping is at the edge of the band (%i ms)', async (r, edge) => {
    const { timers, welcome } = unitHeartbeat({ random: () => r });
    const fake = await welcome();
    const welcomedAt = timers.clock.now();
    timers.clock.advance(23_000);
    const [first] = pingTimes(fake, welcomedAt);
    expect(first).toBeGreaterThanOrEqual(18_000);
    expect(first).toBeLessThanOrEqual(22_000);
    expect(Math.abs((first ?? 0) - edge)).toBeLessThanOrEqual(150);
  });

  it('spreads 1 000 connections welcomed together across the band (CSPRNG jitter)', async () => {
    const { heartbeat, timers, welcome } = unitHeartbeat({
      random: () => randomInt(0, 2 ** 32) / 2 ** 32,
    });
    const welcomedAt = timers.clock.now();
    const fakes: FakeConnection[] = [];
    for (let i = 0; i < 1_000; i += 1) fakes.push(await welcome());
    timers.clock.advance(22_000);
    const firsts = fakes.map((f) => pingTimes(f, welcomedAt)[0] ?? Number.NaN);
    expect(Math.min(...firsts)).toBeGreaterThanOrEqual(18_000);
    expect(Math.max(...firsts)).toBeLessThanOrEqual(22_000);
    expect(Math.min(...firsts)).toBeLessThan(18_500);
    expect(Math.max(...firsts)).toBeGreaterThan(21_400);
    // Not synchronised: no 100 ms slot holds more than a tenth of them.
    const perSlot = new Map<number, number>();
    for (const t of firsts)
      perSlot.set(Math.floor(t / 100), (perSlot.get(Math.floor(t / 100)) ?? 0) + 1);
    expect(Math.max(...perSlot.values())).toBeLessThan(100);
    expect(heartbeat.wheel.timers).toBe(1);
  });

  it('carry the server monotonic time and are envelope frames', async () => {
    const { timers, welcome } = unitHeartbeat({ monotonic: () => 424_242 });
    const fake = await welcome();
    timers.clock.advance(22_000);
    const ping = fake.sent().find((f) => f['t'] === 'sys.ping');
    expect(ping).toEqual({ v: 1, t: 'sys.ping', p: { t: 424_242 } });
    expect(validateEnvelope(ping).ok).toBe(true);
  });

  it('are not sent before the welcome, nor once the connection is closing', async () => {
    const { heartbeat, timers, registry, welcome } = unitHeartbeat();
    const { fakeConnection } = await import('./helpers.js');
    const waiting = fakeConnection(registry, timers.clock.now);
    heartbeat.onConnection(waiting.connection);
    const closing = await welcome();
    closeConnection(closing.connection, { code: 1000 });
    timers.clock.advance(60_000);
    expect(waiting.sent()).toEqual([]);
    expect(closing.sent().filter((f) => f['t'] === 'sys.ping')).toEqual([]);
    expect(heartbeat.machine(closing.connection)?.state).toBe('draining');
  });
});

describe('on a running relay', () => {
  it('advertises the enforced heartbeat in sys.welcome, and pings by it', async () => {
    const live = await liveRelay({ pingMs: 10_000, deadMs: 25_000 });
    try {
      const client = await live.client();
      expect(client.welcome?.heartbeat).toEqual({ ping_ms: 10_000, dead_ms: 25_000 });
      const pings = () => client.wire.filter((f) => f.t === 'sys.ping').length;
      let elapsed = 0;
      while (pings() === 0 && elapsed < 12_000) {
        await live.advance(100, 100);
        elapsed += 100;
      }
      expect(elapsed).toBeGreaterThanOrEqual(9_000);
      expect(elapsed).toBeLessThanOrEqual(11_100);
      // The client answered with the same t.
      const ping = client.wire.find((f) => f.t === 'sys.ping');
      expect(client.sent.find((f) => f.t === 'sys.pong')?.p).toEqual({ t: ping?.p?.['t'] });
    } finally {
      await live.stop();
    }
  });
});
