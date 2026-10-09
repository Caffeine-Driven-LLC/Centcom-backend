/**
 * Resume on a running relay (B042, end to end; acceptance 1, 5 and 7, CT-RESUME "Flow" 1-3): B011
 * SimClients over real sockets through the codec, the handshake (B043's room join, this lane's
 * hooks), B041's sequencing (in-memory store), this lane's stage and B044's fan-out.
 *
 * - A client that has 1040 when the head is 1100 reconnects with `last_seq: 1040`: the welcome
 *   (`resume {from_seq: 1041, to_seq: 1100}`), 1041..1100 on the wire once each and in order, then
 *   `sys.resumed {from_seq: 1041, to_seq: 1100, count: 60}`, then the frames sent during the replay.
 * - A SimClient that drops and `reconnect()`s resumes from its own contiguous `last_seq`.
 * - A member whose membership was revoked meanwhile is closed 4403 by the handshake and gets no
 *   frame; a session whose recovery fails is refused 4503.
 * - 5 000 frames replay over a socket within 2 s.
 * - After `snapshot_required`, `sys.resume {last_seq: S}` replays S+1..head (Flow 3b).
 * - What the relay sends (`sys.welcome` with `resume`, both `sys.resumed` shapes) is a valid
 *   envelope.
 */
import { newId, validate } from '@centcom/contracts';
import { createManualClock, SimClient, SimCloseError } from '@centcom/testkit/sim';
import { afterEach, describe, expect, it } from 'vitest';
import codecModule from '../../src/codec/module.js';
import { createFanOut } from '../../src/fanout/fanout.js';
import { createHandshake } from '../../src/handshake/handshake.js';
import { JwksCache } from '../../src/handshake/jwks.js';
import type { RelayModule } from '../../src/modules.js';
import { createHydrator } from '../../src/resume/hydrate.js';
import { createResumer } from '../../src/resume/resume.js';
import type { SnapshotLookup } from '../../src/resume/types.js';
import { createRoomRegistry } from '../../src/rooms/registry.js';
import { stampFrame, withSeq } from '../../src/seq/frame.js';
import { createMemorySeqStore } from '../../src/seq/memory-store.js';
import { createSequencer } from '../../src/seq/stage.js';
import type { BufferLimits } from '../../src/seq/types.js';
import {
  memoryAccess,
  mintTicket,
  signingKey,
  stubJwks,
  TEST_HANDSHAKE_CONFIG,
  ticketFor,
} from '../handshake/helpers.js';
import { testRelay, until, type TestRelay } from '../helpers.js';
import { LIMITS, reaction } from '../seq/helpers.js';
import { memoryLog, snapshotsAt } from './helpers.js';

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

