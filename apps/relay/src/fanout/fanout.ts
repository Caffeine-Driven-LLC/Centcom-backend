/**
 * The fan-out engine (B044, CT-WS-SESSION-EVENTS): delivers each sequenced frame to every
 * connection of its session's room on this node, the sender's included (its echo), strictly in
 * `seq` order, as opaque bytes.
 *
 * - **Stage** (order 50): a frame the sequence stage (B041) passed on is delivered to the room of
 *   the connection's authenticated session (`entry.sessionId`), never the frame's own `sid`.
 * - **Order:** frames go through `OrderedRelease`; each room connection gets them in contiguous
 *   `seq` order. A gap that does not fill within 250 ms is fetched from the hot buffer
 *   (`SeqStore.range`); a range still missing closes the room's connections with 1001
 *   (`sys.bye` `resync`) so their clients resume (B042), and the session's order starts afresh.
 * - **Opaque:** a frame is serialised once (`JSON.stringify` of the frame B041 stored, whose `p`,
 *   `ct` and `sig` are the decoder's values, never re-encoded) and that same text goes to every
 *   connection: the echo, the fan-out and the hot buffer hold the same bytes.
 * - **Isolation:** one connection's failed or throwing send is counted and skipped; closed
 *   connections are skipped; nothing awaits per recipient.
 * - **Server frames:** `emitServer(sid, kind, t, p)` sequences a frame from `srv` through B041
 *   (`submitServer`: same `seq` space, buffered, durably appended) and delivers it in order.
 * - **Other nodes:** each locally sequenced frame is also handed to the `RemoteDispatcher`
 *   (default: none; B045 publishes to the other nodes).
 * - **Holds** (B042): while a connection replays, `hold(conn)` keeps the frames fan-out would send
 *   it (and the echoes of its resends, `sendTo`) in a bounded queue, in the order they came; the
 *   resume module sends them after the replay. A hold past MAX_HELD_FRAMES closes the connection
 *   with 1001 (`sys.bye` `resync`) so its client resumes again.
 *
 * Logs carry the session, counts and outcomes; never `p`, `ct`, `sig` or ids.
 *
 * Owns: delivery, its order and the server's frames. Must not: read or rewrite `ct`, deliver to
 * another session's room, or block one recipient on another.
 */
import { newId } from '@centcom/contracts';
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import { closeConnection } from '../connection/close.js';
import { CloseCode } from '../close-codes.js';
import type { InboundStage, RelayConnection } from '../pipeline.js';
import type { RoomRegistry } from '../rooms/registry.js';
import {
  SEQUENCED_STATE_KEY,
  SERVER_FROM,
  type SeqService,
  type StoredFrame,
  type UnsequencedFrame,
} from '../seq/types.js';
import { createOrderedRelease, type OrderedRelease, type ReleaseTimer } from './release.js';

/** `sys.bye` reason of a resync close (an unfillable gap, or a hold that overflowed). */
export const RESYNC_REASON = 'resync';
/** Frames one hold keeps at most (live traffic during a replay). */
export const MAX_HELD_FRAMES = 10_000;
/** `relay_fanout_latency_seconds` buckets. */
export const LATENCY_BUCKETS_S: readonly number[] = Object.freeze([
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
]);

/** B045's port: publishes a locally sequenced frame to the other nodes (default: none). */
export interface RemoteDispatcher {
  publish(sid: string, frame: StoredFrame): Promise<void>;
}

/** No other node. */
export const noRemoteDispatcher: RemoteDispatcher = Object.freeze({
  publish: () => Promise.resolve(),
});

/** One connection as fan-out (and B046's backpressure) writes to it. */
export interface ConnectionSender {
  send(frameText: string, opts: { droppable: boolean }): 'queued' | 'dropped' | 'closed';
  bufferedBytes(): number;
}

/** The sender of `conn`: its raw-text send, or (test doubles) its object send. */
export function connectionSender(conn: RelayConnection): ConnectionSender {
  return {
    send(text) {
      if (conn.entry.state === 'closing') return 'closed';
      const sent =
        conn.sendText === undefined ? conn.send(JSON.parse(text) as object) : conn.sendText(text);
      return sent ? 'queued' : 'closed';
    },
    bufferedBytes: () => conn.bufferedBytes?.() ?? 0,
  };
}

