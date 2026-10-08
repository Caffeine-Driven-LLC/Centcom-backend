/**
 * Test helpers for heartbeat and liveness (B040):
 *
 * - `fakeConnection()`: a RelayConnection that records what it is sent and how it is closed, in
 *   order, and whose socket the test closes (`closeSocket`);
 * - `manualTimers()`: platform timers on B011's manual clock, counting how many are armed;
 * - `unitHeartbeat()`: the heartbeat on those, with `welcome(fake)` taking a connection through
 *   the hello as the handshake would;
 * - `liveRelay()`: a relay with the codec, this lane's module (on a manual clock) and the handshake
 *   (test keys, in-memory access, the configured heartbeat in `sys.welcome`), and `client()`
 *   opening a B011 SimClient on it.
 */
import { createManualClock, SimClient, type Fault, type ManualClock } from '@centcom/testkit/sim';
import codecModule from '../../src/codec/module.js';
import type { CloseTimer } from '../../src/connection/close.js';
import { welcomeHeartbeat, type HeartbeatConfig } from '../../src/connection/config.js';
import {
  createHeartbeat,
  type Heartbeat,
  type HeartbeatDeps,
} from '../../src/connection/heartbeat.js';
import type { PlatformTimer } from '../../src/connection/wheel.js';
import { ConnectionRegistry } from '../../src/connection-registry.js';
import { createHandshake } from '../../src/handshake/handshake.js';
import { JwksCache } from '../../src/handshake/jwks.js';
import type { RelayModule } from '../../src/modules.js';
import type { RelayConnection } from '../../src/pipeline.js';
import {
  memoryAccess,
  mintTicket,
  signingKey,
  stubJwks,
  TEST_HANDSHAKE_CONFIG,
  ticketFor,
} from '../handshake/helpers.js';
import { testRelay, until, type TestRelay } from '../helpers.js';

export { until };

/** CT-WS-ENVELOPE defaults. */
export const DEFAULTS: HeartbeatConfig = { pingMs: 20_000, deadMs: 50_000 };

/** What a fake connection saw, in order. */
export type ConnEvent =
  | { kind: 'send'; frame: Record<string, unknown>; at: number }
  | { kind: 'close'; code: number; reason: string; at: number }
  | { kind: 'terminate'; at: number };

/** A fake connection. */
export interface FakeConnection {
  connection: RelayConnection;
  events: ConnEvent[];
  /** The frames sent. */
  sent(): Record<string, unknown>[];
  /** The socket closes (the peer left, or the close finished): runs the onClose listeners once. */
  closeSocket(code?: number): void;
  /** Listeners waiting for the socket to close. */
  listeners(): number;
}

/** A fake connection registered in `registry`; events are timed by `clock` (default 0). */
export function fakeConnection(
  registry: ConnectionRegistry = new ConnectionRegistry({ max: 1_000_000 }),
  clock: () => number = () => 0,
): FakeConnection {
  const entry = registry.add('127.0.0.1');
  const events: ConnEvent[] = [];
  let listeners: ((code: number) => void)[] = [];
  let closed = false;
  const closeSocket = (code = 1000): void => {
    if (closed) return;
    closed = true;
    registry.remove(entry.id);
    const run = listeners;
    listeners = [];
    for (const listener of run) listener(code);
  };
  const connection: RelayConnection = {
    entry,
    send(frame) {
      if (closed) return false;
      events.push({ kind: 'send', frame: frame as Record<string, unknown>, at: clock() });
      return true;
    },
    close(code, reason) {
      entry.state = 'closing';
      events.push({ kind: 'close', code, reason: reason ?? '', at: clock() });
    },
    terminate() {
      events.push({ kind: 'terminate', at: clock() });
      closeSocket(1006);
    },
    onClose(listener) {
      if (closed) listener(1006);
      else listeners.push(listener);
    },
  };
  return {
    connection,
    events,
    sent: () => events.flatMap((e) => (e.kind === 'send' ? [e.frame] : [])),
    closeSocket,
    listeners: () => listeners.length,
  };
}

/** Platform timers on a manual clock; `armed` counts those waiting. */
export function manualTimers(clock: ManualClock = createManualClock()): {
  clock: ManualClock;
  setTimer: PlatformTimer & CloseTimer;
  armed(): number;
  maxArmed(): number;
} {
  let armed = 0;
  let max = 0;
  const setTimer = (fn: () => void, ms: number): (() => void) => {
    let live = true;
    armed += 1;
    max = Math.max(max, armed);
    const handle = clock.setTimeout(() => {
      if (!live) return;
      live = false;
      armed -= 1;
      fn();
    }, ms);
    return () => {
      if (!live) return;
      live = false;
      armed -= 1;
      clock.clearTimeout(handle);
    };
  };
  return { clock, setTimer, armed: () => armed, maxArmed: () => max };
}

