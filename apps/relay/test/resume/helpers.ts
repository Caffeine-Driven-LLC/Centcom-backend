/**
 * Test helpers for resume (B042):
 *
 * - `memoryLog()`: an in-memory durable log, both B041's DurableAppend port and the
 *   DurableLogReader (contiguous reads from the earliest retained frame, as B055's store), with
 *   `failing` and `drop(sid, upTo)` (retention);
 * - `resumeUnit()`: sequencing (in-memory store), rooms, fan-out (echo and resend echo delegated),
 *   the hydrator and the resumer, wired as the modules wire them. `connect(lastSeq)` goes through
 *   the handshake's hooks in its order (hold, room join, prepare, welcome, start); `seed(n)`
 *   sequences `n` frames straight into the store and the log; `send` runs a client frame through
 *   sequencing and fan-out; `settled(conn)` waits until the connection's resume ended;
 * - `slowConnection()`: a connection whose outbound buffer fills with what it is sent and drains a
 *   fixed number of bytes per wait, recording the most it ever held.
 */
import { newId } from '@centcom/contracts';
import { ConnectionRegistry } from '../../src/connection-registry.js';
import { createFanOut } from '../../src/fanout/fanout.js';
import type { AdmittedHello } from '../../src/handshake/handshake.js';
import type { RelayConnection } from '../../src/pipeline.js';
import { createHydrator } from '../../src/resume/hydrate.js';
import { createResumer, type ResumerDeps } from '../../src/resume/resume.js';
import { noSnapshots, type DurableLogReader, type SnapshotLookup } from '../../src/resume/types.js';
import { createRoomRegistry } from '../../src/rooms/registry.js';
import { stampFrame, withSeq } from '../../src/seq/frame.js';
import { createMemorySeqStore } from '../../src/seq/memory-store.js';
import { createSequencer } from '../../src/seq/stage.js';
import {
  SEQUENCED_STATE_KEY,
  type BufferLimits,
  type DurableAppend,
  type StoredFrame,
} from '../../src/seq/types.js';
import {
  manualTimers,
  reactionFrame,
  textConnection,
  type TextConnection,
} from '../fanout/helpers.js';
import { LIMITS, reaction, T0 } from '../seq/helpers.js';

export { newId, reactionFrame, T0, textConnection, type TextConnection };

/** An in-memory durable log. */
export interface MemoryLog extends DurableLogReader, DurableAppend {
  /** Reads and appends fail while true. */
  failing: boolean;
  frames(sid: string): StoredFrame[];
  /** Forgets the session's frames up to `upTo` (retention). */
  drop(sid: string, upTo: number): void;
  reads: number;
}

export function memoryLog(): MemoryLog {
  const sessions = new Map<string, Map<number, StoredFrame>>();
  const of = (sid: string): Map<number, StoredFrame> => {
    let s = sessions.get(sid);
    if (s === undefined) {
      s = new Map();
      sessions.set(sid, s);
    }
    return s;
  };
  const log: MemoryLog = {
    failing: false,
    reads: 0,
    append(sid, frame) {
      if (log.failing) return Promise.reject(new Error('log down'));
      of(sid).set(frame.seq, frame);
      return Promise.resolve();
    },
    range(sid, afterSeq, limit) {
      log.reads += 1;
      if (log.failing) return Promise.reject(new Error('log down'));
      const s = of(sid);
      const earliest = Math.min(...s.keys());
      const out: StoredFrame[] = [];
      for (let seq = Math.max(afterSeq + 1, earliest); out.length < limit; seq += 1) {
        const f = s.get(seq);
        if (f === undefined) break;
        out.push(f);
      }
      return Promise.resolve(out);
    },
    maxSeq(sid) {
      if (log.failing) return Promise.reject(new Error('log down'));
      const s = of(sid);
      return Promise.resolve(s.size === 0 ? 0 : Math.max(...s.keys()));
    },
    frames: (sid) => [...of(sid).values()].sort((a, b) => a.seq - b.seq),
    drop(sid, upTo) {
      for (const seq of [...of(sid).keys()]) if (seq <= upTo) of(sid).delete(seq);
    },
  };
  return log;
}

/** Snapshots the test sets. */
export function snapshotsAt(seq: number | null): SnapshotLookup & { seq: number | null } {
  const lookup = { seq, latestSeq: () => Promise.resolve(lookup.seq) };
  return lookup;
}

/** Parsed frames a connection received. */
export const framesOf = (conn: TextConnection): Record<string, unknown>[] => conn.frames();

/** Received sequenced seqs, in arrival order. */
export const seqsOf = (conn: TextConnection): number[] => conn.seqs();

/** The `sys.resumed` payloads a connection received. */
export const resumedOf = (conn: TextConnection): Record<string, unknown>[] =>
  conn
    .frames()
    .filter((f) => f['t'] === 'sys.resumed')
    .map((f) => f['p'] as Record<string, unknown>);

