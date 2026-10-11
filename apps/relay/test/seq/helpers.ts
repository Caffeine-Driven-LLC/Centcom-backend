/**
 * Test helpers for sequencing (B041):
 *
 * - `unitSequencer()`: the stage over the in-memory store on B011's manual clock and manual timers,
 *   with `join(sid, member)` giving a fake connection welcomed as the handshake leaves it
 *   (authenticated, session and member set) and `inbound()` running a frame through the stage;
 * - `seqMetrics()`: counters and histogram observations;
 * - `seqRelay()`: a running relay with the codec, the handshake (test keys, in-memory access, the
 *   configured limits in `sys.welcome`), this lane's stage and a stand-in fan-out at order 50 that
 *   sends each sequenced frame to the session's other connections (B044's job), and `client()`
 *   opening a B011 SimClient on it.
 */
import { newId } from '@centcom/contracts';
import type { Metrics } from '@centcom/core';
import { createManualClock, SimClient, type Fault, type ManualClock } from '@centcom/testkit/sim';
import codecModule from '../../src/codec/module.js';
import { ConnectionRegistry } from '../../src/connection-registry.js';
import { createHandshake } from '../../src/handshake/handshake.js';
import { JwksCache } from '../../src/handshake/jwks.js';
import type { RelayContext, RelayModule } from '../../src/modules.js';
import type { RelayConnection } from '../../src/pipeline.js';
import { createMemorySeqStore, type MemorySeqStore } from '../../src/seq/memory-store.js';
import { createSequencer, type Sequencer, type SequencerDeps } from '../../src/seq/stage.js';
import {
  SEQUENCE_UNKNOWN_KEY,
  SEQUENCED_DUPLICATE_KEY,
  SEQUENCED_STATE_KEY,
  type BufferLimits,
  type SeqStore,
  type StoredFrame,
} from '../../src/seq/types.js';
import { fakeConnection, manualTimers, type FakeConnection } from '../connection/helpers.js';
import {
  memoryAccess,
  mintTicket,
  signingKey,
  stubJwks,
  TEST_HANDSHAKE_CONFIG,
  ticketFor,
  type TicketInput,
} from '../handshake/helpers.js';
import { testRelay, until, type TestRelay } from '../helpers.js';

export { until };

/** CT-WS-ENVELOPE buffer defaults. */
export const LIMITS: BufferLimits = { minFrames: 5_000, minAgeMs: 600_000, maxFrames: 20_000 };
/** The epoch the manual clocks start at (2026-10-08T12:00:00Z). */
export const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

/** Counters and histogram observations. */
export function seqMetrics(): {
  metrics: Metrics;
  count(name: string, labels?: Record<string, string>): number;
  observations(name: string): number[];
} {
  const counts = new Map<string, number>();
  const observed = new Map<string, number[]>();
  const key = (name: string, labels?: Record<string, string>): string =>
    `${name}${JSON.stringify(labels ?? {})}`;
  return {
    metrics: {
      counter: (name, labels) => ({
        inc: (n = 1) => counts.set(key(name, labels), (counts.get(key(name, labels)) ?? 0) + n),
      }),
      histogram: (name) => ({
        observe: (value) => {
          const list = observed.get(name) ?? [];
          list.push(value);
          observed.set(name, list);
        },
      }),
    },
    count: (name, labels) => counts.get(key(name, labels)) ?? 0,
    observations: (name) => observed.get(name) ?? [],
  };
}

/** A valid `reaction` payload (CT-WS-SESSION-EVENTS). */
export const reaction = (): Record<string, unknown> => ({
  target: newId('msg'),
  code: 'thumbs',
  op: 'add',
});

/** A sequenced client frame (as the codec leaves it: no from, ts or seq). */
export function clientFrame(
  sid: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    t: 'event',
    id: newId('msg'),
    sid,
    k: 'reaction',
    p: reaction(),
    ...overrides,
  };
}

