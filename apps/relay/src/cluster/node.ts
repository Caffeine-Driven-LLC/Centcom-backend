/**
 * One relay node in the cluster (B045): which channels it listens on, the member control channel,
 * and its heartbeat.
 *
 * - **Session channels** (`relay:{sid}:frames`, `relay:{sid}:eph`): subscribed when a session's
 *   room gets its first local connection (after the handshake authorised it: B043's join), left
 *   RELAY_UNSUB_GRACE_MS (30 s) after its last one left unless one joined again. While subscribed
 *   the session's release is pinned (never forgotten as idle). A subscribe that fails is retried
 *   with backoff and jitter while the room is occupied; once it succeeds the session is
 *   reconciled with the store (frames published before or during the outage are fetched).
 * - **Reconcile:** every RELAY_CLUSTER_RECONCILE_MS each subscribed session is compared with the
 *   store's head (pub/sub drops messages silently, and ioredis resubscribes after a reconnect
 *   without telling anyone).
 * - **Member control** (`relay:member:{mid}:ctl`, `MemberControl.closeMember`): a command closes
 *   the member's connections on this node at once and on every other node through the channel
 *   (each node subscribes to the channels of the members connected to it). `welcomed` uses it so
 *   a `(member, device)` connecting here closes its older connections elsewhere with `sys.bye
 *   superseded` and 4409. Only server code calls it; no client frame reaches the channel.
 * - **Heartbeat:** `relay:node:{id}` holds `{node, sessions, members}` with a 15 s TTL, refreshed
 *   every 5 s, deleted on stop.
 *
 * Owns: subscriptions, commands and the heartbeat. Must not: subscribe for a session before a
 * local member of it was authorised, or let a client reach the control channel.
 */
import {
  noopMetrics,
  type KeyValue,
  type Logger,
  type Metrics,
  type PubSub,
  type Unsubscribe,
} from '@centcom/core';
import type { ErrorCode } from '@centcom/core';
import { CloseCode, type CloseCodeValue } from '../close-codes.js';
import { CLOSE_FRAMES, closeConnection, type CloseSpec } from '../connection/close.js';
import { connectionSender, type FanOut } from '../fanout/fanout.js';
import type { AdmittedHello } from '../handshake/handshake.js';
import type { RelayConnection } from '../pipeline.js';
import type { RoomRegistry } from '../rooms/registry.js';
import type { SeqStore } from '../seq/types.js';
import {
  checkCommand,
  controlChannel,
  ephemeralChannel,
  framesChannel,
  nodeKey,
  parseControlMessage,
  type MemberCommand,
} from './channels.js';
import type { ClusterConfig } from './config.js';
import { ClusterDispatcher } from './dispatcher.js';

/** The heartbeat key lives this long; it is refreshed every HEARTBEAT_EVERY_MS. */
export const HEARTBEAT_TTL_MS = 15_000;
export const HEARTBEAT_EVERY_MS = 5_000;
/** Subscribe retries: the first waits about this long, doubling up to the cap (with jitter). */
export const SUBSCRIBE_RETRY_BASE_MS = 100;
export const SUBSCRIBE_RETRY_MAX_MS = 5_000;

/** Closes a member's connections on every node (consumed by B043/B038 superseding, B051's kick). */
export interface MemberControl {
  closeMember(memberId: string, cmd: MemberCommand): Promise<void>;
}

/** A timer that can be cancelled. */
export interface ClusterTimer {
  cancel(): void;
}

/** What a node needs. */
export interface ClusterNodeDeps {
  pubsub: PubSub;
  kv: Pick<KeyValue, 'set' | 'del'>;
  rooms: Pick<RoomRegistry, 'get' | 'rooms' | 'listen'>;
  fanout: Pick<FanOut, 'release' | 'setRemoteDispatcher'>;
  store: Pick<SeqStore, 'head' | 'range'>;
  config: ClusterConfig;
  clock?: () => number;
  /** Runs `fn` after `ms`; default an unref'd setTimeout. */
  setTimer?: (fn: () => void, ms: number) => ClusterTimer;
  /** [0, 1), for jitter; default Math.random. */
  random?: () => number;
  /**
   * Takes another node's ephemeral frame of `sid` (B047's presence: snapshot ordering and the
   * welcome); true when it did. Default: to every local connection of the session.
   */
  onEphemeral?: (sid: string, frameText: string) => boolean;
  logger?: Logger;
  metrics?: Metrics;
}

