/**
 * Fan-out on a running relay (B044, acceptance 1 end to end): B011 SimClients over real sockets
 * through the codec, the handshake (with B043's room join), B041's sequencing (in-memory store)
 * and this lane's fan-out (echo delegated). Five clients send 200 frames each at once: every client
 * receives all 1 000 exactly once, in increasing `seq` on the wire, its own echoes included; a
 * resend (duplicate) is still echoed once by B041 with its original `seq`; and the module wiring
 * sets `ctx.fanout`.
 */
import { newId } from '@centcom/contracts';
import { createManualClock, SimClient } from '@centcom/testkit/sim';
import { afterEach, describe, expect, it } from 'vitest';
import codecModule from '../../src/codec/module.js';
import { createFanOut } from '../../src/fanout/fanout.js';
import fanoutModule from '../../src/fanout/module.js';
import { createHandshake } from '../../src/handshake/handshake.js';
import { JwksCache } from '../../src/handshake/jwks.js';
import type { RelayContext, RelayModule } from '../../src/modules.js';
import { createRoomRegistry } from '../../src/rooms/registry.js';
import { createMemorySeqStore } from '../../src/seq/memory-store.js';
import { createSequencer } from '../../src/seq/stage.js';
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

async function fanoutRelay() {
  const key = signingKey();
  const jwks = stubJwks([key.jwk]);
  const access = memoryAccess();
  const rooms = createRoomRegistry();
  const store = createMemorySeqStore(LIMITS);
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
        const sequencer = createSequencer({ store, rate: 10_000, burst: 10_000, clock: ctx.clock });
        ctx.pipeline.use(40, sequencer.stage);
        ctx.onConnection(sequencer.onConnection);
        ctx.seq = sequencer.service;
        return undefined;
      },
    },
    {
      name: 'fanout',
      order: 50,
      register(ctx) {
        if (ctx.seq === undefined) throw new Error('no seq');
        const fanout = createFanOut({ rooms, seq: ctx.seq, clock: ctx.clock });
        ctx.seq.delegateEcho();
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
    sid,
    async client() {
      const claims = ticketFor({ sid });
      access.allow(claims);
      const client = await SimClient.connect({
        url: relay.url,
        ticket: await mintTicket(key, claims),
        clock: createManualClock(),
      });
      clients.push(client);
      return client;
    },
    async stop() {
      for (const c of clients) c.terminate();
      await relay.stop();
    },
  };
}

describe('fan-out on a running relay', () => {
  let live: Awaited<ReturnType<typeof fanoutRelay>> | undefined;
  afterEach(async () => {
    await live?.stop();
    live = undefined;
  });

  it('delivers 1 000 frames from 5 clients to all 5, once each, in seq order on the wire', async () => {
    const r = await fanoutRelay();
    live = r;
    const clients = await Promise.all(Array.from({ length: 5 }, () => r.client()));
    await Promise.all(
      clients.flatMap((c) =>
        Array.from({ length: 200 }, (_, i) => c.send('reaction', { ...reaction(), n: i })),
      ),
    );
    const expected = Array.from({ length: 1_000 }, (_, i) => i + 1);
    await until(
      () => clients.every((c) => c.wire.filter((f) => f.t === 'event').length >= 1_000),
      15_000,
    );
    for (const c of clients) {
      expect(c.wire.filter((f) => f.t === 'event').map((f) => f.seq)).toEqual(expected);
    }
  }, 30_000);

  it('still echoes a resend once, with its original seq', async () => {
    const r = await fanoutRelay();
    live = r;
    const [a, b] = await Promise.all([r.client(), r.client()]);
    const frame = {
      v: 1 as const,
      t: 'event' as const,
      id: newId('msg'),
      sid: r.sid,
      k: 'reaction',
      p: reaction(),
    };
    const first = await a.sendFrame(frame);
    await until(() => b.wire.some((f) => f.seq === first.seq), 3_000);
    a.sendRaw(JSON.stringify(frame));
    await until(() => a.wire.filter((f) => f.id === frame.id).length === 2, 3_000);
    expect(a.wire.filter((f) => f.id === frame.id).map((f) => f.seq)).toEqual([
      first.seq,
      first.seq,
    ]);
    // The others got it once.
    expect(b.wire.filter((f) => f.id === frame.id)).toHaveLength(1);
  });
});

describe('fanout/module.ts', () => {
  function ctxWith(seq: RelayContext['seq']) {
    const used: number[] = [];
    const shutdown: (() => Promise<void>)[] = [];
    const warnings: string[] = [];
    const ctx = {
      log: { warn: (_f: unknown, m: string) => warnings.push(m), info: () => undefined },
      metrics: {
        counter: () => ({ inc: () => undefined }),
        histogram: () => ({ observe: () => undefined }),
      },
      clock: Date.now,
      db: {},
      redis: { pubsub: { subscribe: () => Promise.resolve(() => Promise.resolve()) } },
      pipeline: { use: (order: number) => void used.push(order) },
      onShutdown: (fn: () => Promise<void>) => void shutdown.push(fn),
      onConnection: () => undefined,
      ...(seq === undefined ? {} : { seq }),
    } as unknown as RelayContext;
    return { ctx, used, shutdown, warnings };
  }

  it('registers at 50, takes over the echo, and offers ctx.fanout', async () => {
    let delegated = false;
    const store = createMemorySeqStore(LIMITS);
    const { ctx, used, shutdown } = ctxWith({
      store,
      acks: { onAck: () => undefined, lowestAcked: () => 0 },
      setDurableAppend: () => undefined,
      delegateEcho: () => {
        delegated = true;
      },
      submitServer: () => Promise.reject(new Error('unused')),
    });
    expect(fanoutModule).toMatchObject({ name: 'fanout', order: 50 });
    await fanoutModule.register(ctx);
    expect(used).toEqual([50]);
    expect(delegated).toBe(true);
    expect(ctx.fanout).toBeDefined();
    await shutdown[0]?.();
  });

  it('registers nothing without sequencing, and says so', async () => {
    const { ctx, used, warnings } = ctxWith(undefined);
    await fanoutModule.register(ctx);
    expect(used).toEqual([]);
    expect(warnings).toEqual(['relay.fanout_without_seq']);
  });
});
