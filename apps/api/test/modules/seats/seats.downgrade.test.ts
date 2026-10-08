/**
 * Downgrades (B030; tests "seats.downgrade.test.ts"): a workspace using 8 seats under a new limit
 * of 5 cannot add anyone, and the gate removes nobody: it only reads (the lock and the count), so
 * the members over the limit stay until the product process of CT-ENTITLEMENTS §7 handles them.
 */
import { isAppError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { createSeatGate, seatLimitsFrom } from '../../../src/modules/seats/index.js';
import { newId } from '../users/helpers.js';
import { fixedSeats, fixtureEntitlements, scriptedTrx } from './helpers.js';

describe('a workspace over its new limit', () => {
  it('blocks every new add and removes nobody', async () => {
    const gate = createSeatGate({
      seats: fixedSeats(8),
      limits: seatLimitsFrom(fixtureEntitlements('team')),
    });
    const trx = scriptedTrx();
    for (let i = 0; i < 3; i += 1) {
      const error = await gate.assertCanAdd(trx, newId('wsp')).catch((err: unknown) => err);
      expect(isAppError(error) && error.code).toBe('seat_limit_reached');
    }
    expect(trx.statements.every((s) => s.startsWith('select'))).toBe(true);
    expect(trx.statements.join(' ')).not.toMatch(/\b(delete|update|insert)\b/i);
  });

  it('lets adds through again once the limit is raised above the usage', async () => {
    const gate = createSeatGate({
      seats: fixedSeats(8),
      limits: seatLimitsFrom(fixtureEntitlements('team', 9)),
    });
    await expect(gate.assertCanAdd(scriptedTrx(), newId('wsp'))).resolves.toBeUndefined();
  });
});