/** `ctx.cluster`: this node in the cluster. */
export interface ClusterNode {
  readonly nodeId: string;
  readonly dispatcher: ClusterDispatcher;
  readonly memberControl: MemberControl;
  /** After a welcome: the `(member, device)`'s older connections on other nodes are superseded. */
  welcomed(connection: RelayConnection, admitted: AdmittedHello): void;
  /** Publishes an ephemeral (presence) frame of `sid` to the other nodes (B047). */
  publishEphemeral(sid: string, frame: Record<string, unknown>): Promise<void>;
  /** Sessions whose channels this node listens on. */
  sessions(): string[];
  /** Members whose control channel this node listens on. */
  members(): string[];
  /** Leaves every channel, stops the timers and deletes the heartbeat. */
  stop(): Promise<void>;
}

/** The `sys.error` code a command closes with when it names none. */
const DEFAULT_ERROR: Partial<Record<CloseCodeValue, ErrorCode>> = {
  [CloseCode.InternalError]: 'internal_error',
  [CloseCode.ProtocolViolation]: 'protocol_violation',
  [CloseCode.Unauthenticated]: 'unauthorized',
  [CloseCode.Forbidden]: 'not_a_member',
  [CloseCode.NotFound]: 'session_ended',
  [CloseCode.HandshakeTimeout]: 'protocol_violation',
  [CloseCode.ClientTooOld]: 'client_too_old',
  [CloseCode.RateLimited]: 'rate_limited',
  [CloseCode.Overloaded]: 'service_unavailable',
};

/** The `sys.bye` reason a command closes with when it names none. */
const DEFAULT_BYE: Partial<Record<CloseCodeValue, string>> = {
  [CloseCode.GoingAway]: 'resync',
  [CloseCode.Superseded]: 'superseded',
};

/** How `closeConnection` closes for a (checked) command. */
function closeSpec(cmd: MemberCommand & { code: CloseCodeValue }): CloseSpec {
  const frame = CLOSE_FRAMES[cmd.code];
  if (frame === 'bye') return { code: cmd.code, bye: cmd.bye ?? DEFAULT_BYE[cmd.code] ?? 'closed' };
  if (frame === 'error') {
    return { code: cmd.code, errorCode: cmd.error ?? DEFAULT_ERROR[cmd.code] ?? 'internal_error' };
  }
  return { code: cmd.code, ...(cmd.bye === undefined ? {} : { bye: cmd.bye }) };
}

const defaultTimer = (fn: () => void, ms: number): ClusterTimer => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return { cancel: () => clearTimeout(handle) };
};

/** A set of channels held while something on this node wants them. */
interface Subscription {
  /** Wanted again: cancels a pending leave; subscribes if not yet. */
  want(): void;
  /** Not wanted: leaves after `graceMs` unless wanted again. */
  unwant(graceMs: number): void;
  active(): boolean;
  leave(): Promise<void>;
}

