/**
 * Online and offline from the connection (B047; tests "presence.offline-grace.test.ts", acceptance
 * 4, guardrail "derived from the connection, never a client claim"): a member whose only socket
 * closes stays online for 10 s (within 0.5 s); a reconnect inside the grace never marks it
 * offline; after the grace `isOnline` is false, its state goes, and its stored entry if this node
 * wrote it (another node's newer one stays).
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { ONLINE_IDLE, presenceUnit } from './helpers.js';

describe('the offline grace (acceptance 4)', () => {
  it('online for 10 s after the last socket closed, then offline', async () => {
    const u = presenceUnit();
    const member = newId('mem');
    const conn = u.join(member);
    await u.update(conn, ONLINE_IDLE);
    expect(u.presence.isOnline(u.sid, member)).toBe(true);
    const closedAt = u.time.now();
    conn.close(1000 as never);
    u.time.advanceTo(closedAt + 9_500);
    expect(u.presence.isOnline(u.sid, member)).toBe(true);
    u.time.advanceTo(closedAt + 10_500);
    expect(u.presence.isOnline(u.sid, member)).toBe(false);
    expect(u.presence.snapshot(u.sid)).toEqual([]);
    expect((await u.store.read(u.sid)).has(member)).toBe(false);
    expect(u.recorded.count('relay_presence_offline_total')).toBe(1);
  });

  it('a reconnect inside the grace never marks the member offline', () => {
    const u = presenceUnit();
    const member = newId('mem');
    const first = u.join(member);
    const closedAt = u.time.now();
    first.close(1000 as never);
    u.time.advanceTo(closedAt + 6_000);
    u.join(member);
    for (let t = 6_000; t <= 30_000; t += 500) {
      u.time.advanceTo(closedAt + t);
      expect(u.presence.isOnline(u.sid, member), `at ${t}`).toBe(true);
    }
    expect(u.recorded.count('relay_presence_offline_total')).toBe(0);
  });

  it('one of two sockets closing keeps the member online without a grace', () => {
    const u = presenceUnit();
    const member = newId('mem');
    const a = u.join(member);
    u.join(member);
    a.close(1000 as never);
    u.time.advance(60_000);
    expect(u.presence.isOnline(u.sid, member)).toBe(true);
  });

  it('a member never connected here is not online, whatever it claims', async () => {
    const u = presenceUnit();
    expect(u.presence.isOnline(u.sid, newId('mem'))).toBe(false);
  });

  it('keeps another node’s newer stored entry when the member goes offline here', async () => {
    const u = presenceUnit();
    const member = newId('mem');
    const conn = u.join(member);
    await u.update(conn, ONLINE_IDLE);
    await u.store.write(u.sid, member, {
      p: { status: 'busy', activity: 'running' },
      at: u.time.now(),
      node: 'node-b',
    });
    conn.close(1000 as never);
    u.time.advance(10_500);
    expect((await u.store.read(u.sid)).get(member)?.node).toBe('node-b');
  });

  it('ends a session: its state and stored presence go', async () => {
    const u = presenceUnit();
    const conn = u.join();
    await u.update(conn, ONLINE_IDLE);
    await u.presence.endSession(u.sid);
    expect(u.presence.snapshot(u.sid)).toEqual([]);
    expect((await u.store.read(u.sid)).size).toBe(0);
  });
});
