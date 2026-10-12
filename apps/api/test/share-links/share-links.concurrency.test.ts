/**
 * `max_uses` is atomic (B068; tests "share-links.concurrency.test.ts", acceptance 5): 50
 * concurrent joins on a link with `max_uses` 10 succeed exactly 10 times. The other 40 are
 * refused: 404 once the link is used up, or 429 past the token's 30 joins a minute. None leaves a
 * guest, a slot or a ticket record behind.
 */
import { describe, expect, it } from 'vitest';
import { shareApp } from './helpers.js';

describe('max_uses', () => {
  it('50 concurrent joins on a 10-use link: exactly 10 succeed', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host, { max_uses: 10 })).json();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        env.join(token, { display_name: `G${i}` }, `198.51.100.${(i % 25) + 1}`),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(10);
    expect(codes.filter((c) => c === 404 || c === 429)).toHaveLength(40);
    expect(codes.filter((c) => c === 429)).toHaveLength(20);
    expect(env.store.guests).toHaveLength(10);
    const link = [...env.store.links.values()][0];
    expect(link?.uses).toBe(10);
    // Slots given back for every join that did not go through.
    const slots = env.world.slots.get(s.sid);
    const guestIds = new Set(env.store.guests.map((g) => g.memberId));
    expect(
      [...(slots?.keys() ?? [])].filter((m) => !guestIds.has(m) && m.startsWith('mem_')),
    ).toHaveLength(env.world.members.filter((m) => m.sessionId === s.sid).length);
    const tickets = [...env.issued.keys()].filter((k) => k.startsWith('ticket:issued:'));
    expect(tickets).toHaveLength(10);
  });
});
