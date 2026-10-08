/**
 * SimFleet and the scenario DSL (B011): 50 clients in one session, the fleet's limits and
 * clean-up on a failed spawn, and scenarios that pass, fail with their step, and clean up.
 */
import { describe, expect, it } from 'vitest';
import {
  LoopbackRelay,
  MAX_FLEET,
  mintTestTicket,
  scenario,
  ScenarioError,
  SimCloseError,
  SimFleet,
} from '../../src/sim/index.js';
import { member, newId, reaction, startRelay, useCleanup } from './helpers.js';

useCleanup();

describe('SimFleet', () => {
  it('connects 50 clients to one session, each with its own slot, and all receive a frame once', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const members = Array.from({ length: MAX_FLEET }, (_, i) =>
      member(sid, i === 0 ? 'host' : 'editor'),
    );
    const fleet = await SimFleet.spawn(MAX_FLEET, (i) => ({
      url: relay.url,
      ticket: (members[i] ?? member(sid)).ticket,
      lastSeq: 0,
    }));
    try {
      expect(fleet.size).toBe(50);
      expect(relay.connections).toBe(50);
      expect(new Set(fleet.clients.map((client) => client.welcome?.member.slot))).toEqual(
        new Set(Array.from({ length: 50 }, (_, i) => i)),
      );

      const { id } = await fleet.at(0).send('reaction', reaction());
      const received = await fleet.waitForAll((frame) => frame.id === id);
      expect(received.map((frame) => frame.seq)).toEqual(Array(50).fill(1));
      for (const client of fleet.clients)
        expect(client.frames.filter((frame) => frame.id === id)).toHaveLength(1);
    } finally {
      await fleet.closeAll();
    }
    expect(fleet.closeInfos().every((info) => info?.code === 1000)).toBe(true);
    await expect.poll(() => relay.connections).toBe(0);
  });

  it('takes 1 to 50 clients', async () => {
    const make = (): never => {
      throw new Error('not called');
    };
    await expect(SimFleet.spawn(0, make)).rejects.toThrow(RangeError);
    await expect(SimFleet.spawn(51, make)).rejects.toThrow(RangeError);
    await expect(SimFleet.spawn(2.5, make)).rejects.toThrow(RangeError);
  });

  it('closes the clients that connected when one fails, and rethrows', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const err = await SimFleet.spawn(5, (i) => ({
      url: relay.url,
      ticket: member(sid).ticket,
      ...(i === 3 ? { protocols: [2] } : {}),
    })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimCloseError);
    expect(err).toMatchObject({ code: 4426 });
    await expect.poll(() => relay.connections).toBe(0);
  });

  it('names a missing client', async () => {
    const relay = await startRelay();
    const fleet = await SimFleet.spawn(1, () => ({
      url: relay.url,
      ticket: member(newId('ses')).ticket,
    }));
    expect(() => fleet.at(1)).toThrow(/no client 1/);
    await fleet.closeAll();
  });
});

describe('scenario', () => {
  it('runs connect, send and expect steps against a LoopbackRelay it starts and stops', async () => {
    const target = newId('msg');
    let relay: LoopbackRelay | undefined;
    const run = await scenario()
      .connect('host')
      .connect('guest', { role: 'viewer' })
      .send('host', 'reaction', { target, code: 'thumbs', op: 'add' }, { label: 'thumbs' })
      .expect('guest', (frame) => frame.k === 'reaction' && frame.p?.['target'] === target)
      .step('the roles', (ctx) => {
        relay = ctx.relay;
        expect(ctx.client('host').welcome?.member.role).toBe('host');
        expect(ctx.client('guest').welcome?.member.role).toBe('viewer');
      })
      .disconnect('guest')
      .run();

    expect(run.sends.get('thumbs')).toEqual({
      id: expect.stringMatching(/^msg_/) as string,
      seq: 1,
    });
    expect(run.frames.get('guest')?.some((frame) => frame.id === run.sends.get('thumbs')?.id)).toBe(
      true,
    );
    expect(relay?.connections).toBe(0);
  });

  it('fails with the step number and label, and still cleans up', async () => {
    let relay: LoopbackRelay | undefined;
    const err = await scenario({ timeoutMs: 200 })
      .connect('host')
      .step('capture', (ctx) => {
        relay = ctx.relay;
      })
      .expect('host', (frame) => frame.k === 'never.happens', { label: 'a frame that never comes' })
      .run()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScenarioError);
    expect((err as Error).message).toMatch(/^step 3 \(a frame that never comes\) failed/);
    expect(relay?.connections).toBe(0);
  });

  it('expects a close code, and refuses an unknown or doubly connected client', async () => {
    await scenario()
      .connect('host')
      .step('the relay goes away', (ctx) => ctx.relay?.close())
      .expectClose('host', 1006)
      .run();

    await expect(scenario().send('nobody', 'reaction', reaction()).run()).rejects.toThrow(
      /no client called nobody/,
    );
    await expect(scenario().connect('host').connect('host').run()).rejects.toThrow(
      /already connected/,
    );
  });

  it('runs against a relay given by url, in a given session', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const run = await scenario({ url: relay.url, sid }).connect('host').run();
    expect(run.relay).toBeUndefined();
    expect(run.sid).toBe(sid);
    expect(relay.received[0]?.p?.['ticket']).toEqual(expect.any(String));
    // The scenario's tickets are ordinary test tickets.
    expect(typeof (await mintTestTicket({ sid, mid: newId('mem'), role: 'host' }))).toBe('string');
  });
});
