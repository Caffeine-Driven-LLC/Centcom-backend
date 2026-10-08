/**
 * Dead-peer detection and pongs (B040, CT-WS-ENVELOPE "Heartbeat"):
 *
 * - a silent connection is closed at 50 s (±1 s) with `sys.bye`/reason `dead_peer` and 1000,
 *   counted in `relay_dead_peers_total` and, by the relay, in `relay_close_total{code}`;
 * - a client that answers every ping stays for 10 minutes, even when it answers slowly;
 * - a client `sys.ping` gets a `sys.pong` echoing `p.t` at once (well under 50 ms over a real
 *   socket) and resets the dead timer, as do other inbound frames and a pong with the wrong `t`;
 * - pings and pongs are consumed, never passed on to later stages;
 * - after an event-loop stall over 5 s, dead checks wait one slot, so frames already received
 *   are read before anyone is judged silent.
 */
import { performance } from 'node:perf_hooks';
import { validateEnvelope } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { createHeartbeat, DEAD_PEERS_METRIC } from '../../src/connection/heartbeat.js';
import { ConnectionRegistry } from '../../src/connection-registry.js';
import { RELAY_METRICS } from '../../src/metrics.js';
import { recordingMetrics } from '../helpers.js';
import {
  DEFAULTS,
  fakeConnection,
  ignorePings,
  inbound,
  liveRelay,
  unitHeartbeat,
  until,
  type FakeConnection,
} from './helpers.js';

const closeOf = (fake: FakeConnection) => fake.events.find((e) => e.kind === 'close');

describe('a silent connection', () => {
  it('is closed at 50 s with sys.bye dead_peer and 1000, and counted', async () => {
    const recorded = recordingMetrics();
    const { heartbeat, timers, welcome } = unitHeartbeat({ metrics: recorded.metrics });
    const fake = await welcome();
    const welcomedAt = timers.clock.now();
    timers.clock.advance(49_000);
    expect(closeOf(fake)).toBeUndefined();
    timers.clock.advance(1_500);
    const close = closeOf(fake);
    expect(close).toMatchObject({ code: 1000, reason: 'dead_peer' });
    expect((close?.at ?? 0) - welcomedAt).toBeGreaterThanOrEqual(50_000);
    expect((close?.at ?? 0) - welcomedAt).toBeLessThanOrEqual(51_000);
    const kinds = fake.events.filter((e) => e.kind !== 'send' || e.frame['t'] !== 'sys.ping');
    expect(kinds.map((e) => (e.kind === 'send' ? e.frame : e.kind))).toEqual([
      { v: 1, t: 'sys.bye', p: { reason: 'dead_peer' } },
      'close',
    ]);
    expect(recorded.count(DEAD_PEERS_METRIC)).toBe(1);
    expect(heartbeat.machine(fake.connection)?.state).toBe('draining');
    // The peer never answers the close: it is cut 1 s later, and nothing is left of it.
    timers.clock.advance(1_000);
    expect(fake.events.at(-1)?.kind).toBe('terminate');
    expect(heartbeat.size).toBe(0);
    expect(heartbeat.wheel.size).toBe(0);
    expect(timers.armed()).toBe(0);
  });

  it('is measured from its last activity, by server time only', async () => {
    const { heartbeat, timers, welcome } = unitHeartbeat();
    const fake = await welcome();
    const welcomedAt = timers.clock.now();
    timers.clock.advance(30_000);
    // A pong whose t is nonsense still proves the peer alive; its t is never used for timing.
    expect(await inbound(heartbeat, fake, { v: 1, t: 'sys.pong', p: { t: 9e15 } })).toBe(false);
    timers.clock.advance(49_000);
    expect(closeOf(fake)).toBeUndefined();
    timers.clock.advance(2_000);
    expect((closeOf(fake)?.at ?? 0) - welcomedAt).toBeGreaterThanOrEqual(80_000);
    expect((closeOf(fake)?.at ?? 0) - welcomedAt).toBeLessThanOrEqual(81_000);
  });
});