async function resumeRelay(opts: { limits?: BufferLimits; snapshots?: SnapshotLookup } = {}) {
  const key = signingKey();
  const jwks = stubJwks([key.jwk]);
  const access = memoryAccess();
  const rooms = createRoomRegistry();
  const store = createMemorySeqStore(opts.limits ?? LIMITS);
  const log = memoryLog();
  const sid = newId('ses');
  const modules: RelayModule[] = [
    codecModule,
    {
      name: 'handshake',
      order: 15,
      register(ctx) {
        const handshake = createHandshake({
          config: TEST_HANDSHAKE_CONFIG,
          jwks: new JwksCache({ url: TEST_HANDSHAKE_CONFIG.jwksUrl, fetch: jwks.fetcher }),
          kv: ctx.redis.kv,
          access,
          registry: ctx.connections,
          onAdmitted: (conn, admitted) => {
            rooms.getOrCreate(admitted.sid).join(conn, {
              id: admitted.access.member.id,
              sid: admitted.sid,
              role: admitted.access.member.role,
              userId: newId('usr'),
              workspaceId: null,
              name: 'M',
              slot: 0,
            });
            conn.onClose(() => rooms.locate(conn)?.room.leave(conn));
            return { ok: true };
          },
          resume: () => ctx.resume,
        });
        ctx.pipeline.use(15, handshake.stage);
        ctx.onConnection(handshake.onConnection);
        return undefined;
      },
    },
    {
      name: 'seq',
      order: 40,
      register(ctx) {
        const sequencer = createSequencer({
          store,
          rate: 100_000,
          burst: 100_000,
          clock: ctx.clock,
          durable: log,
        });
        ctx.pipeline.use(40, sequencer.stage);
        ctx.onConnection(sequencer.onConnection);
        ctx.seq = sequencer.service;
        return undefined;
      },
    },
    {
      name: 'resume',
      order: 45,
      register(ctx) {
        const seq = ctx.seq;
        if (seq === undefined) throw new Error('no seq');
        const hydrator = createHydrator({
          store: seq.store,
          durable: log,
          frames: 5_000,
          maxBufferFrames: LIMITS.maxFrames,
        });
        seq.setReadiness(hydrator.ready);
        const resumer = createResumer({
          store: seq.store,
          durable: log,
          snapshots: opts.snapshots ?? snapshotsAt(null),
          hydrator,
          fanout: () => ctx.fanout,
          batch: 100,
          maxFrames: 50_000,
        });
        ctx.pipeline.use(45, resumer.stage);
        ctx.resume = resumer;
        return undefined;
      },
    },
    {
      name: 'fanout',
      order: 50,
      register(ctx) {
        const seq = ctx.seq;
        if (seq === undefined) throw new Error('no seq');
        const fanout = createFanOut({ rooms, seq, clock: ctx.clock });
        seq.delegateEcho((conn, frame) => fanout.sendTo(conn, frame));
        ctx.pipeline.use(50, fanout.stage);
        ctx.fanout = fanout;
        return undefined;
      },
    },
  ];
  const relay: TestRelay = await testRelay({ modules });
  const clients: SimClient[] = [];
  return {
    relay,
    store,
    log,
    access,
    sid,
    /** Sequences `n` frames before anyone connects. */
    async seed(n: number): Promise<void> {
      const from = newId('mem');
      for (let i = 0; i < n; i += 1) {
        const id = newId('msg');
        const frame = stampFrame(
          { t: 'event', id, k: 'reaction', p: reaction() },
          from,
          new Date().toISOString(),
          sid,
        );
        const result = await store.assign(sid, { from, id }, frame, Date.now());
        await log.append(sid, withSeq(frame, result.seq));
      }
    },
    /** A member's client; `lastSeq` for its first hello. */
    async client(lastSeq: number | null = null, claims = ticketFor({ sid })) {
      access.allow(claims);
      const client = await SimClient.connect({
        url: relay.url,
        ticket: () => mintTicket(key, claims),
        clock: createManualClock(),
        lastSeq,
      });
      clients.push(client);
      return { client, claims };
    },
    async stop() {
      for (const c of clients) c.terminate();
      await relay.stop();
    },
  };
}

type Live = Awaited<ReturnType<typeof resumeRelay>>;

const events = (c: SimClient): number[] =>
  c.wire.filter((f) => typeof f.seq === 'number').map((f) => f.seq as number);

