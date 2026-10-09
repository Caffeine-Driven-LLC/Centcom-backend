/**
 * Test helpers for fan-out (B044):
 *
 * - `textConnection()`: a connection double that records the exact text it is sent (`sendText`),
 *   can be closed, and can be made to throw;
 * - `fanoutUnit()`: B041's stage over the in-memory store, B043's room registry and this lane's
 *   fan-out, wired as the modules wire them (echo delegated), with `join` (a member's connection,
 *   welcomed and in the room) and `send` (a client frame through sequencing and fan-out);
 * - `manualTimers()` for OrderedRelease's 250 ms.
 */
import { newId } from '@centcom/contracts';
import { ConnectionRegistry } from '../../src/connection-registry.js';
import { createFanOut, type FanOutDeps } from '../../src/fanout/fanout.js';
import type { RelayConnection } from '../../src/pipeline.js';
import { createRoomRegistry, type RoomRegistry } from '../../src/rooms/registry.js';
import { createMemorySeqStore, type MemorySeqStore } from '../../src/seq/memory-store.js';
import { createSequencer, type Sequencer } from '../../src/seq/stage.js';
import { SEQUENCED_STATE_KEY, type DurableAppend, type StoredFrame } from '../../src/seq/types.js';
import { LIMITS, T0 } from '../seq/helpers.js';

export { newId, T0 };

/** A connection double recording raw texts. */
export interface TextConnection extends RelayConnection {
  texts: string[];
  /** Parsed frames received. */
  frames(): Record<string, unknown>[];
  /** Received `seq`s of sequenced frames. */
  seqs(): number[];
  closedWith: number | null;
  /** Makes `sendText` throw. */
  failing: boolean;
}

/** A connection of session `sid`, member `member`, as the handshake leaves it. */
export function textConnection(
  registry: ConnectionRegistry,
  sid: string,
  member: string = newId('mem'),
): TextConnection {
  const entry = registry.add('127.0.0.1');
  entry.state = 'authenticated';
  entry.sessionId = sid;
  entry.memberId = member;
  const listeners: ((code: number) => void)[] = [];
  const conn: TextConnection = {
    entry,
    texts: [],
    closedWith: null,
    failing: false,
    frames: () => conn.texts.map((t) => JSON.parse(t) as Record<string, unknown>),
    seqs: () =>
      conn
        .frames()
        .filter((f) => typeof f['seq'] === 'number')
        .map((f) => f['seq'] as number),
    send(frame) {
      return conn.sendText?.(JSON.stringify(frame)) ?? false;
    },
    sendText(text) {
      if (conn.failing) throw new Error('socket exploded');
      if (conn.closedWith !== null) return false;
      conn.texts.push(text);
      return true;
    },
    bufferedBytes: () => 0,
    close(code) {
      if (conn.closedWith !== null) return;
      conn.closedWith = code;
      entry.state = 'closing';
      registry.remove(entry.id);
      for (const l of listeners.splice(0)) l(code);
    },
    terminate() {
      conn.close(1006 as never);
    },
    onClose(listener) {
      if (conn.closedWith !== null) listener(conn.closedWith);
      else listeners.push(listener);
    },
  };
  return conn;
}

/** Timers the test runs. */
export function manualTimers() {
  const pending: { fn: () => void; ms: number; live: boolean }[] = [];
  return {
    pending,
    setTimer(fn: () => void, ms: number) {
      const t = { fn, ms, live: true };
      pending.push(t);
      return { cancel: () => void (t.live = false) };
    },
    fire() {
      for (const t of pending.splice(0)) if (t.live) t.fn();
    },
  };
}

/** Sequencing, rooms and fan-out over in-memory parts, wired as the modules wire them. */
export function fanoutUnit(
  options: { durable?: DurableAppend; fanout?: Partial<FanOutDeps>; rate?: number } = {},
) {
  const registry = new ConnectionRegistry({ max: 1_000_000 });
  const rooms: RoomRegistry = createRoomRegistry();
  const store: MemorySeqStore = createMemorySeqStore(LIMITS);
  const sequencer: Sequencer = createSequencer({
    store,
    rate: options.rate ?? 1_000_000,
    burst: options.rate ?? 1_000_000,
    clock: () => T0,
    ...(options.durable === undefined ? {} : { durable: options.durable }),
  });
  const timers = manualTimers();
  const fanout = createFanOut({
    rooms,
    seq: sequencer.service,
    clock: () => T0 + 1,
    setTimer: timers.setTimer,
    ...options.fanout,
  });
  sequencer.service.delegateEcho();
  const sid = newId('ses');

  function join(session = sid, member = newId('mem')): TextConnection {
    const conn = textConnection(registry, session, member);
    rooms.getOrCreate(session).join(conn, {
      id: member,
      sid: session,
      role: 'editor',
      userId: newId('usr'),
      workspaceId: null,
      name: 'M',
      slot: 0,
    });
    sequencer.onConnection(conn);
    return conn;
  }

  /** Runs `frame` from `conn` through sequencing and fan-out; the stored frame, if sequenced. */
  async function send(
    conn: TextConnection,
    frame: Record<string, unknown>,
  ): Promise<StoredFrame | undefined> {
    const fc = {
      connection: conn,
      raw: JSON.stringify(frame),
      frame,
      state: {} as Record<string, unknown>,
    };
    await sequencer.stage(fc, () => fanout.stage(fc, () => Promise.resolve()));
    return fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined;
  }

  return { registry, rooms, store, sequencer, fanout, timers, sid, join, send };
}

/** A client reaction frame of `sid` (as the codec leaves it). */
export const reactionFrame = (sid: string, extra: Record<string, unknown> = {}) => ({
  v: 1,
  t: 'event',
  id: newId('msg'),
  sid,
  k: 'reaction',
  p: { target: newId('msg'), code: 'thumbs', op: 'add' },
  ...extra,
});
