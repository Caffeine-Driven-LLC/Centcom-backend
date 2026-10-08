/**
 * Seat counting (B030): `usage` runs one statement on the caller's transaction when given (else
 * the pool) and turns Postgres' bigint counts into numbers; the statement counts only
 * `SEAT_COUNTED_ROLES` (CT-ENTITLEMENTS: owner, admin, member) and only pending invites (not
 * accepted, revoked or expired, `expires_at` after the clock, live workspace); `getSeatUsage` and
 * `withSeatUsage` give B073 and B069 the count, `usage.seats` being the members' seats.
 */
import type { AuditDb } from '@centcom/core';
import type { CompiledQuery, QueryResult } from 'kysely';
import { describe, expect, it } from 'vitest';
import { emptyUsageReader } from '../../../src/modules/entitlements/ports.js';
import {
  getSeatUsage,
  SEAT_COUNTED_ROLES,
  SeatService,
  seatUsageQuery,
  withSeatUsage,
} from '../../../src/modules/seats/index.js';
import { testClock } from '../auth/tokens/helpers.js';
import { newId } from '../users/helpers.js';

/** An executor answering every query with `row`, recording what it ran. */
function answering(row: Record<string, unknown> | undefined): AuditDb & { ran: CompiledQuery[] } {
  const ran: CompiledQuery[] = [];
  return {
    ran,
    isTransaction: false,
    executeQuery<R>(query: CompiledQuery<R>): Promise<QueryResult<R>> {
      ran.push(query);
      return Promise.resolve({ rows: row === undefined ? [] : [row as R] });
    },
  };
}

describe('SeatService.usage', () => {
  it('counts on the transaction when given, else on the pool, as numbers', async () => {
    const clock = testClock();
    const pool = answering({ members: '4', pending_invites: '1' });
    const trx = answering({ members: 2, pending_invites: 0 });
    const seats = new SeatService({ db: pool, now: clock.now });
    const workspaceId = newId('wsp');
    expect(await seats.usage(workspaceId)).toEqual({ members: 4, pending_invites: 1, total: 5 });
    expect(await seats.usage(workspaceId, trx)).toEqual({
      members: 2,
      pending_invites: 0,
      total: 2,
    });
    expect(pool.ran).toHaveLength(1);
    expect(trx.ran).toHaveLength(1);
    expect(trx.ran[0]?.parameters).toContain(workspaceId);
    expect(trx.ran[0]?.parameters).toContainEqual(new Date(clock.now()));
    expect(await getSeatUsage(new SeatService({ db: answering(undefined) }), workspaceId)).toEqual({
      members: 0,
      pending_invites: 0,
      total: 0,
    });
  });
});

describe('seatUsageQuery', () => {
  it('counts only seat-taking roles and pending, unexpired invites of a live workspace', () => {
    expect(SEAT_COUNTED_ROLES).toEqual(['owner', 'admin', 'member']);
    const now = new Date('2026-10-08T00:00:00.000Z');
    const query = seatUsageQuery(newId('wsp'), now);
    const text = query.sql.replace(/\s+/g, ' ');
    expect(text).toContain('from memberships m');
    expect(text).toContain('from invites i');
    for (const condition of [
      'i.accepted_at is null',
      'i.revoked_at is null',
      'i.expired_at is null',
      'i.expires_at >',
      'w.deleted_at is null',
    ]) {
      expect(text).toContain(condition);
    }
    expect(query.parameters).toEqual(expect.arrayContaining(['owner', 'admin', 'member', now]));
    expect(query.parameters).not.toContain('guest');
    expect(query.parameters).not.toContain('billing');
  });
});

describe('withSeatUsage', () => {
  it('adds the members’ seats to what the inner reader reports', async () => {
    const seats = new SeatService({ db: answering({ members: '3', pending_invites: '2' }) });
    const reader = withSeatUsage(seats, {
      read: () =>
        Promise.resolve({
          usage: { hosted_minutes_month: 10 },
          warnings: [{ limit: 'hosted_minutes_month', pct: 80 }],
        }),
    });
    expect(await reader.read(newId('wsp'), null)).toEqual({
      usage: { hosted_minutes_month: 10, seats: 3 },
      warnings: [{ limit: 'hosted_minutes_month', pct: 80 }],
    });
    const bare = withSeatUsage(seats, emptyUsageReader);
    expect(await bare.read(newId('wsp'), null)).toEqual({ usage: { seats: 3 }, warnings: [] });
  });
});
