/**
 * Heartbeat and liveness (B040, CT-WS-ENVELOPE "Heartbeat"): one state machine per connection,
 * pings, pongs and dead-peer detection, all on one shared timer wheel.
 *
 * - **Activity** (stage at order 5, before decoding): every inbound message, valid or not, is
 *   activity, timed by the server's clock.
 * - **State** (stage at order 12, before the handshake): the first message moves a connection to
 *   `authenticating`; once the handshake (B038) has welcomed it, `active`; a connection another
 *   path is closing is `draining`; its socket closing makes it `closed` and forgets it.
 * - **Pings**: an active connection gets `sys.ping {t}` first at ping_ms ±10 % after the welcome
 *   (so connections that arrive together do not ping together), then every ping_ms. `t` is the
 *   server's monotonic time; a `sys.pong` is consumed and never passed on, whatever its `t`.
 * - **Client pings**: answered at once with `sys.pong` echoing `p.t`, and consumed.
 * - **Dead peers**: an active connection with no inbound message for dead_ms is closed with 1000
 *   and `sys.bye`/reason `dead_peer`, counted in `relay_dead_peers_total`. The check reads the
 *   time since the last activity when it runs, so it never needs rescheduling per frame. A tick
 *   that runs over 5 s late (a stalled event loop) holds dead checks one slot, so frames waiting
 *   in socket buffers are read before anyone is judged silent.
 *
 * Pings and pongs are written straight to the socket: never sequenced, buffered or replayed.
 *
 * Owns: liveness. Must not: trust a client's `t`, or keep anything for a connection that closed.
 */
import { randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import type { ConnectionEntry } from '../connection-registry.js';
import type { InboundStage, RelayConnection } from '../pipeline.js';
import { closeConnection, type CloseTimer } from './close.js';
import type { HeartbeatConfig } from './config.js';
import { createConnectionMachine, type ConnectionMachine } from './machine.js';
import { TimerWheel, type PlatformTimer, type TickInfo, type WheelEntry } from './wheel.js';

/** The share of ping_ms the first ping is moved by, either way. */
export const PING_JITTER = 0.1;
/** A tick this late means the event loop stalled: dead checks wait a slot. */
export const LOOP_LAG_GRACE_MS = 5_000;
/** The reason of a dead-peer close. */
export const DEAD_PEER_REASON = 'dead_peer';
/** Counted for each dead-peer close. */
export const DEAD_PEERS_METRIC = 'relay_dead_peers_total';

/** Dependencies of the heartbeat. */
export interface HeartbeatDeps {
  config: HeartbeatConfig;
  /** Server time (ms since the epoch): activity and deadlines. */
  clock: () => number;
  /** `p.t` of server pings: monotonic ms; default `performance.now()`. */
  monotonic?: () => number;
  /** Uniform in [0, 1) for the first ping's jitter; default the CSPRNG. */
  random?: () => number;
  /** The wheel's platform timer; default an unref'd setTimeout. */
  setTimer?: PlatformTimer;
  /** closeConnection's terminate fallback timer; default an unref'd setTimeout. */
  closeTimer?: CloseTimer;
  /** Slot width of the wheel (ms); default 100. */
  resolutionMs?: number;
  logger?: Logger;
  metrics?: Metrics;
}

/** One connection's tracked state. */
interface Tracked {
  readonly connection: RelayConnection;
  readonly machine: ConnectionMachine;
  ping?: WheelEntry;
  dead?: WheelEntry;
  /** Due time of the next ping (the cadence runs on due times, not on when ticks ran). */
  nextPingAt: number;
}

/** The heartbeat's parts. */
export interface Heartbeat {
  /** Order 5 (STAGE_ORDER.activity): records activity. */
  readonly activityStage: InboundStage;
  /** Order 12 (STAGE_ORDER.heartbeat): state, pings and pongs. */
  readonly stage: InboundStage;
  /** Run for every accepted connection. */
  readonly onConnection: (connection: RelayConnection) => void;
  /** The machine of an open connection (tests, and later lanes reading the state). */
  machine(connection: RelayConnection): ConnectionMachine | undefined;
  /** Open connections tracked. */
  readonly size: number;
  readonly wheel: TimerWheel;
  /** Forgets every connection and stops the timer (shutdown). */
  stop(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const csprngUniform = (): number => randomInt(0, 2 ** 32) / 2 ** 32;

/** The heartbeat over `deps`. */
export function createHeartbeat(deps: HeartbeatDeps): Heartbeat {
  const { config, clock } = deps;
  const monotonic = deps.monotonic ?? (() => Math.floor(performance.now()));
  const random = deps.random ?? csprngUniform;
  const metrics = deps.metrics ?? noopMetrics;
  const wheel = new TimerWheel({
    clock,
    ...(deps.setTimer === undefined ? {} : { setTimer: deps.setTimer }),
    ...(deps.resolutionMs === undefined ? {} : { resolutionMs: deps.resolutionMs }),
  });
  const tracked = new Map<ConnectionEntry, Tracked>();

  /** The first ping's delay: ping_ms ±10 %, so it runs (a slot late at most) inside the band. */
  const firstPingDelay = (): number => {
    const low = config.pingMs * (1 - PING_JITTER);
    const high = config.pingMs * (1 + PING_JITTER) - wheel.resolutionMs;
    return Math.round(low + random() * Math.max(0, high - low));
  };

  /** Stops timing `t` (its connection is closing or closed). */
  const unschedule = (t: Tracked): void => {
    t.ping?.cancel();
    t.dead?.cancel();
    t.ping = undefined;
    t.dead = undefined;
  };

  /** Moves to `draining` when another path started closing the connection. */
  const syncClosing = (t: Tracked): boolean => {
    if (t.connection.entry.state !== 'closing') return false;
    if (t.machine.state !== 'draining' && t.machine.state !== 'closed') {
      t.machine.transition('draining');
    }
    unschedule(t);
    return true;
  };

  const schedulePing = (t: Tracked): void => {
    t.ping = wheel.schedule(t.nextPingAt, () => {
      t.ping = undefined;
      if (syncClosing(t) || t.machine.state !== 'active') return;
      t.connection.send({ v: 1, t: 'sys.ping', p: { t: monotonic() } });
      t.nextPingAt += config.pingMs;
      schedulePing(t);
    });
  };

  const scheduleDead = (t: Tracked, at: number): void => {
    t.dead = wheel.schedule(at, (info: TickInfo) => {
      t.dead = undefined;
      if (syncClosing(t) || t.machine.state !== 'active') return;
      if (info.lagMs > LOOP_LAG_GRACE_MS) {
        // The loop stalled: read what the sockets hold before judging anyone silent.
        scheduleDead(t, info.now + wheel.resolutionMs);
        return;
      }
      const silentFor = info.now - t.machine.lastActivityAt;
      if (silentFor < config.deadMs) {
        scheduleDead(t, t.machine.lastActivityAt + config.deadMs);
        return;
      }
      metrics.counter(DEAD_PEERS_METRIC).inc();
      deps.logger?.info({ silent_ms: silentFor }, 'relay.dead_peer');
      t.machine.transition('draining');
      unschedule(t);
      closeConnection(
        t.connection,
        { code: 1000, bye: DEAD_PEER_REASON },
        deps.closeTimer === undefined ? {} : { setTimer: deps.closeTimer },
      );
    });
  };

  const activate = (t: Tracked): void => {
    t.machine.transition('active');
    t.machine.touch();
    const now = clock();
    t.nextPingAt = now + firstPingDelay();
    schedulePing(t);
    scheduleDead(t, now + config.deadMs);
  };

  const onConnection = (connection: RelayConnection): void => {
    const t: Tracked = {
      connection,
      machine: createConnectionMachine(clock),
      nextPingAt: 0,
    };
    tracked.set(connection.entry, t);
    connection.onClose(() => {
      unschedule(t);
      if (t.machine.state !== 'closed') t.machine.transition('closed');
      tracked.delete(connection.entry);
    });
  };

  const activityStage: InboundStage = async (fc, next) => {
    tracked.get(fc.connection.entry)?.machine.touch();
    await next();
  };

  const stage: InboundStage = async (fc, next) => {
    const t = tracked.get(fc.connection.entry);
    if (t === undefined || syncClosing(t)) {
      await next();
      return;
    }
    if (t.machine.state === 'active') {
      const frame = isRecord(fc.frame) ? fc.frame : undefined;
      if (frame?.['t'] === 'sys.pong') return;
      if (frame?.['t'] === 'sys.ping') {
        const p = isRecord(frame['p']) ? frame['p'] : {};
        const echo = typeof p['t'] === 'number' ? { t: p['t'] } : {};
        t.connection.send({ v: 1, t: 'sys.pong', p: echo });
        return;
      }
      await next();
      return;
    }
    if (t.machine.state === 'awaiting_hello') t.machine.transition('authenticating');
    await next();
    if (syncClosing(t)) return;
    if (t.machine.state === 'authenticating' && t.connection.entry.state === 'authenticated') {
      activate(t);
    }
  };

  return {
    activityStage,
    stage,
    onConnection,
    machine: (connection) => tracked.get(connection.entry)?.machine,
    get size() {
      return tracked.size;
    },
    wheel,
    stop() {
      wheel.clear();
      tracked.clear();
    },
  };
}
