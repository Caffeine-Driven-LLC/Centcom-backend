/**
 * The rooms on a real relay (B043; tests "rooms.session-state.test.ts"): WebSocket clients through
 * the codec (10), the handshake (15) with the rooms' join hook, the authorise stage (20) and a
 * recorder at 50 standing in for sequencing.
 *
 * - A viewer's `message.user` gets `sys.error forbidden` and never reaches sequencing; their
 *   `reaction` does (acceptance 1).
 * - A ticket claiming `host` for a member the records say is a `viewer` joins as `viewer` and is
 *   authorised as one (acceptance 7).
 * - With `max_session_members` 4 the 5th member is refused 4403 `session_full`; a member's second
 *   device still joins (acceptance 6).
 * - An ended session is 4404 (`session_ended`, the handshake's check on the live record); a
 *   paused one admits members, who are authorised as usual.
 */
import { describe, expect, it } from 'vitest';
import { fixtureFrame, newId, roomsRelay, until } from './helpers.js';

describe('rooms on a running relay', () => {
  it('keeps a viewer’s message.user from sequencing, lets their reaction through (acceptance 1, 7)', async () => {
    const r = await roomsRelay();
    try {
      const { client, welcome } = await r.join('viewer');
      // The ticket said host; the live record wins.
      expect(welcome?.['p']).toMatchObject({ member: { role: 'viewer' } });
      const prompt = fixtureFrame('message.user', r.harness.sid);
      client.ws.send(JSON.stringify(prompt));
      await until(() => client.messages.some((m) => m['t'] === 'sys.error'), 3_000);
      expect(client.messages.find((m) => m['t'] === 'sys.error')).toMatchObject({
        ref: prompt['id'],
        p: { code: 'forbidden' },
      });
      const reaction = fixtureFrame('reaction', r.harness.sid);
      client.ws.send(JSON.stringify(reaction));
      await until(() => r.passed.length === 1, 3_000);
      expect(r.passed.map((f) => f['k'])).toEqual(['reaction']);
      expect(r.harness.audited).toHaveLength(1);
      client.ws.close();
    } finally {
      await r.stop();
    }
  });

  it('refuses the 5th member with max_session_members 4, not a member’s 2nd device (acceptance 6)', async () => {
    const r = await roomsRelay();
    try {
      const first = await r.join('editor', { maxMembers: 4 });
      for (let i = 0; i < 3; i++) {
        expect((await r.join('editor', { maxMembers: 4 })).welcome).toBeDefined();
      }
      const fifth = await r.join('editor', { maxMembers: 4 });
      expect(fifth.welcome).toBeUndefined();
      expect(fifth.client.messages.find((m) => m['t'] === 'sys.error')?.['p']).toMatchObject({
        code: 'session_full',
      });
      expect((await fifth.client.closed).code).toBe(4403);
      // The first member's second device is not a new member.
      const again = await r.join('editor', { maxMembers: 4, mid: first.ticket.mid });
      expect(again.welcome).toBeDefined();
      expect(r.harness.registry.get(r.harness.sid)?.memberCount()).toBe(4);
    } finally {
      await r.stop();
    }
  });

  it('leaves the room when the socket closes', async () => {
    const r = await roomsRelay();
    try {
      const { client } = await r.join('editor');
      expect(r.harness.registry.get(r.harness.sid)?.memberCount()).toBe(1);
      client.ws.close();
      await until(() => r.harness.registry.get(r.harness.sid)?.memberCount() === 0, 3_000);
    } finally {
      await r.stop();
    }
  });
});

describe('session states', () => {
  it('closes 4404 for an ended session and admits members of a paused one', async () => {
    const r = await roomsRelay();
    try {
      const { client } = await r.join('editor', { state: 'ended' });
      expect((await client.closed).code).toBe(4404);
      expect(client.messages.find((m) => m['t'] === 'sys.error')?.['p']).toMatchObject({
        code: 'session_ended',
      });

      const paused = await r.join('host', { state: 'paused', mid: newId('mem') });
      expect(paused.welcome?.['p']).toMatchObject({ session: { state: 'paused' } });
      paused.client.ws.send(JSON.stringify(fixtureFrame('control.policy', r.harness.sid)));
      await until(() => r.passed.length === 1, 3_000);
      paused.client.ws.close();
    } finally {
      await r.stop();
    }
  });
});