describe('resume on a running relay', () => {
  let live: Live | undefined;
  afterEach(async () => {
    await live?.stop();
    live = undefined;
  });

  it('acceptance 1: welcome, 1041..1100, sys.resumed, then the frames sent meanwhile', async () => {
    const r = await resumeRelay();
    live = r;
    await r.seed(1100);
    const { client: sender } = await r.client();
    const { client } = await r.client(1040);
    expect(client.welcome?.resume).toEqual({ from_seq: 1041, to_seq: 1100 });
    await Promise.all(Array.from({ length: 20 }, () => sender.send('reaction', reaction())));
    await until(() => events(client).length >= 80, 10_000);
    expect(events(client)).toEqual(range(1041, 1120));
    const line = client.wire.map((f) => (typeof f.seq === 'number' ? f.seq : f.t));
    const at = line.indexOf('sys.resumed');
    expect(line[at - 1]).toBe(1100);
    expect(line[at + 1]).toBe(1101);
    expect(client.wire[at]?.p).toEqual({ from_seq: 1041, to_seq: 1100, count: 60 });
    expect(client.lastSeq).toBe(1120);
  });

  it('a client that drops resumes from its own last_seq after reconnecting', async () => {
    const r = await resumeRelay();
    live = r;
    const { client: sender } = await r.client();
    const { client } = await r.client();
    for (let i = 0; i < 10; i += 1) await sender.send('reaction', reaction());
    await until(() => client.lastSeq === 10);
    client.terminate();
    for (let i = 0; i < 15; i += 1) await sender.send('reaction', reaction());
    await client.reconnect();
    expect(client.welcome?.resume).toEqual({ from_seq: 11, to_seq: 25 });
    await until(() => client.lastSeq === 25);
    await sender.send('reaction', reaction());
    await until(() => client.lastSeq === 26);
    const after = events(client).slice(events(client).indexOf(10) + 1);
    expect(after).toEqual(range(11, 26));
  });

  it('acceptance 7: a member revoked meanwhile is closed 4403 and gets no replay', async () => {
    const r = await resumeRelay();
    live = r;
    await r.seed(50);
    const { client, claims } = await r.client(null);
    client.terminate();
    r.access.allow(claims, { member: null });
    const seen = events(client).length;
    const error = await client.reconnect().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SimCloseError);
    expect((error as SimCloseError).code).toBe(4403);
    expect(events(client).length).toBe(seen);
    expect(client.wire.some((f) => f.t === 'sys.resumed')).toBe(false);
  });

  it('a session that cannot be recovered is refused with 4503 (503), never welcomed at seq 1', async () => {
    const r = await resumeRelay();
    live = r;
    r.log.failing = true;
    const error = await r.client(null).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SimCloseError);
    expect((error as SimCloseError).code).toBe(4503);
    r.log.failing = false;
    const { client } = await r.client(null);
    expect(client.welcome).toBeDefined();
  });

  it('acceptance 5: 5 000 frames replay over a socket within 2 s', async () => {
    const r = await resumeRelay();
    live = r;
    await r.seed(5_000);
    const started = Date.now();
    const { client } = await r.client(0);
    await until(() => client.wire.some((f) => f.t === 'sys.resumed'), 5_000);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(events(client)).toEqual(range(1, 5_000));
  });

  it('CT-RESUME Flow 3: snapshot_required, then sys.resume {last_seq: S} replays S+1..head', async () => {
    const r = await resumeRelay({
      limits: { minFrames: 100, minAgeMs: 0, maxFrames: 100 },
      snapshots: snapshotsAt(800),
    });
    live = r;
    await r.seed(1000);
    const { client } = await r.client(500);
    expect(client.welcome?.resume).toEqual({ snapshot_required: true, snapshot_seq: 800 });
    await until(() => client.wire.some((f) => f.t === 'sys.resumed'));
    expect(events(client)).toEqual([]);
    await client.sendFrame({ v: 1, t: 'sys.resume', p: { last_seq: 800 } } as never);
    await until(() => client.wire.filter((f) => f.t === 'sys.resumed').length === 2, 5_000);
    expect(events(client)).toEqual(range(801, 1000));
    const resumed = client.wire.filter((f) => f.t === 'sys.resumed').map((f) => f.p);
    expect(resumed).toEqual([
      { snapshot_required: true, snapshot_seq: 800 },
      { from_seq: 801, to_seq: 1000, count: 200 },
    ]);
  });

  it('sends valid envelopes: sys.welcome with resume and both sys.resumed shapes', async () => {
    const r = await resumeRelay({
      limits: { minFrames: 100, minAgeMs: 0, maxFrames: 100 },
      snapshots: snapshotsAt(800),
    });
    live = r;
    await r.seed(1000);
    const { client: a } = await r.client(500);
    const { client: b } = await r.client(950);
    await until(() => [a, b].every((c) => c.wire.some((f) => f.t === 'sys.resumed')));
    for (const c of [a, b]) {
      for (const f of c.wire.filter((x) => x.t === 'sys.welcome' || x.t === 'sys.resumed')) {
        expect(validate('envelope', f).ok, JSON.stringify(f)).toBe(true);
      }
    }
    expect(b.welcome?.resume).toEqual({ from_seq: 951, to_seq: 1000 });
  });
});