describe('a client that answers', () => {
  it('stays connected for 10 minutes of fake time', async () => {
    const { heartbeat, timers, welcome } = unitHeartbeat();
    const fake = await welcome();
    let answered = 0;
    for (let s = 0; s < 600; s += 1) {
      timers.clock.advance(1_000);
      const last = fake.sent().at(-1);
      if (last?.['t'] === 'sys.ping' && fake.sent().length > answered) {
        answered = fake.sent().length;
        await inbound(heartbeat, fake, { v: 1, t: 'sys.pong', p: last['p'] as object });
      }
    }
    expect(closeOf(fake)).toBeUndefined();
    expect(fake.sent().filter((f) => f['t'] === 'sys.ping').length).toBe(30);
    expect(heartbeat.machine(fake.connection)?.state).toBe('active');
  });

  it('stays even when each pong comes 25 s after its ping', async () => {
    const { heartbeat, timers, welcome } = unitHeartbeat();
    const fake = await welcome();
    const due: number[] = [];
    let seen = 0;
    for (let s = 0; s < 300; s += 1) {
      timers.clock.advance(1_000);
      const pings = fake.sent().filter((f) => f['t'] === 'sys.ping');
      if (pings.length > seen) {
        seen = pings.length;
        due.push(timers.clock.now() + 25_000);
      }
      while ((due[0] ?? Number.POSITIVE_INFINITY) <= timers.clock.now()) {
        due.shift();
        await inbound(heartbeat, fake, { v: 1, t: 'sys.pong', p: { t: 1 } });
      }
    }
    expect(closeOf(fake)).toBeUndefined();
  });

  it('is closed when its only pong arrives after 50 s of silence', async () => {
    const { heartbeat, timers, welcome } = unitHeartbeat();
    const fake = await welcome();
    timers.clock.advance(51_000);
    expect(closeOf(fake)).toMatchObject({ code: 1000 });
    await inbound(heartbeat, fake, { v: 1, t: 'sys.pong', p: { t: 1 } });
    expect(fake.events.filter((e) => e.kind === 'close')).toHaveLength(1);
  });
});

describe('client pings and other frames', () => {
  it('answers sys.ping at once with a sys.pong echoing p.t, consumes it, and resets the dead timer', async () => {
    const { heartbeat, timers, welcome } = unitHeartbeat();
    const fake = await welcome();
    const welcomedAt = timers.clock.now();
    timers.clock.advance(40_000);
    const before = fake.sent().length;
    expect(await inbound(heartbeat, fake, { v: 1, t: 'sys.ping', p: { t: 123_456 } })).toBe(false);
    const pong = fake.sent()[before];
    expect(pong).toEqual({ v: 1, t: 'sys.pong', p: { t: 123_456 } });
    expect(validateEnvelope(pong).ok).toBe(true);
    // A ping without a number t still gets a pong.
    await inbound(heartbeat, fake, { v: 1, t: 'sys.ping', p: {} });
    expect(fake.sent().at(-1)).toEqual({ v: 1, t: 'sys.pong', p: {} });
    timers.clock.advance(49_000);
    expect(closeOf(fake)).toBeUndefined();
    timers.clock.advance(2_000);
    expect((closeOf(fake)?.at ?? 0) - welcomedAt).toBeGreaterThanOrEqual(90_000);
  });

  it('passes other frames on, and counts them as activity', async () => {
    const { heartbeat, timers, welcome } = unitHeartbeat();
    const fake = await welcome();
    const welcomedAt = timers.clock.now();
    timers.clock.advance(30_000);
    expect(await inbound(heartbeat, fake, { v: 1, t: 'event', sid: 'x', k: 'message.user' })).toBe(
      true,
    );
    timers.clock.advance(49_000);
    expect(closeOf(fake)).toBeUndefined();
    timers.clock.advance(2_000);
    expect((closeOf(fake)?.at ?? 0) - welcomedAt).toBeGreaterThanOrEqual(80_000);
  });

  it('counts any inbound message as activity, even one the codec refuses later', async () => {
    const { heartbeat, timers, welcome } = unitHeartbeat();
    const fake = await welcome();
    timers.clock.advance(45_000);
    await heartbeat.activityStage({ connection: fake.connection, raw: 'not json', state: {} }, () =>
      Promise.resolve(),
    );
    timers.clock.advance(10_000);
    expect(closeOf(fake)).toBeUndefined();
  });
});