/** A stage on fake connections. */
export interface UnitSequencer {
  sequencer: Sequencer;
  store: SeqStore;
  memory: MemorySeqStore;
  clock: ManualClock;
  timers: ReturnType<typeof manualTimers>;
  registry: ConnectionRegistry;
  recorded: ReturnType<typeof seqMetrics>;
  /** A connection of `member` in `sid`, welcomed. */
  join(sid: string, member?: string): FakeConnection;
  /** Runs `frame` through the stage; `passed` is whether it went on to the next stage. */
  inbound(
    fake: FakeConnection,
    frame: Record<string, unknown>,
  ): Promise<{
    passed: boolean;
    stored: StoredFrame | undefined;
    duplicate: StoredFrame | undefined;
    unknown: boolean;
  }>;
}

/** A stage over the in-memory store (or `store`), at T0 on a manual clock. */
export function unitSequencer(
  overrides: Partial<SequencerDeps> & { limits?: BufferLimits } = {},
): UnitSequencer {
  const clock = createManualClock(T0);
  const timers = manualTimers(clock);
  const registry = new ConnectionRegistry({ max: 1_000_000 });
  const recorded = seqMetrics();
  const memory = createMemorySeqStore(overrides.limits ?? LIMITS);
  const store = overrides.store ?? memory;
  const sequencer = createSequencer({
    store,
    rate: 30,
    burst: 100,
    clock: clock.now,
    metrics: recorded.metrics,
    setTimer: timers.setTimer,
    closeTimer: timers.setTimer,
    random: () => 0.5,
    ...overrides,
  });
  return {
    sequencer,
    store,
    memory,
    clock,
    timers,
    registry,
    recorded,
    join(sid, member = newId('mem')) {
      const fake = fakeConnection(registry, clock.now);
      fake.connection.entry.state = 'authenticated';
      fake.connection.entry.sessionId = sid;
      fake.connection.entry.memberId = member;
      sequencer.onConnection(fake.connection);
      return fake;
    },
    async inbound(fake, frame) {
      let passed = false;
      const fc = { connection: fake.connection, raw: JSON.stringify(frame), frame, state: {} };
      await sequencer.stage(fc, () => {
        passed = true;
        return Promise.resolve();
      });
      const stored = (fc.state as Record<string, unknown>)[SEQUENCED_STATE_KEY] as
        StoredFrame | undefined;
      const duplicate = (fc.state as Record<string, unknown>)[SEQUENCED_DUPLICATE_KEY] as
        StoredFrame | undefined;
      const unknown = (fc.state as Record<string, unknown>)[SEQUENCE_UNKNOWN_KEY] === true;
      return { passed, stored, duplicate, unknown };
    },
  };
}

/** The frames of `type` a fake connection was sent. */
export const sentOf = (fake: FakeConnection, type: string): Record<string, unknown>[] =>
  fake.sent().filter((f) => f['t'] === type);

/** A running relay with sequencing, and SimClients on it. */
export interface SeqRelay {
  relay: TestRelay;
  sequencer: Sequencer;
  store: MemorySeqStore;
  /** The context the modules were registered with. */
  ctx: RelayContext;
  /** One session's id (any other works too). */
  sid: string;
  /** A SimClient of a new member of `sid` (default `this.sid`), welcomed. */
  client(options?: {
    sid?: string;
    role?: TicketInput['role'];
    faults?: readonly Fault[];
  }): Promise<SimClient & { claims: TicketInput }>;
  /** A fresh ticket for `claims` (tickets are single use). */
  ticket(claims: TicketInput): Promise<string>;
  stop(): Promise<void>;
}

