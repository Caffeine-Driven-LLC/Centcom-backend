/**
 * The seat gate (B030 acceptance 1 and 3; tests "seats.gate.test.ts"): the boundary with 5 seats
 * (4 members + 1 pending refused, 3 + 1 allowed), `max_seats: null` never refusing, `0` always
 * refusing, limits read from CT-ENTITLEMENTS fixtures, the lock taken in the caller's
 * transaction before the count (and its `lock_timeout` restored), a refusal that names the limit
 * only, the rejection metric, and the `seatGate` decorator B029's invite routes require.
 */
import { AppError, isAppError } from '@centcom/core';
import { fastify } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  createSeatGate,
  SEAT_LOCK_TIMEOUT_MS,
  seatGatePlugin,
  seatLimitsFrom,
} from '../../../src/modules/seats/index.js';
import { recordingMetrics } from '../../helpers.js';
import { newId } from '../users/helpers.js';
import { fixedSeats, fixtureEntitlements, scriptedTrx } from './helpers.js';

const outcome = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'allowed',
    (err: unknown) => (isAppError(err) ? `${err.status} ${err.code}` : String(err)),
  );

describe('assertCanAdd', () => {
  it.each([
    ['4 members + 1 pending invite of 5', 4, 1, '403 seat_limit_reached'],
    ['3 members + 1 pending invite of 5', 3, 1, 'allowed'],
    ['5 members of 5', 5, 0, '403 seat_limit_reached'],
    ['0 members of 5', 0, 0, 'allowed'],
  ])('with %s', async (_case, members, pending, expected) => {
    const gate = createSeatGate({
      seats: fixedSeats(members, pending),
      limits: seatLimitsFrom(fixtureEntitlements('team')),
    });
    expect(await outcome(gate.assertCanAdd(scriptedTrx(), newId('wsp')))).toBe(expected);
  });

  it('reads the limit from the fixtures: free takes 1 seat, team 5', async () => {
    const free = createSeatGate({
      seats: fixedSeats(1),
      limits: seatLimitsFrom(fixtureEntitlements('free')),
    });
    expect(await outcome(free.assertCanAdd(scriptedTrx(), newId('wsp')))).toBe(
      '403 seat_limit_reached',
    );
    const team = createSeatGate({
      seats: fixedSeats(1),
      limits: seatLimitsFrom(fixtureEntitlements('team')),
    });
    expect(await outcome(team.assertCanAdd(scriptedTrx(), newId('wsp')))).toBe('allowed');
  });

  it('never refuses with max_seats null, however many seats are used', async () => {
    const seats = fixedSeats(10_000, 500);
    const gate = createSeatGate({
      seats,
      limits: seatLimitsFrom(fixtureEntitlements('team', null)),
    });
    expect(await outcome(gate.assertCanAdd(scriptedTrx(), newId('wsp')))).toBe('allowed');
    expect(seats.calls).toEqual([]);
  });

  it('always refuses with max_seats 0', async () => {
    const gate = createSeatGate({
      seats: fixedSeats(0),
      limits: seatLimitsFrom(fixtureEntitlements('team', 0)),
    });
    const error = await gate.assertCanAdd(scriptedTrx(), newId('wsp')).catch((err: unknown) => err);
    expect(isAppError(error) && error.code).toBe('seat_limit_reached');
    expect(isAppError(error) && error.detail).toBe('This workspace’s plan includes no seats.');
  });

  it('locks the workspace in the caller’s transaction, then counts in it', async () => {
    const seats = fixedSeats(1);
    const gate = createSeatGate({ seats, limits: seatLimitsFrom(fixtureEntitlements('team')) });
    const trx = scriptedTrx();
    const workspaceId = newId('wsp');
    await gate.assertCanAdd(trx, workspaceId);
    expect(trx.statements).toEqual([
      "select current_setting('lock_timeout') as value",
      "select set_config('lock_timeout', $1, true)",
      'select pg_advisory_xact_lock(hashtext($1))',
      "select set_config('lock_timeout', $1, true)",
    ]);
    expect(trx.parameters).toEqual([[], [`${SEAT_LOCK_TIMEOUT_MS}ms`], [workspaceId], ['0']]);
    expect(seats.calls).toEqual([{ workspaceId, trx }]);
  });

  it('names the limit and nothing else when it refuses, and counts the refusal', async () => {
    const { metrics, count } = recordingMetrics();
    const gate = createSeatGate({
      seats: fixedSeats(3, 2),
      limits: seatLimitsFrom(fixtureEntitlements('team')),
      metrics,
    });
    const error = await gate.assertCanAdd(scriptedTrx(), newId('wsp')).catch((err: unknown) => err);
    expect(isAppError(error) && error.status).toBe(403);
    expect(isAppError(error) && error.detail).toBe(
      'This workspace’s plan includes 5 seats, and none is free.',
    );
    expect(count('seat_gate_rejections_total', { reason: 'limit' })).toBe(1);
    const one = createSeatGate({
      seats: fixedSeats(1),
      limits: seatLimitsFrom(fixtureEntitlements('free')),
    });
    const single = await one.assertCanAdd(scriptedTrx(), newId('wsp')).catch((err: unknown) => err);
    expect(isAppError(single) && single.detail).toBe(
      'This workspace’s plan includes 1 seat, and none is free.',
    );
  });

  it('refuses a workspace with no entitlements (403 entitlement_required)', async () => {
    const { metrics, count } = recordingMetrics();
    const gate = createSeatGate({
      seats: fixedSeats(0),
      limits: seatLimitsFrom({ get: () => Promise.resolve(null) }),
      metrics,
    });
    expect(await outcome(gate.assertCanAdd(scriptedTrx(), newId('wsp')))).toBe(
      '403 entitlement_required',
    );
    expect(count('seat_gate_rejections_total', { reason: 'no_entitlements' })).toBe(1);
  });
});

describe('seatGatePlugin', () => {
  it('puts the gate on the instance as seatGate, as B029’s invite routes require', async () => {
    const gate = createSeatGate({
      seats: fixedSeats(0),
      limits: seatLimitsFrom(fixtureEntitlements('team')),
    });
    const app = fastify({ logger: false });
    await app.register(seatGatePlugin, { gate });
    await app.ready();
    expect(app.hasDecorator('seatGate')).toBe(true);
    expect(app.seatGate).toBe(gate);
    await app.close();
  });

  it('passes an unexpected limit-reader AppError on as a 503, never as an allow', async () => {
    const gate = createSeatGate({
      seats: fixedSeats(0),
      limits: { maxSeats: () => Promise.reject(new AppError('internal_error')) },
    });
    expect(await outcome(gate.assertCanAdd(scriptedTrx(), newId('wsp')))).toBe(
      '503 service_unavailable',
    );
  });
});