/** A heartbeat on manual timers (the close fallback too). */
export function unitHeartbeat(overrides: Partial<HeartbeatDeps> = {}): {
  heartbeat: Heartbeat;
  timers: ReturnType<typeof manualTimers>;
  registry: ConnectionRegistry;
  /** A connection, accepted and welcomed as the handshake does it. */
  welcome(fake?: FakeConnection): Promise<FakeConnection>;
} {
  const timers = manualTimers();
  const registry = new ConnectionRegistry({ max: 1_000_000 });
  const heartbeat = createHeartbeat({
    config: DEFAULTS,
    clock: timers.clock.now,
    monotonic: timers.clock.now,
    random: () => 0.5,
    setTimer: timers.setTimer,
    closeTimer: timers.setTimer,
    ...overrides,
  });
  const welcome = async (
    fake: FakeConnection = fakeConnection(registry, timers.clock.now),
  ): Promise<FakeConnection> => {
    heartbeat.onConnection(fake.connection);
    await heartbeat.stage(
      { connection: fake.connection, raw: '{"v":1,"t":"sys.hello"}', state: {} },
      () => {
        fake.connection.entry.state = 'authenticated';
        return Promise.resolve();
      },
    );
    return fake;
  };
  return { heartbeat, timers, registry, welcome };
}

/** Delivers an inbound frame to `fake` through both heartbeat stages; resolves whether it passed on. */
export async function inbound(
  heartbeat: Heartbeat,
  fake: FakeConnection,
  frame: Record<string, unknown>,
): Promise<boolean> {
  let passed = false;
  const fc = { connection: fake.connection, raw: JSON.stringify(frame), frame, state: {} };
  await heartbeat.activityStage(fc, () =>
    heartbeat.stage(fc, () => {
      passed = true;
      return Promise.resolve();
    }),
  );
  return passed;
}

/** A running relay with the codec, this lane's heartbeat and the handshake. */
export interface LiveRelay {
  relay: TestRelay;
  heartbeat: Heartbeat;
  timers: ReturnType<typeof manualTimers>;
  /** A SimClient welcomed on the relay (never reconnecting; its own timers on a still clock). */
  client(options?: { faults?: readonly Fault[] }): Promise<SimClient>;
  /** Moves the relay's time by `ms` in `step` slices, letting sockets deliver between them. */
  advance(ms: number, step?: number): Promise<void>;
  stop(): Promise<void>;
}

/** Starts a LiveRelay with `config` (default the CT-WS-ENVELOPE values). */
export async function liveRelay(config: HeartbeatConfig = DEFAULTS): Promise<LiveRelay> {
  const timers = manualTimers();
  const key = signingKey();
  const jwks = stubJwks([key.jwk]);
  const access = memoryAccess();
  let heartbeat: Heartbeat | undefined;
  const connectionModule: RelayModule = {
    name: 'connection',
    order: 12,
    register(ctx) {
      heartbeat = createHeartbeat({
        config,
        clock: timers.clock.now,
        monotonic: timers.clock.now,
        setTimer: timers.setTimer,
        closeTimer: timers.setTimer,
        logger: ctx.log,
        metrics: ctx.metrics,
      });
      ctx.pipeline.use(5, heartbeat.activityStage);
      ctx.pipeline.use(12, heartbeat.stage);
      ctx.onConnection(heartbeat.onConnection);
      return undefined;
    },
  };
  const handshakeModule: RelayModule = {
    name: 'handshake',
    order: 15,
    register(ctx) {
      const handshake = createHandshake({
        config: TEST_HANDSHAKE_CONFIG,
        jwks: new JwksCache({ url: TEST_HANDSHAKE_CONFIG.jwksUrl, fetch: jwks.fetcher }),
        kv: ctx.redis.kv,
        access,
        registry: ctx.connections,
        logger: ctx.log,
        metrics: ctx.metrics,
        heartbeat: welcomeHeartbeat(config),
      });
      ctx.pipeline.use(15, handshake.stage);
      ctx.onConnection(handshake.onConnection);
      return undefined;
    },
  };
  const relay = await testRelay({ modules: [codecModule, connectionModule, handshakeModule] });
  if (heartbeat === undefined) throw new Error('the connection module did not register');
  const hb = heartbeat;
  const clients: SimClient[] = [];
  return {
    relay,
    heartbeat: hb,
    timers,
    async client(options = {}) {
      const claims = ticketFor();
      access.allow(claims);
      const client = await SimClient.connect({
        url: relay.url,
        ticket: await mintTicket(key, claims),
        clock: createManualClock(),
        ...(options.faults === undefined ? {} : { faults: options.faults }),
      });
      clients.push(client);
      return client;
    },
    async advance(ms, step = 1_000) {
      for (let done = 0; done < ms; done += step) {
        timers.clock.advance(Math.min(step, ms - done));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async stop() {
      for (const c of clients) c.terminate();
      hb.stop();
      await relay.stop();
    },
  };
}

/** A fault that hides the relay's pings from a SimClient, so it never answers them. */
export const ignorePings: Fault = (data, next) => {
  if (!data.includes('"t":"sys.ping"')) next(data);
};