/** One held frame: its `seq` and the exact text fan-out would have sent. */
export interface HeldFrame {
  seq: number;
  text: string;
}

/** A connection's frames held while it replays (B042). */
export interface LiveHold {
  /** The oldest held frame, removed from the hold; undefined when none is held. */
  next(): HeldFrame | undefined;
  /**
   * Stops holding: from now on frames go to the connection again, except those at or below
   * `sentUpTo` (the connection already has them: a late frame of the replayed range is skipped).
   * Frames still held are dropped.
   */
  end(sentUpTo?: number): void;
  /** True once the hold overflowed (the connection was closed to resync). */
  readonly overflowed: boolean;
}

/** `ctx.fanout`: what the fan-out module offers the modules after it (B042, B047, B051, ...). */
export interface FanOut {
  /** Delivers a locally sequenced frame of session `sid` (and hands it to other nodes). */
  deliver(sid: string, frame: StoredFrame): void;
  /** Sequences and delivers a frame the relay emits itself (`from` = `srv`). */
  emitServer(
    sid: string,
    kind: string,
    t: 'control' | 'queue' | 'event',
    p: Record<string, unknown>,
  ): Promise<StoredFrame>;
  /** The ordered release (B045 offers frames from other nodes to it). */
  readonly release: OrderedRelease;
  /** Replaces the RemoteDispatcher (B045). */
  setRemoteDispatcher(dispatcher: RemoteDispatcher): void;
  /**
   * B042: holds the frames fan-out would send `conn` until the hold ends (a second hold of the same
   * connection replaces the first, whose frames are dropped).
   */
  hold(conn: RelayConnection): LiveHold;
  /** One frame to one connection (the echo of a resend), held while the connection is held. */
  sendTo(conn: RelayConnection, frame: StoredFrame): void;
}

/** What fan-out needs. */
export interface FanOutDeps {
  rooms: Pick<RoomRegistry, 'get'>;
  seq: Pick<SeqService, 'store' | 'submitServer'>;
  remote?: RemoteDispatcher;
  logger?: Logger;
  metrics?: Metrics;
  /** Milliseconds since the epoch; default Date.now. */
  clock?: () => number;
  /** For OrderedRelease; default an unref'd setTimeout. */
  setTimer?: (fn: () => void, ms: number) => ReleaseTimer;
  /** OrderedRelease bounds (tests). */
  maxBuffered?: number;
  gapAfterMs?: number;
}