/** Sequencing, rooms, fan-out, hydration and resume over in-memory parts. */
export function resumeUnit(
  options: {
    limits?: BufferLimits;
    log?: MemoryLog;
    snapshots?: SnapshotLookup;
    resumer?: Partial<ResumerDeps>;
    hydrateFrames?: number;
    sid?: string;
  } = {},
) {
  const limits = options.limits ?? LIMITS;
  const registry = new ConnectionRegistry({ max: 1_000_000 });
  const rooms = createRoomRegistry();
  const store = createMemorySeqStore(limits);
  const log = options.log ?? memoryLog();
  let now = T0;
  const sequencer = createSequencer({
    store,
    rate: 1_000_000,
    burst: 1_000_000,
    clock: () => now,
    durable: log,
  });
  const timers = manualTimers();
  const fanout = createFanOut({
    rooms,
    seq: sequencer.service,
    clock: () => now,
    setTimer: timers.setTimer,
  });
  sequencer.service.delegateEcho((conn, frame) => fanout.sendTo(conn, frame));
  const hydrator = createHydrator({
    store,
    durable: log,
    frames: options.hydrateFrames ?? 5_000,
    maxBufferFrames: limits.maxFrames,
    clock: () => now,
  });
  sequencer.service.setReadiness(hydrator.ready);
  const resumer = createResumer({
    store,
    durable: log,
    snapshots: options.snapshots ?? noSnapshots,
    hydrator,
    fanout: () => fanout,
    batch: 100,
    maxFrames: 50_000,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    ...options.resumer,
  });
  const sid = options.sid ?? newId('ses');
  const seeder = newId('mem');

  /** Puts a connection in the room (as B043's `onAdmitted`). */
  function joinRoom(conn: RelayConnection, member: string, session: string): void {
    rooms.getOrCreate(session).join(conn, {
      id: member,
      sid: session,
      role: 'editor',
      userId: newId('usr'),
      workspaceId: null,
      name: 'M',
      slot: 0,
    });
    conn.onClose(() => rooms.locate(conn)?.room.leave(conn));
    sequencer.onConnection(conn);
  }

  /** A member connecting with `lastSeq`, through the handshake's hooks; its `welcome.resume`. */
  async function connect(
    lastSeq: number | null,
    opts: { conn?: TextConnection; session?: string; member?: string } = {},
  ): Promise<{ conn: TextConnection; welcome: object | null }> {
    const session = opts.session ?? sid;
    const member = opts.member ?? newId('mem');
    const conn = opts.conn ?? textConnection(registry, session, member);
    resumer.hold(conn);
    joinRoom(conn, member, session);
    const admitted: AdmittedHello = {
      sid: session,
      dev: newId('dev'),
      access: {
        session: { state: 'live', maxMembers: 50 },
        member: { id: member, name: 'M', slot: 0, role: 'editor' },
        deviceRevoked: false,
        relayAccess: true,
      },
      lastSeq,
    };
    const welcome = await resumer.prepare(conn, admitted);
    conn.send({ v: 1, t: 'sys.welcome', p: { resume: welcome } });
    resumer.start(conn);
    return { conn, welcome };
  }

  /** A member already connected (no resume), in the room. */
  function join(session = sid, member = newId('mem')): TextConnection {
    const conn = textConnection(registry, session, member);
    joinRoom(conn, member, session);
    return conn;
  }

  /** Sequences `n` frames into the store and the log (history before anyone connects). */
  async function seed(n: number, session = sid): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      const id = newId('msg');
      const frame = stampFrame(
        { t: 'event', id, k: 'reaction', p: reaction() },
        seeder,
        new Date(now).toISOString(),
        session,
      );
      const result = await store.assign(session, { from: seeder, id }, frame, now);
      await log.append(session, withSeq(frame, result.seq));
    }
  }

  /** Runs `frame` from `conn` through sequencing and fan-out. */
  async function send(
    conn: RelayConnection,
    frame: Record<string, unknown> = reactionFrame(conn.entry.sessionId ?? sid),
  ): Promise<StoredFrame | undefined> {
    const fc = {
      connection: conn,
      raw: JSON.stringify(frame),
      frame,
      state: {} as Record<string, unknown>,
    };
    await sequencer.stage(fc, () =>
      resumer.stage(fc, () => fanout.stage(fc, () => Promise.resolve())),
    );
    return fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined;
  }

  /** Waits until `conn`'s resume ended. */
  async function settled(conn: RelayConnection, maxTurns = 1_000_000): Promise<void> {
    for (let i = 0; i < maxTurns && resumer.busy(conn); i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (resumer.busy(conn)) throw new Error('the resume did not end');
  }

  return {
    registry,
    rooms,
    store,
    log,
    sequencer,
    fanout,
    hydrator,
    resumer,
    timers,
    sid,
    connect,
    join,
    seed,
    send,
    settled,
    advance: (ms: number) => void (now += ms),
  };
}

/** A connection whose outbound buffer fills on send and drains `drainBytes` per `drain()`. */
export function slowConnection(
  registry: ConnectionRegistry,
  sid: string,
  drainBytes: number,
): TextConnection & { buffered: number; maxBuffered: number; drain(): void } {
  const conn = textConnection(registry, sid) as TextConnection & {
    buffered: number;
    maxBuffered: number;
    drain(): void;
  };
  conn.buffered = 0;
  conn.maxBuffered = 0;
  const sendText = conn.sendText?.bind(conn);
  conn.sendText = (text) => {
    const ok = sendText?.(text) ?? false;
    if (ok) {
      conn.buffered += Buffer.byteLength(text, 'utf8');
      conn.maxBuffered = Math.max(conn.maxBuffered, conn.buffered);
    }
    return ok;
  };
  conn.bufferedBytes = () => conn.buffered;
  conn.drain = () => {
    conn.buffered = Math.max(0, conn.buffered - drainBytes);
  };
  return conn;
}