/** Starts a SeqRelay; `deps` bend the stage (clock, rate, burst, durable port...). */
export async function seqRelay(
  deps: Partial<SequencerDeps> & { limits?: BufferLimits } = {},
): Promise<SeqRelay> {
  const key = signingKey();
  const jwks = stubJwks([key.jwk]);
  const access = memoryAccess();
  const store = createMemorySeqStore(deps.limits ?? LIMITS);
  const rate = deps.rate ?? 30;
  const burst = deps.burst ?? 100;
  let sequencer: Sequencer | undefined;
  let context: RelayContext | undefined;
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
        seqLimits: { seq_rate: rate, seq_burst: burst },
      });
      ctx.pipeline.use(15, handshake.stage);
      ctx.onConnection(handshake.onConnection);
      return undefined;
    },
  };
  const seqModule: RelayModule = {
    name: 'seq',
    order: 40,
    register(ctx) {
      sequencer = createSequencer({
        store,
        rate,
        burst,
        clock: ctx.clock,
        logger: ctx.log,
        metrics: ctx.metrics,
        ...deps,
      });
      ctx.pipeline.use(40, sequencer.stage);
      ctx.onConnection(sequencer.onConnection);
      ctx.seq = sequencer.service;
      context = ctx;
      return undefined;
    },
  };
  // B044 stands in: each sequenced frame goes to the session's other open connections.
  const open = new Set<RelayConnection>();
  const fanOutModule: RelayModule = {
    name: 'fan-out-stand-in',
    order: 50,
    register(ctx) {
      ctx.onConnection((connection) => {
        open.add(connection);
        connection.onClose(() => open.delete(connection));
      });
      ctx.pipeline.use(50, (fc, next) => {
        const frame = fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined;
        if (frame !== undefined) {
          for (const other of open) {
            if (other !== fc.connection && other.entry.sessionId === frame.sid) other.send(frame);
          }
        }
        return next();
      });
      return undefined;
    },
  };
  const relay = await testRelay({
    modules: [codecModule, handshakeModule, seqModule, fanOutModule],
  });
  if (sequencer === undefined || context === undefined) throw new Error('seq did not register');
  const sid = newId('ses');
  const clients: SimClient[] = [];
  const ticket = (claims: TicketInput): Promise<string> => mintTicket(key, claims);
  return {
    relay,
    sequencer,
    store,
    ctx: context,
    sid,
    ticket,
    async client(options = {}) {
      const claims = ticketFor({ sid: options.sid ?? sid, role: options.role ?? 'editor' });
      access.allow(claims);
      const client = await SimClient.connect({
        url: relay.url,
        ticket: await ticket(claims),
        clock: createManualClock(),
        ...(options.faults === undefined ? {} : { faults: options.faults }),
      });
      clients.push(client);
      return Object.assign(client, { claims });
    },
    async stop() {
      for (const c of clients) c.terminate();
      await relay.stop();
    },
  };
}

/** A store whose `assign` and `head` calls wait until the test lets them through. */
export interface HeldStore extends SeqStore {
  /** Calls made so far. */
  calls: { assign: number; head: number };
  /** Calls waiting. */
  waiting(): number;
  /** Lets the oldest waiting call through to `inner` (or fails it with `error`). */
  release(error?: Error): Promise<void>;
}

/** Holds every `assign` and `head` of `inner` until released. */
export function heldStore(inner: SeqStore): HeldStore {
  const queue: {
    run: () => Promise<unknown>;
    settle: (v: unknown) => void;
    fail: (e: Error) => void;
  }[] = [];
  const calls = { assign: 0, head: 0 };
  const hold = <T>(run: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push({ run, settle: resolve as (v: unknown) => void, fail: reject });
    });
  return {
    calls,
    waiting: () => queue.length,
    async release(error) {
      const call = queue.shift();
      if (call === undefined) throw new Error('nothing is waiting');
      if (error !== undefined) {
        call.fail(error);
        return;
      }
      call.settle(await call.run());
    },
    assign(...args) {
      calls.assign += 1;
      return hold(() => inner.assign(...args));
    },
    head(sid) {
      calls.head += 1;
      return hold(() => inner.head(sid));
    },
    range: (...args) => inner.range(...args),
    oldest: (sid) => inner.oldest(sid),
    hydrate: (...args) => inner.hydrate(...args),
    assignBatch: (...args) => inner.assignBatch(...args),
  };
}

/** Lets settled promises run their callbacks. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