/** The engine, its stage, and a stop for shutdown. */
export function createFanOut(deps: FanOutDeps): FanOut & { stage: InboundStage; stop(): void } {
  const metrics = deps.metrics ?? noopMetrics;
  const clock = deps.clock ?? Date.now;
  let remote = deps.remote ?? noRemoteDispatcher;
  const latency = metrics.histogram('relay_fanout_latency_seconds', LATENCY_BUCKETS_S);
  const deliveries = (result: string) =>
    metrics.counter('relay_fanout_deliveries_total', { result });
  const holds = new WeakMap<RelayConnection, Hold>();
  /** After a hold: frames at or below this were sent already; cleared by the first one above. */
  const floors = new WeakMap<RelayConnection, number>();

  interface Hold extends LiveHold {
    push(seq: number, text: string): void;
  }

  function createHold(conn: RelayConnection): Hold {
    let queue: HeldFrame[] = [];
    let head = 0;
    let overflowed = false;
    const hold: Hold = {
      push(seq, text) {
        if (queue.length - head >= MAX_HELD_FRAMES) {
          overflowed = true;
          hold.end();
          deliveries('overflow').inc();
          deps.logger?.warn({ held: MAX_HELD_FRAMES }, 'relay.fanout_hold_overflow');
          closeConnection(conn, { code: CloseCode.GoingAway, bye: RESYNC_REASON });
          return;
        }
        queue.push({ seq, text });
        deliveries('held').inc();
      },
      next() {
        if (head >= queue.length) return undefined;
        const frame = queue[head];
        head += 1;
        // Compact once the taken prefix is large.
        if (head > 1_024 && head * 2 > queue.length) {
          queue = queue.slice(head);
          head = 0;
        }
        return frame;
      },
      end(sentUpTo) {
        if (holds.get(conn) === hold) {
          holds.delete(conn);
          if (sentUpTo !== undefined) floors.set(conn, sentUpTo);
        }
        queue = [];
        head = 0;
      },
      get overflowed() {
        return overflowed;
      },
    };
    return hold;
  }

  /** Sends `text` (frame `seq`) to `conn`, or holds it; the result counted. */
  function sendOne(conn: RelayConnection, seq: number, text: string): void {
    const hold = holds.get(conn);
    if (hold !== undefined) {
      hold.push(seq, text);
      return;
    }
    const floor = floors.get(conn);
    if (floor !== undefined) {
      if (seq <= floor) {
        deliveries('replayed').inc();
        return;
      }
      floors.delete(conn);
    }
    let result: 'queued' | 'dropped' | 'closed' | 'error';
    try {
      result = connectionSender(conn).send(text, { droppable: false });
    } catch {
      result = 'error';
    }
    deliveries(result).inc();
  }

  function releaseTo(sid: string, frame: StoredFrame): void {
    const room = deps.rooms.get(sid);
    if (room === undefined) {
      deliveries('no_room').inc();
      return;
    }
    const text = JSON.stringify(frame);
    for (const conn of [...room.connections()]) sendOne(conn, frame.seq, text);
    const received = Date.parse(frame.ts);
    if (!Number.isNaN(received)) latency.observe(Math.max(0, clock() - received) / 1000);
  }

  const release = createOrderedRelease({
    release: releaseTo,
    clock,
    ...(deps.setTimer === undefined ? {} : { setTimer: deps.setTimer }),
    ...(deps.maxBuffered === undefined ? {} : { maxBuffered: deps.maxBuffered }),
    ...(deps.gapAfterMs === undefined ? {} : { gapAfterMs: deps.gapAfterMs }),
  });

  /** A gap that would not fill: the room's clients resync through resume (B042). */
  function resync(sid: string, fromSeq: number, toSeq: number): void {
    metrics.counter('relay_fanout_gaps_total', { result: 'resync' }).inc();
    deps.logger?.warn({ sid, from_seq: fromSeq, to_seq: toSeq }, 'relay.fanout_gap_unfilled');
    release.reset(sid);
    const room = deps.rooms.get(sid);
    if (room === undefined) return;
    for (const conn of [...room.connections()]) {
      closeConnection(conn, { code: CloseCode.GoingAway, bye: RESYNC_REASON });
    }
  }

  release.onGap((sid, fromSeq, toSeq) => {
    void (async () => {
      let frames: StoredFrame[] = [];
      try {
        frames = await deps.seq.store.range(sid, fromSeq - 1, toSeq - fromSeq + 1);
      } catch {
        // The hot buffer cannot be read: the clients resync.
      }
      for (const frame of frames) {
        if (frame.seq >= fromSeq && frame.seq <= toSeq) release.offer(sid, frame);
      }
      const expected = release.expected(sid);
      if (expected !== null && expected <= toSeq) resync(sid, fromSeq, toSeq);
      else metrics.counter('relay_fanout_gaps_total', { result: 'filled' }).inc();
    })();
  });

  function deliver(sid: string, frame: StoredFrame): void {
    release.offer(sid, frame);
    remote.publish(sid, frame).catch(() => {
      metrics.counter('relay_fanout_remote_failures_total').inc();
    });
  }

  const stage: InboundStage = async (fc, next) => {
    const frame = fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined;
    const sid = fc.connection.entry.sessionId;
    if (frame !== undefined && sid !== null) deliver(sid, frame);
    await next();
  };

  return {
    deliver,
    async emitServer(sid, kind, t, p) {
      const frame = {
        v: 1,
        t,
        id: newId('msg'),
        sid,
        from: SERVER_FROM,
        ts: new Date(clock()).toISOString(),
        k: kind,
        p,
      } as UnsequencedFrame;
      const stored = await deps.seq.submitServer(sid, frame);
      deliver(sid, stored);
      return stored;
    },
    release,
    setRemoteDispatcher(dispatcher) {
      remote = dispatcher;
    },
    hold(conn) {
      holds.get(conn)?.end();
      floors.delete(conn);
      const hold = createHold(conn);
      holds.set(conn, hold);
      return hold;
    },
    sendTo(conn, frame) {
      sendOne(conn, frame.seq, JSON.stringify(frame));
    },
    stage,
    stop: () => release.stop(),
  };
}
