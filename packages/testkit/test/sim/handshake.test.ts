/**
 * The handshake (B011 acceptance 1 and 6): hello and welcome against LoopbackRelay, the 5 s hello
 * window on a fake clock, protocol negotiation, ticket refusals, frames before hello, the
 * subprotocol, and superseding a member's earlier connection.
 */
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  createManualClock,
  mintTestTicket,
  SimClient,
  SimCloseError,
} from '../../src/sim/index.js';
import { connect, member, newId, reaction, startRelay, useCleanup } from './helpers.js';

useCleanup();

describe('the handshake', () => {
  it('completes against LoopbackRelay and exposes the welcome: member, role, heartbeat 20000/50000 (acceptance 1)', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const host = member(sid, 'host');
    const client = await connect(relay, host);

    expect(client.welcome).toMatchObject({
      protocol: 1,
      member: { id: host.mid, slot: 0, role: 'host', name: expect.any(String) as string },
      heartbeat: { ping_ms: 20_000, dead_ms: 50_000 },
      limits: { max_frame_bytes: 262_144 },
      session: { mode: 'command_post', state: 'live' },
    });
    expect(client.memberId).toBe(host.mid);
    expect(client.sid).toBe(sid);
    expect(client.isOpen).toBe(true);
    // The hello went first, with the ticket and a fresh join.
    expect(client.sent[0]).toMatchObject({
      v: 1,
      t: 'sys.hello',
      p: { protocols: [1], caps: ['resume'], last_seq: null, client: { name: 'centcom-sim' } },
    });
    expect(relay.received[0]).toEqual(client.sent[0]);

    const guest = await connect(relay, member(sid, 'viewer'));
    expect(guest.welcome?.member).toMatchObject({ slot: 1, role: 'viewer' });
  });

  it('closes a client that sends no sys.hello within 5 s with 4408, on a fake clock in under 1 s (acceptance 6)', async () => {
    const started = performance.now();
    const clock = createManualClock();
    const relay = await startRelay({ clock });
    const client = await connect(relay, member(newId('ses')), { sendHello: false, clock });
    clock.advance(4_999);
    expect(client.isOpen).toBe(true);
    clock.advance(1);
    expect((await client.waitForClose()).code).toBe(4408);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('negotiates the version: no common protocol is sys.error unsupported_protocol and 4426, and no reconnect', async () => {
    const relay = await startRelay();
    const err = await connect(relay, member(newId('ses')), {
      protocols: [2],
      autoReconnect: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimCloseError);
    expect(err).toMatchObject({
      code: 4426,
      error: { t: 'sys.error', p: { code: 'unsupported_protocol' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(relay.connections).toBe(0);
  });

  it('refuses a replayed, an expired and a forged ticket with 4401, surfacing the code to the test', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const who = member(sid);
    const ticket = await who.ticket();
    const first = await connect(relay, who, { ticket });
    await first.close();

    const refusal = async (t: string): Promise<unknown> =>
      SimClient.connect({ url: relay.url, ticket: t, autoReconnect: true }).catch(
        (e: unknown) => e,
      );
    expect(await refusal(ticket)).toMatchObject({
      code: 4401,
      error: { p: { code: 'ticket_replayed' } },
    });

    const expired = await mintTestTicket({
      sid,
      mid: who.mid,
      dev: who.dev,
      role: 'editor',
      now: Date.now() - 61_000,
    });
    expect(await refusal(expired)).toMatchObject({
      code: 4401,
      error: { p: { code: 'ticket_invalid', detail: 'ticket expired' } },
    });

    // The same signature over claims that say "host": the signature no longer matches.
    const [header, payload, signature] = (await who.ticket()).split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const forged = [
      header,
      Buffer.from(JSON.stringify({ ...claims, role: 'host' })).toString('base64url'),
      signature,
    ].join('.');
    expect(await refusal(forged)).toMatchObject({
      code: 4401,
      error: { p: { code: 'ticket_invalid', detail: 'ticket bad signature' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(relay.connections).toBe(0);
  });

  it('answers a frame sent before sys.hello with sys.error protocol_violation and 4400', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const client = await connect(relay, member(sid), { sendHello: false });
    client.sendRaw(
      JSON.stringify({ v: 1, t: 'event', id: newId('msg'), sid, k: 'reaction', p: reaction() }),
    );
    expect(await client.waitFor((frame) => frame.t === 'sys.error')).toMatchObject({
      p: { code: 'protocol_violation', status: 400 },
    });
    expect((await client.waitForClose()).code).toBe(4400);
  });

  it('needs the centcom.v1 subprotocol', async () => {
    const relay = await startRelay();
    const ws = new WebSocket(relay.url, 'chat');
    const err = await new Promise<Error>((resolve) => ws.once('error', resolve));
    expect(err.message).toMatch(/subprotocol/i);
  });

  it('supersedes the earlier connection of the same member and device with sys.bye and 4409', async () => {
    const relay = await startRelay();
    const who = member(newId('ses'));
    const first = await connect(relay, who, { autoReconnect: true });
    const second = await connect(relay, who);
    expect(await first.waitFor((frame) => frame.t === 'sys.bye')).toMatchObject({
      p: { reason: 'superseded' },
    });
    expect((await first.waitForClose()).code).toBe(4409);
    expect(second.isOpen).toBe(true);
    // 4409 is terminal: the superseded client stays closed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(first.isOpen).toBe(false);
    expect(relay.connections).toBe(1);
  });
});
