/**
 * Test helpers for session control (B051): `controlUnit()` wires, as the modules do, B043's
 * authorise stage (20), the control stage (38), B041's sequencing (40), B049's rotation stage (41)
 * and B044's fan-out (50), over in-memory fakes of the lane's ports:
 *
 * - `db`: the session's member records (the MembershipPort and B043's live membership read them);
 * - `sessions`: session states (SessionStatePort);
 * - `sequencer`: B044's `emitServer` and B049's `rotate`, which a test can make fail;
 * - the mutes and policies in memory, the audit events and metrics recorded.
 *
 * `member(role)` connects a member (in the room, sequencing on); `send` runs a frame through the
 * stages and returns the stored frame when it was sequenced.
 */
import { readFileSync } from 'node:fs';
import { newId } from '@centcom/contracts';
import { createMemoryRedis, type AuditEvent } from '@centcom/core';
import { createConnections } from '../../src/control/connections.js';
import { createControlHandler, type ControlDeps } from '../../src/control/handler.js';
import { createMemoryMuteStore, createMuteRegistry } from '../../src/control/mute-registry.js';
import { createMemoryPolicyStore } from '../../src/control/policy-store.js';
import type {
  MembershipPort,
  SequencerPort,
  SessionState,
  SessionStatePort,
} from '../../src/control/ports.js';
import { isClientControlKind } from '../../src/control/authority.js';
import { controlStage } from '../../src/control/stage.js';
import { rotateStage } from '../../src/keys/stage.js';
import type { RelayConnection } from '../../src/pipeline.js';
import { createRooms } from '../../src/rooms/authorise.js';
import type { SessionRole } from '../../src/rooms/kind-policy.js';
import { LiveMembership, type LiveMember } from '../../src/rooms/membership.js';
import { SEQUENCED_STATE_KEY, type StoredFrame } from '../../src/seq/types.js';
import { textConnection, type TextConnection } from '../fanout/helpers.js';
import { CT, keysUnit } from '../keys/helpers.js';

const FIXTURES = new URL('../../../../contracts/fixtures/events/', import.meta.url);

/** The `frame` of fixture `control.<name>.json`. */
export function fixture(kind: string): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(new URL(`${kind}.json`, FIXTURES), 'utf8')) as {
    frame: Record<string, unknown>;
  };
  return doc.frame;
}

interface Row {
  role: SessionRole;
  userId: string;
  workspaceId: string | null;
  left: boolean;
}

/** The member records, as `session_members` would hold them. */
export function memoryMembers() {
  const rows = new Map<string, Row>();
  const key = (sid: string, mid: string) => `${sid}:${mid}`;
  const state = { failing: false };
  const live = (sid: string, mid: string): LiveMember | null => {
    const row = rows.get(key(sid, mid));
    return row === undefined || row.left
      ? null
      : { role: row.role, userId: row.userId, workspaceId: row.workspaceId };
  };
  const guard = () => {
    if (state.failing) throw new Error('db down');
  };
  const port: MembershipPort = {
    get: (sid, mid) => {
      guard();
      return Promise.resolve(live(sid, mid));
    },
    remove(sid, mid) {
      guard();
      const row = rows.get(key(sid, mid));
      if (row === undefined || row.left || row.role === 'host') return Promise.resolve(false);
      row.left = true;
      return Promise.resolve(true);
    },
    restore(sid, mid) {
      const row = rows.get(key(sid, mid));
      if (row !== undefined) row.left = false;
      return Promise.resolve();
    },
    setRole(sid, mid, role) {
      guard();
      const row = rows.get(key(sid, mid));
      if (row === undefined || row.left || row.role === 'host') return Promise.resolve(false);
      row.role = role;
      return Promise.resolve(true);
    },
    transferHost(sid, from, to) {
      guard();
      const a = rows.get(key(sid, from));
      const b = rows.get(key(sid, to));
      if (a?.role !== 'host' || a.left || b?.role !== 'editor' || b.left) {
        return Promise.resolve(false);
      }
      a.role = 'editor';
      b.role = 'host';
      return Promise.resolve(true);
    },
    members(sid) {
      return Promise.resolve(
        [...rows]
          .filter(([k, r]) => k.startsWith(`${sid}:`) && !r.left)
          .map(([k]) => k.slice(sid.length + 1)),
      );
    },
  };
  return {
    rows,
    state,
    port,
    source: {
      lookup: (sid: string, mid: string) => {
        guard();
        return Promise.resolve(live(sid, mid));
      },
    },
    set(sid: string, mid: string, row: Omit<Row, 'left'>) {
      rows.set(key(sid, mid), { ...row, left: false });
    },
    /** The record of `mid` (it must exist). */
    row(sid: string, mid: string): Row {
      const row = rows.get(key(sid, mid));
      if (row === undefined) throw new Error('no such member');
      return row;
    },
    role: (sid: string, mid: string) => rows.get(key(sid, mid))?.role,
    left: (sid: string, mid: string) => rows.get(key(sid, mid))?.left ?? true,
  };
}