/** The node. */
export function createClusterNode(deps: ClusterNodeDeps): ClusterNode {
  const { config, pubsub } = deps;
  const nodeId = config.nodeId;
  const metrics = deps.metrics ?? noopMetrics;
  const clock = deps.clock ?? Date.now;
  const setTimer = deps.setTimer ?? defaultTimer;
  const random = deps.random ?? Math.random;
  const release = deps.fanout.release;
  const dispatcher = new ClusterDispatcher({
    redis: pubsub,
    nodeId,
    release,
    seq: deps.store,
    clock,
    metrics,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
  deps.fanout.setRemoteDispatcher(dispatcher);
  release.setGapAfterMs(config.gapMs);

  let stopped = false;
  const sessionSubs = new Map<string, Subscription>();
  const memberSubs = new Map<string, Subscription>();
  /** Local connections per member, over every room. */
  const memberConnections = new Map<string, number>();

  const counted = (kind: 'session' | 'member', op: string): void =>
    metrics.counter('relay_cluster_subscriptions_total', { kind, op }).inc();

  /** Channels subscribed while wanted, with retries and a grace before leaving. */
  function subscription(
    kind: 'session' | 'member',
    channels: readonly [string, (message: string) => void][],
    hooks: { subscribed(): void; left(): void },
  ): Subscription {
    let wanted = false;
    let unsubscribes: Unsubscribe[] | null = null;
    let connecting = false;
    let attempts = 0;
    let graceTimer: ClusterTimer | undefined;
    let retryTimer: ClusterTimer | undefined;

    async function connect(): Promise<void> {
      if (connecting || unsubscribes !== null || stopped) return;
      connecting = true;
      const done: Unsubscribe[] = [];
      try {
        for (const [channel, handler] of channels)
          done.push(await pubsub.subscribe(channel, handler));
        unsubscribes = done;
        attempts = 0;
        counted(kind, 'subscribed');
        hooks.subscribed();
      } catch {
        await Promise.all(done.map((u) => u().catch(() => undefined)));
        counted(kind, 'failed');
        attempts += 1;
        const ceiling = Math.min(SUBSCRIBE_RETRY_BASE_MS * 2 ** attempts, SUBSCRIBE_RETRY_MAX_MS);
        retryTimer = setTimer(
          () => {
            retryTimer = undefined;
            if (wanted) void connect();
          },
          Math.round(ceiling / 2 + (random() * ceiling) / 2),
        );
      } finally {
        connecting = false;
      }
      // Unwanted while subscribing, and its grace already ran out: leave now.
      if (!wanted && unsubscribes !== null && graceTimer === undefined) void leave();
    }

    async function leave(): Promise<void> {
      graceTimer?.cancel();
      retryTimer?.cancel();
      graceTimer = undefined;
      retryTimer = undefined;
      const current = unsubscribes;
      unsubscribes = null;
      if (current === null) return;
      await Promise.all(current.map((u) => u().catch(() => undefined)));
      counted(kind, 'unsubscribed');
      hooks.left();
    }

    const sub: Subscription = {
      want() {
        wanted = true;
        graceTimer?.cancel();
        graceTimer = undefined;
        void connect();
      },
      unwant(graceMs) {
        wanted = false;
        graceTimer?.cancel();
        graceTimer = setTimer(() => {
          graceTimer = undefined;
          if (!wanted) void leave();
        }, graceMs);
      },
      active: () => unsubscribes !== null,
      leave,
    };
    return sub;
  }

  /** Sends an ephemeral frame's text to the session's local connections (droppable). */
  function deliverEphemeral(sid: string, text: string): void {
    if (deps.onEphemeral?.(sid, text) === true) return;
    const room = deps.rooms.get(sid);
    if (room === undefined) return;
    for (const conn of room.connections()) {
      try {
        connectionSender(conn).send(text, { droppable: true });
      } catch {
        // One connection's failure is its own.
      }
    }
  }

  function sessionSub(sid: string): Subscription {
    let sub = sessionSubs.get(sid);
    if (sub === undefined) {
      sub = subscription(
        'session',
        [
          [framesChannel(sid), (m) => dispatcher.receive(sid, m)],
          [
            ephemeralChannel(sid),
            (m) => dispatcher.receiveEphemeral(sid, m, (t) => deliverEphemeral(sid, t)),
          ],
        ],
        {
          subscribed() {
            release.pin(sid);
            // Frames published before the subscription took hold are fetched from the buffer.
            dispatcher.reconcile(sid).catch(() => {
              metrics.counter('relay_cluster_reconcile_failed_total').inc();
            });
          },
          left() {
            release.unpin(sid);
            if (sessionSubs.get(sid) === sub && !(deps.rooms.get(sid)?.memberCount() ?? 0)) {
              sessionSubs.delete(sid);
            }
          },
        },
      );
      sessionSubs.set(sid, sub);
    }
    return sub;
  }

  /** Closes `mid`'s connections on this node that `cmd` names. */
  function applyLocally(mid: string, cmd: MemberCommand & { code: CloseCodeValue }): number {
    let closed = 0;
    for (const room of [...deps.rooms.rooms()]) {
      for (const conn of room.connectionsOf(mid)) {
        if (cmd.device !== undefined && conn.entry.deviceId !== cmd.device) continue;
        if (cmd.before !== undefined && conn.entry.createdAt.getTime() >= cmd.before) continue;
        closeConnection(conn, closeSpec(cmd));
        closed += 1;
      }
    }
    if (closed > 0) metrics.counter('relay_cluster_control_closed_total').inc(closed);
    return closed;
  }

  function onControl(mid: string, message: string): void {
    const parsed = parseControlMessage(message, mid);
    if (parsed === null) {
      metrics.counter('relay_cluster_received_total', { channel: 'ctl', result: 'invalid' }).inc();
      return;
    }
    if (parsed.node === nodeId) {
      metrics.counter('relay_cluster_received_total', { channel: 'ctl', result: 'own' }).inc();
      return;
    }
    metrics.counter('relay_cluster_received_total', { channel: 'ctl', result: 'applied' }).inc();
    applyLocally(mid, parsed.cmd as MemberCommand & { code: CloseCodeValue });
  }

  function memberSub(mid: string): Subscription {
    let sub = memberSubs.get(mid);
    if (sub === undefined) {
      sub = subscription('member', [[controlChannel(mid), (m) => onControl(mid, m)]], {
        subscribed: () => undefined,
        left() {
          if (memberSubs.get(mid) === sub && !memberConnections.has(mid)) memberSubs.delete(mid);
        },
      });
      memberSubs.set(mid, sub);
    }
    return sub;
  }

  deps.rooms.listen({
    joined(room, _conn, member) {
      if (stopped) return;
      sessionSub(room.sid).want();
      memberConnections.set(member.id, (memberConnections.get(member.id) ?? 0) + 1);
      memberSub(member.id).want();
    },
    left(room, _conn, member) {
      if (room.memberCount() === 0) sessionSubs.get(room.sid)?.unwant(config.unsubGraceMs);
      const left = (memberConnections.get(member.id) ?? 1) - 1;
      if (left > 0) {
        memberConnections.set(member.id, left);
      } else {
        memberConnections.delete(member.id);
        memberSubs.get(member.id)?.unwant(config.unsubGraceMs);
      }
    },
  });

  const memberControl: MemberControl = {
    async closeMember(memberId, cmd) {
      const checked = checkCommand(cmd);
      if (checked === null) throw new TypeError('closeMember: not a valid command');
      applyLocally(memberId, checked);
      try {
        await pubsub.publish(
          controlChannel(memberId),
          JSON.stringify({ node: nodeId, mid: memberId, cmd: checked }),
        );
        metrics.counter('relay_cluster_published_total', { channel: 'ctl' }).inc();
      } catch (err) {
        metrics.counter('relay_cluster_publish_failed_total', { channel: 'ctl' }).inc();
        throw err;
      }
    },
  };

  // Timers: the heartbeat, and the reconcile sweep.
  let heartbeatTimer: ClusterTimer | undefined;
  let reconcileTimer: ClusterTimer | undefined;
  const heartbeat = (): void => {
    if (stopped) return;
    deps.kv
      .set(
        nodeKey(nodeId),
        JSON.stringify({
          node: nodeId,
          sessions: sessionSubs.size,
          members: memberSubs.size,
          at: clock(),
        }),
        { ttlMs: HEARTBEAT_TTL_MS },
      )
      .catch(() => metrics.counter('relay_cluster_heartbeat_failed_total').inc());
    heartbeatTimer = setTimer(heartbeat, HEARTBEAT_EVERY_MS);
  };
  const sweep = (): void => {
    if (stopped) return;
    for (const [sid, sub] of sessionSubs) {
      if (!sub.active()) continue;
      dispatcher.reconcile(sid).catch(() => {
        metrics.counter('relay_cluster_reconcile_failed_total').inc();
      });
    }
    reconcileTimer = setTimer(sweep, config.reconcileMs);
  };
  heartbeat();
  if (config.reconcileMs > 0) reconcileTimer = setTimer(sweep, config.reconcileMs);

  return {
    nodeId,
    dispatcher,
    memberControl,
    welcomed(connection, admitted) {
      memberControl
        .closeMember(admitted.access.member.id, {
          code: CloseCode.Superseded,
          bye: 'superseded',
          device: admitted.dev,
          before: connection.entry.createdAt.getTime(),
        })
        .catch(() => undefined);
    },
    publishEphemeral: (sid, frame) => dispatcher.publishEphemeral(sid, frame),
    sessions: () => [...sessionSubs].filter(([, s]) => s.active()).map(([sid]) => sid),
    members: () => [...memberSubs].filter(([, s]) => s.active()).map(([mid]) => mid),
    async stop() {
      stopped = true;
      heartbeatTimer?.cancel();
      reconcileTimer?.cancel();
      await Promise.all([...sessionSubs.values(), ...memberSubs.values()].map((s) => s.leave()));
      await deps.kv.del(nodeKey(nodeId)).catch(() => undefined);
    },
  };
}
