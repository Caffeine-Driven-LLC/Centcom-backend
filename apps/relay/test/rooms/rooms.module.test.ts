/**
 * The rooms' wiring (B043):
 *
 * - `rooms/module.ts` is a RelayModule at order 20 that adds the authorise stage there; the
 *   handshake module takes the same rooms' SessionAccess and join hook (`roomsFor` gives one set
 *   per relay context);
 * - the handshake's B043 hooks: a 403 from SessionAccess (`session_full`) closes 4403 with its
 *   code, `onAdmitted` refusing closes 4403, `onAdmitted` throwing closes 4503, and nothing is
 *   welcomed in any of these cases.
 */
import { AppError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import codecModule from '../../src/codec/module.js';
import handshakeModule from '../../src/handshake/module.js';
import roomsModule from '../../src/rooms/module.js';
import { roomsFor } from '../../src/rooms/runtime.js';
import { testRelay } from '../helpers.js';
import { first, handshakeRelay, hello, mintTicket, send, ticketFor } from '../handshake/helpers.js';

describe('rooms/module.ts', () => {
  it('registers the authorise stage at order 20, after the handshake', async () => {
    expect(roomsModule).toMatchObject({ name: 'rooms', order: 20 });
    let orders: number[] = [];
    let shared = false;
    const probe = {
      name: 'probe',
      order: 99,
      register(ctx: Parameters<typeof roomsModule.register>[0]) {
        orders = ctx.pipeline.orders();
        shared = roomsFor(ctx) === roomsFor(ctx);
        return undefined;
      },
    };
    const relay = await testRelay({ modules: [codecModule, handshakeModule, roomsModule, probe] });
    try {
      expect(orders).toEqual(expect.arrayContaining([10, 15, 20]));
      expect(orders.indexOf(20)).toBeGreaterThan(orders.indexOf(15));
      expect(shared).toBe(true);
    } finally {
      await relay.stop();
    }
  });
});

describe('rooms/module.ts shutdown', () => {
  it('stops the membership subscription and flushes queued audit events', async () => {
    const shutdown: (() => Promise<void>)[] = [];
    let unsubscribed = 0;
    const ctx = {
      config: {},
      log: undefined,
      metrics: {
        counter: () => ({ inc: () => undefined }),
        histogram: () => ({ observe: () => undefined }),
      },
      clock: Date.now,
      redis: {
        pubsub: {
          subscribe: () =>
            Promise.resolve(() => {
              unsubscribed += 1;
              return Promise.resolve();
            }),
        },
      },
      db: {},
      connections: {},
      pipeline: { use: () => undefined },
      onShutdown: (fn: () => Promise<void>) => void shutdown.push(fn),
      onConnection: () => undefined,
    } as unknown as Parameters<typeof roomsModule.register>[0];
    await roomsModule.register(ctx);
    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdown).toHaveLength(1);
    await shutdown[0]?.();
    expect(unsubscribed).toBe(1);
  });
});

describe('the handshake’s B043 hooks', () => {
  it('closes 4403 with the code SessionAccess refused with (403)', async () => {
    const h = await handshakeRelay({
      access: {
        resolve: () =>
          Promise.reject(new AppError('session_full', { detail: 'The session is full.' })),
      },
    });
    try {
      const c = h.open();
      await send(c, hello(await mintTicket(h.key, ticketFor())));
      expect((await first(c, 'sys.error'))['p']).toMatchObject({ code: 'session_full' });
      expect((await c.closed).code).toBe(4403);
      expect(c.messages.some((m) => m['t'] === 'sys.welcome')).toBe(false);
    } finally {
      await h.stop();
    }
  });

  it('closes 4403 when onAdmitted refuses, and 4503 when it throws', async () => {
    let mode: 'refuse' | 'throw' = 'refuse';
    const h = await handshakeRelay({
      onAdmitted: () => {
        if (mode === 'throw') throw new Error('rooms broke');
        return { ok: false, code: 'session_full', detail: 'Full.' };
      },
    });
    try {
      const t1 = ticketFor();
      h.access.allow(t1);
      const refused = h.open();
      await send(refused, hello(await mintTicket(h.key, t1)));
      expect((await first(refused, 'sys.error'))['p']).toMatchObject({ code: 'session_full' });
      expect((await refused.closed).code).toBe(4403);

      mode = 'throw';
      const t2 = ticketFor();
      h.access.allow(t2);
      const failed = h.open();
      await send(failed, hello(await mintTicket(h.key, t2)));
      expect((await first(failed, 'sys.error'))['p']).toMatchObject({
        code: 'service_unavailable',
      });
      expect((await failed.closed).code).toBe(4503);
      expect(h.passed).toEqual([]);
    } finally {
      await h.stop();
    }
  });

  it('welcomes when onAdmitted accepts, with the member it was given', async () => {
    const seen: string[] = [];
    const h = await handshakeRelay({
      onAdmitted: (_conn, admitted) => {
        seen.push(`${admitted.sid}:${admitted.access.member.id}:${admitted.dev}`);
        return { ok: true };
      },
    });
    try {
      const t = ticketFor();
      h.access.allow(t);
      const c = h.open();
      await send(c, hello(await mintTicket(h.key, t)));
      await first(c, 'sys.welcome');
      expect(seen).toEqual([`${t.sid}:${t.mid}:${t.dev}`]);
      c.ws.close();
    } finally {
      await h.stop();
    }
  });
});
