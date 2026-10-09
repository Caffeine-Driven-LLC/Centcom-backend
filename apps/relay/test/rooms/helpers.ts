/**
 * Test helpers for the rooms (B043): fake connections that record what they are sent and how they
 * close, a membership source the test edits (the "database"), manual timers, frames from
 * `contracts/fixtures/events/`, the room side on those doubles, and a real relay running the
 * codec (10), the handshake (15, on an in-memory SessionAccess, with the rooms' join hook), the
 * authorise stage (20) and a recording stage at 50 that sees what would be sequenced.
 */
import { readFileSync } from 'node:fs';
import { createIdGenerator, EVENT_KINDS } from '@centcom/contracts';
import type { AuditEvent } from '@centcom/core';
import type { SessionAccessResult } from '../../src/handshake/access.js';
import { createHandshake } from '../../src/handshake/handshake.js';
import { JwksCache } from '../../src/handshake/jwks.js';
import codecModule from '../../src/codec/module.js';
import type { RelayModule } from '../../src/modules.js';
import type { FrameContext, RelayConnection } from '../../src/pipeline.js';
import { createRooms } from '../../src/rooms/authorise.js';
import { memoryMuteState, type SessionRole } from '../../src/rooms/kind-policy.js';
import {
  LiveMembership,
  type LiveMember,
  type MembershipSource,
} from '../../src/rooms/membership.js';
import { createRoomRegistry, type RoomTimer } from '../../src/rooms/registry.js';
import { connect, testRelay, until, type Client, type TestRelay } from '../helpers.js';
import {
  mintTicket,
  signingKey,
  stubJwks,
  TEST_HANDSHAKE_CONFIG,
  hello,
  type TicketInput,
} from '../handshake/helpers.js';

export const newId = createIdGenerator();
export { until };

/** A connection that records the frames sent to it and its close. */
export interface FakeConnection extends RelayConnection {
  sent: Record<string, unknown>[];
  closedWith: number | null;
}

let connSeq = 0;

