/**
 * Supersede (B038 acceptance 7; tests "handshake.supersede.test.ts"): a second connection for the
 * same `(member, device)` is welcomed, and the first gets `sys.bye` with `p.reason: "superseded"`
 * then close 4409 within 200 ms. The same member on another device, or another member, is not
 * superseded, and the first connection's closing does not disturb the second.
 */
import { describe, expect, it } from 'vitest';
import {
  first,
  handshakeRelay,
  hello,
  mintTicket,
  newId,
  send,
  ticketFor,
  until,
} from './helpers.js';

describe('a second connection of one (member, device)', () => {
  it('supersedes the first: sys.bye, then 4409 within 200 ms', async () => {
    const h = await handshakeRelay();
    try {
      const claims = ticketFor();
      h.access.allow(claims);
      const a = h.open();
      await send(a, hello(await mintTicket(h.key, claims)));
      await first(a, 'sys.welcome');
      const b = h.open();
      await send(b, hello(await mintTicket(h.key, claims)));
      await first(b, 'sys.welcome');
      const welcomed = Date.now();
      const bye = await first(a, 'sys.bye');
      expect(bye).toEqual({ v: 1, t: 'sys.bye', p: { reason: 'superseded' } });
      const closed = await a.closed;
      expect(closed.code).toBe(4409);
      expect(closed.at - welcomed).toBeLessThan(200);
      // The newer connection keeps working.
      await send(b, { v: 1, t: 'sys.ping', p: { t: 1 } });
      await until(() => h.passed.length === 1);
      expect(b.ws.readyState).toBe(b.ws.OPEN);
      expect(h.relay.recorded.count('relay_superseded_total')).toBe(1);
    } finally {
      await h.stop();
    }
  });

  it('leaves the same member on another device, and other members, alone', async () => {
    const h = await handshakeRelay();
    try {
      const laptop = ticketFor();
      const phone = { ...laptop, dev: newId('dev') };
      const other = { ...laptop, mid: newId('mem') };
      for (const t of [laptop, phone, other]) h.access.allow(t);
      const clients = [];
      for (const t of [laptop, phone, other]) {
        const c = h.open();
        await send(c, hello(await mintTicket(h.key, t)));
        await first(c, 'sys.welcome');
        clients.push(c);
      }
      await new Promise((r) => setTimeout(r, 100));
      for (const c of clients) {
        expect(c.messages.some((m) => m['t'] === 'sys.bye')).toBe(false);
        expect(c.ws.readyState).toBe(c.ws.OPEN);
      }
    } finally {
      await h.stop();
    }
  });
});