describe('an event-loop stall', () => {
  /** A heartbeat whose one platform timer the test fires, at any time it likes. */
  async function stallRig() {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    let armed: { fn: () => void; due: number } | undefined;
    const heartbeat = createHeartbeat({
      config: DEFAULTS,
      clock: () => now,
      random: () => 0.5,
      setTimer: (fn, ms) => {
        const timer = { fn, due: now + ms };
        armed = timer;
        return () => {
          if (armed === timer) armed = undefined;
        };
      },
      closeTimer: () => () => undefined,
    });
    const fake = fakeConnection(new ConnectionRegistry({ max: 10 }), () => now);
    heartbeat.onConnection(fake.connection);
    await heartbeat.stage({ connection: fake.connection, raw: '{}', state: {} }, () => {
      fake.connection.entry.state = 'authenticated';
      return Promise.resolve();
    });
    const welcomedAt = now;
    return {
      heartbeat,
      fake,
      welcomedAt,
      due: () => armed?.due ?? Number.POSITIVE_INFINITY,
      /** Fires the armed timer as if the event loop got to it at `at`. */
      fire(at: number) {
        const timer = armed;
        armed = undefined;
        now = at;
        timer?.fn();
      },
    };
  }

  it('holds the dead check one slot after a tick over 5 s late, so a frame read meanwhile counts', async () => {
    const rig = await stallRig();
    // The pings before the dead check (the peer stays silent).
    while (rig.due() < rig.welcomedAt + 50_000) rig.fire(rig.due());
    expect(rig.due()).toBe(rig.welcomedAt + 50_000);
    // The loop stalls: the tick due at 50 s runs at 56 s.
    rig.fire(rig.welcomedAt + 56_000);
    expect(closeOf(rig.fake)).toBeUndefined();
    // A frame that waited in the socket during the stall is read before the next tick.
    await inbound(rig.heartbeat, rig.fake, { v: 1, t: 'sys.pong', p: {} });
    rig.fire(rig.due());
    expect(closeOf(rig.fake)).toBeUndefined();
    expect(rig.heartbeat.machine(rig.fake.connection)?.state).toBe('active');
  });

  it('closes at the next on-time tick when nothing arrived', async () => {
    const rig = await stallRig();
    while (rig.due() < rig.welcomedAt + 50_000) rig.fire(rig.due());
    rig.fire(rig.welcomedAt + 56_000);
    expect(closeOf(rig.fake)).toBeUndefined();
    rig.fire(rig.due());
    expect(closeOf(rig.fake)).toMatchObject({ code: 1000, reason: 'dead_peer' });
  });

  it('does not hold checks for a tick less than 5 s late', async () => {
    const rig = await stallRig();
    while (rig.due() < rig.welcomedAt + 50_000) rig.fire(rig.due());
    rig.fire(rig.welcomedAt + 54_000);
    expect(closeOf(rig.fake)).toMatchObject({ code: 1000 });
  });
});

describe('on a running relay', () => {
  it('keeps a SimClient that answers pings for 10 minutes', async () => {
    const live = await liveRelay();
    try {
      const client = await live.client();
      await live.advance(600_000, 1_000);
      expect(client.isOpen).toBe(true);
      expect(client.wire.filter((f) => f.t === 'sys.ping').length).toBeGreaterThanOrEqual(29);
      expect(client.sent.filter((f) => f.t === 'sys.pong').length).toBeGreaterThanOrEqual(29);
    } finally {
      await live.stop();
    }
  }, 60_000);

  it('closes a SimClient that stops answering at 50 s with 1000 dead_peer, recorded by close code', async () => {
    const live = await liveRelay();
    try {
      const client = await live.client({ faults: [ignorePings] });
      const [entry] = live.relay.registry.entries();
      await live.advance(49_000, 1_000);
      expect(entry?.state).not.toBe('closing');
      let elapsed = 49_000;
      while (entry?.state !== 'closing' && elapsed < 52_000) {
        await live.advance(100, 100);
        elapsed += 100;
      }
      expect(elapsed).toBeGreaterThanOrEqual(50_000);
      expect(elapsed).toBeLessThanOrEqual(51_000);
      expect(await client.waitForClose()).toEqual({ code: 1000, reason: 'dead_peer' });
      expect(client.wire.at(-1)).toEqual({ v: 1, t: 'sys.bye', p: { reason: 'dead_peer' } });
      await until(() => live.relay.registry.size === 0, 3_000);
      expect(live.relay.recorded.count(RELAY_METRICS.closes, { code: '1000' })).toBe(1);
      expect(live.relay.recorded.count(DEAD_PEERS_METRIC)).toBe(1);
    } finally {
      await live.stop();
    }
  }, 60_000);

  it('answers a client sys.ping with a sys.pong echoing p.t within 50 ms', async () => {
    const live = await liveRelay();
    try {
      const client = await live.client();
      const rtts: number[] = [];
      for (let i = 1; i <= 10; i += 1) {
        const started = performance.now();
        client.sendRaw(JSON.stringify({ v: 1, t: 'sys.ping', p: { t: i } }));
        const pong = await client.waitForNext((f) => f.t === 'sys.pong' && f.p?.['t'] === i);
        rtts.push(performance.now() - started);
        expect(pong).toEqual({ v: 1, t: 'sys.pong', p: { t: i } });
      }
      rtts.sort((a, b) => a - b);
      expect(rtts[5]).toBeLessThan(50);
    } finally {
      await live.stop();
    }
  });
});