/** A fake, authenticated connection of session `sid`. */
export function fakeConnection(sid: string | null = null): FakeConnection {
  const listeners: ((code: number) => void)[] = [];
  connSeq += 1;
  const conn: FakeConnection = {
    entry: {
      id: `c${connSeq}`,
      remoteHash: '0000000000000000',
      state: 'authenticated',
      sessionId: sid,
      memberId: null,
    deviceId: null,
      createdAt: new Date(0),
    },
    sent: [],
    closedWith: null,
    send(frame) {
      conn.sent.push(frame as Record<string, unknown>);
      return true;
    },
    close(code) {
      if (conn.closedWith !== null) return;
      conn.closedWith = code;
      conn.entry.state = 'closing';
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

/** A membership "database" the test edits, counting its reads. */
export function scriptedMembership() {
  const rows = new Map<string, LiveMember | null>();
  const state = { reads: 0, fail: false };
  const source: MembershipSource = {
    lookup(sid, mid) {
      state.reads += 1;
      if (state.fail) return Promise.reject(new Error('db down'));
      return Promise.resolve(rows.get(`${sid}:${mid}`) ?? null);
    },
  };
  const set = (sid: string, mid: string, value: LiveMember | null): void =>
    void rows.set(`${sid}:${mid}`, value);
  return { source, rows, state, set };
}

/** Timers the test runs by moving `now`. */
export function manualTimers(start = 0) {
  let now = start;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const setTimer = (fn: () => void, ms: number): RoomTimer => {
    const id = ++seq;
    pending.set(id, { at: now + ms, fn });
    return { cancel: () => void pending.delete(id) };
  };
  const advance = (ms: number): void => {
    const target = now + ms;
    for (;;) {
      const due = [...pending.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = target;
  };
  return { setTimer, advance, now: () => now, pending: () => pending.size };
}

/** A fixture frame of `kind` for session `sid`, as a client would send it. */
export function fixtureFrame(kind: string, sid: string): Record<string, unknown> {
  const url = new URL(`../../../../contracts/fixtures/events/${kind}.json`, import.meta.url);
  const { frame } = JSON.parse(readFileSync(url, 'utf8')) as { frame: Record<string, unknown> };
  // A client never sends the server-set fields.
  const client = Object.fromEntries(
    Object.entries(frame).filter(([key]) => key !== 'from' && key !== 'ts' && key !== 'seq'),
  );
  return { ...client, id: newId(kindPrefix(frame)), sid };
}

/** A fresh id of the fixture's own id kind (msg_, que_, ...). */
function kindPrefix(frame: Record<string, unknown>): 'msg' {
  const id = typeof frame['id'] === 'string' ? frame['id'] : 'msg_';
  return id.slice(0, 3) as 'msg';
}

/** Every catalogued kind. */
export const KINDS: readonly string[] = EVENT_KINDS;

/** The room side over in-memory doubles, with a clock the test moves. */
export function roomsHarness() {
  const clock = { now: 1_000_000 };
  const db = scriptedMembership();
  const membership = new LiveMembership({ source: db.source, clock: () => clock.now });
  const timers = manualTimers();
  const registry = createRoomRegistry({ setTimer: timers.setTimer });
  const mute = memoryMuteState();
  const audited: AuditEvent[] = [];
  const rooms = createRooms({
    registry,
    membership,
    mute,
    audit: { emitDetached: (e) => void audited.push(e) },
    setTimer: timers.setTimer,
  });
  const sid = newId('ses');
  const wsp = newId('wsp');

  /** Adds a member to the "database" and joins `conn` to the room through the hook. */
  async function admit(
    role: SessionRole,
    opts: {
      conn?: FakeConnection;
      mid?: string;
      user?: string;
      maxMembers?: number;
      session?: string;
    } = {},
  ) {
    const session = opts.session ?? sid;
    const conn = opts.conn ?? fakeConnection(session);
    const mid = opts.mid ?? newId('mem');
    const user = opts.user ?? newId('usr');
    if (!db.rows.has(`${session}:${mid}`)) {
      db.set(session, mid, { role, userId: user, workspaceId: wsp });
    }
    const decision = await rooms.onAdmitted(conn, {
      sid: session,
      dev: newId('dev'),
      access: {
        session: { state: 'live', maxMembers: opts.maxMembers ?? 50 },
        member: { id: mid, name: 'Alex', slot: 0, role },
        deviceRevoked: false,
        relayAccess: true,
      },
      lastSeq: null,
    });
    return { conn, mid, user, decision };
  }

  /** Runs `frame` from `conn` through the stage; true when it reached the next stage. */
  async function send(conn: FakeConnection, frame: Record<string, unknown>): Promise<boolean> {
    let passed = false;
    const fc: FrameContext = { connection: conn, raw: JSON.stringify(frame), frame, state: {} };
    await rooms.stage(fc, () => {
      passed = true;
      return Promise.resolve();
    });
    return passed;
  }

  return { clock, db, membership, timers, registry, mute, audited, rooms, sid, wsp, admit, send };
}

/** `sys.error` frames `conn` received. */
export const errorsOf = (conn: FakeConnection): Record<string, unknown>[] =>
  conn.sent.filter((f) => f['t'] === 'sys.error');

/**
 * A real relay: codec, the handshake over an in-memory SessionAccess plus the rooms' join hook,
 * the rooms' authorise stage, and a recorder at 50.
 */
export async function roomsRelay(): Promise<{
  relay: TestRelay;
  harness: ReturnType<typeof roomsHarness>;
  passed: Record<string, unknown>[];
  join(
    role: SessionRole,
    opts?: { mid?: string; maxMembers?: number; state?: SessionAccessResult['session']['state'] },
  ): Promise<{
    client: Client;
    ticket: TicketInput;
    welcome: Record<string, unknown> | undefined;
  }>;
  stop(): Promise<void>;
}> {
  const harness = roomsHarness();
  const key = signingKey();
  const jwks = stubJwks([key.jwk]);
  const records = new Map<string, SessionAccessResult>();
  const passed: Record<string, unknown>[] = [];
  const module: RelayModule = {
    name: 'test-rooms',
    order: 15,
    register(ctx) {
      const handshake = createHandshake({
        config: TEST_HANDSHAKE_CONFIG,
        jwks: new JwksCache({ url: TEST_HANDSHAKE_CONFIG.jwksUrl, fetch: jwks.fetcher }),
        kv: ctx.redis.kv,
        access: {
          resolve: (sid, mid, dev) => Promise.resolve(records.get(`${sid}:${mid}:${dev}`) ?? null),
        },
        registry: ctx.connections,
        onAdmitted: harness.rooms.onAdmitted,
      });
      ctx.pipeline.use(15, handshake.stage);
      ctx.pipeline.use(20, harness.rooms.stage);
      ctx.pipeline.use(50, async (fc) => {
        passed.push(fc.frame as Record<string, unknown>);
      });
      ctx.onConnection(handshake.onConnection);
      return undefined;
    },
  };
  const relay = await testRelay({ modules: [codecModule, module] });
  return {
    relay,
    harness,
    passed,
    async join(role, opts = {}) {
      const ticket: TicketInput = {
        sid: harness.sid,
        mid: opts.mid ?? newId('mem'),
        // The ticket claims host; the live record decides.
        role: 'host',
        dev: newId('dev'),
        caps: ['resume'],
      };
      if (!harness.db.rows.has(`${ticket.sid}:${ticket.mid}`)) {
        harness.db.set(ticket.sid, ticket.mid, {
          role,
          userId: newId('usr'),
          workspaceId: harness.wsp,
        });
      }
      records.set(`${ticket.sid}:${ticket.mid}:${ticket.dev}`, {
        session: { state: opts.state ?? 'live', maxMembers: opts.maxMembers ?? 12 },
        member: { id: ticket.mid, name: 'Alex', slot: 0, role },
        deviceRevoked: false,
        relayAccess: true,
      });
      const client = connect(relay.url);
      await client.opened;
      client.ws.send(JSON.stringify(hello(await mintTicket(key, ticket))));
      await until(
        () => client.messages.some((m) => m['t'] === 'sys.welcome' || m['t'] === 'sys.error'),
        3_000,
      );
      return { client, ticket, welcome: client.messages.find((m) => m['t'] === 'sys.welcome') };
    },
    stop: () => relay.stop(),
  };
}