/** Session states in memory. */
export function memorySessions(): SessionStatePort & { states: Map<string, SessionState> } {
  const states = new Map<string, SessionState>();
  return {
    states,
    end(sid) {
      const previous = states.get(sid) ?? 'live';
      if (previous === 'ended' || previous === 'expired') return Promise.resolve(null);
      states.set(sid, 'ended');
      return Promise.resolve(previous);
    },
    restore(sid, previous) {
      states.set(sid, previous);
      return Promise.resolve();
    },
  };
}

/** The relay's frame path around the control stage, on in-memory fakes. */
export function controlUnit(opts: { handler?: Partial<ControlDeps> } = {}) {
  const k = keysUnit();
  const clock = { now: 1_800_000_000_000 };
  const db = memoryMembers();
  const membership = new LiveMembership({ source: db.source, clock: () => clock.now });
  const muteStore = createMemoryMuteStore();
  const mutes = createMuteRegistry({ store: muteStore, clock: () => clock.now });
  const policies = createMemoryPolicyStore();
  const sessions = memorySessions();
  const audited: AuditEvent[] = [];
  const failures = { emit: false, rotate: false };
  const sequencer: SequencerPort = {
    async emit(sid, frame) {
      if (failures.emit) throw new Error('sequencer down');
      return (await k.fanout.emitServer(sid, frame.kind, frame.t, frame.p)).seq;
    },
    async emitWithRotation(sid, memberLeft) {
      if (failures.rotate) throw new Error('sequencer down');
      const r = await k.epochs.rotate(sid, 'member_removed', { after: memberLeft });
      return { seqs: [r.seq - 1, r.seq], kid: r.kid };
    },
  };
  const connections = createConnections({
    rooms: k.rooms,
    kv: createMemoryRedis().kv,
    membership,
    cluster: () => undefined,
  });
  connections.start();
  const handler = createControlHandler({
    membership: db.port,
    sessions,
    sequencer,
    connections,
    mutes,
    policies,
    audit: { emitDetached: (e) => void audited.push(e) },
    onEnded: (sid) => mutes.forget(sid),
    clock: () => clock.now,
    metrics: k.recorded.metrics,
    logger: k.log.logger,
    ...opts.handler,
  });
  const rooms = createRooms({
    registry: k.rooms,
    membership,
    mute: mutes,
    audit: { emitDetached: (e) => void audited.push(e) },
    onDenied(denial) {
      if (!isClientControlKind(denial.kind)) return false;
      handler.auditDenied(
        denial.sid,
        {
          id: denial.member.id,
          userId: denial.member.userId,
          workspaceId: denial.member.workspaceId,
        },
        denial.kind,
        (denial.frame as { p?: unknown }).p,
      );
      return true;
    },
    metrics: k.recorded.metrics,
  });
  const control = controlStage({ handler, rooms: k.rooms });
  const rotate = rotateStage({ epochs: k.epochs });
  const wsp = newId('wsp');

  /** A connected member of role `role` (a new one, or `mid`'s further device). */
  function member(
    role: SessionRole = 'editor',
    opts: { mid?: string; connected?: boolean } = {},
  ): { conn: TextConnection; mid: string; userId: string } {
    const mid = opts.mid ?? newId('mem');
    const userId = db.rows.get(`${k.sid}:${mid}`)?.userId ?? newId('usr');
    if (!db.rows.has(`${k.sid}:${mid}`)) db.set(k.sid, mid, { role, userId, workspaceId: wsp });
    const conn = textConnection(k.registry, k.sid, mid);
    conn.entry.deviceId = newId('dev');
    if (opts.connected !== false) {
      k.rooms.getOrCreate(k.sid).join(conn, {
        id: mid,
        sid: k.sid,
        role,
        userId,
        workspaceId: wsp,
        name: 'M',
        slot: 0,
      });
      conn.onClose(() => k.rooms.locate(conn)?.room.leave(conn));
      k.sequencer.onConnection(conn);
    }
    return { conn, mid, userId };
  }

  /** Whether the last frame `send` ran got past every stage (sequenced or not). */
  const last = { reached: false };

  /** Runs `frame` through the stages; the stored frame when it was sequenced. */
  async function send(
    conn: RelayConnection,
    frame: Record<string, unknown>,
  ): Promise<StoredFrame | undefined> {
    const fc = {
      connection: conn,
      raw: JSON.stringify(frame),
      frame,
      state: {} as Record<string, unknown>,
    };
    last.reached = false;
    await rooms.stage(fc, () =>
      control(fc, () =>
        k.sequencer.stage(fc, () =>
          rotate(fc, () =>
            k.fanout.stage(fc, () => {
              last.reached = true;
              return Promise.resolve();
            }),
          ),
        ),
      ),
    );
    return fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined;
  }

  /** A client control frame of `kind` with `p`. */
  const ctl = (kind: string, p: Record<string, unknown>, id = newId('msg')) => ({
    v: 1,
    t: 'control',
    id,
    sid: k.sid,
    k: kind,
    p,
  });

  /** An encrypted event frame. */
  const event = () => ({
    v: 1,
    t: 'event',
    id: newId('msg'),
    sid: k.sid,
    k: 'message.user',
    ct: CT('k1'),
    sig: 's'.repeat(86),
  });

  /** A queue frame. */
  const queue = () => ({
    v: 1,
    t: 'queue',
    id: newId('que'),
    sid: k.sid,
    k: 'queue.cancel',
    p: { item: newId('que') },
  });

  /** A presence frame. */
  const presence = () => ({
    v: 1,
    t: 'presence',
    sid: k.sid,
    k: 'presence.update',
    p: { status: 'online', activity: 'idle' },
  });

  /** The problems of the `sys.error` frames `conn` received. */
  const errorsOf = (conn: TextConnection) =>
    conn
      .frames()
      .filter((f) => f['t'] === 'sys.error')
      .map((f) => f['p'] as Record<string, unknown>);

  /** Every frame in the hot buffer, in `seq` order. */
  const sequenced = async (): Promise<StoredFrame[]> => k.store.range(k.sid, 0, 1_000);

  /** The audit events of `action`. */
  const events = (action?: string) =>
    audited.filter((e) => action === undefined || e.action === action);

  return {
    ...k,
    clock,
    db,
    membership,
    muteStore,
    mutes,
    policies,
    sessions,
    audited,
    failures,
    connections,
    handler,
    roomSide: rooms,
    last,
    rooms: k.rooms,
    wsp,
    member,
    send,
    ctl,
    event,
    queue,
    presence,
    errorsOf,
    sequenced,
    events,
  };
}
