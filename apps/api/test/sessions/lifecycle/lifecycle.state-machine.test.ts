/**
 * The session state machine (B053; tests "lifecycle.state-machine.test.ts", acceptance 6): the
 * exhaustive table of state × event, a fast-check property over every pair (a legal pair gives the
 * table's state, an illegal one throws SessionStateError), and on Postgres: an illegal transition
 * leaves the row untouched (the conditional UPDATE matches nothing).
 */
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIFECYCLE_EVENTS,
  SESSION_STATES,
  SessionStateError,
  sourcesOf,
  transition,
  type LifecycleEvent,
  type SessionState,
} from '../../../src/modules/sessions/index.js';
import type { TestDatabase } from '../../modules/users/helpers.js';
import { ADMIN_URL, lifecycleOn, migratedDatabase } from './helpers.js';

const TABLE: Record<SessionState, Partial<Record<LifecycleEvent, SessionState>>> = {
  pending: { host_lost: 'paused', host_returned: 'live', end: 'ended' },
  live: { host_lost: 'paused', end: 'ended' },
  paused: { host_returned: 'live', end: 'ended', expire: 'expired' },
  ended: {},
  expired: {},
};

describe('the table', () => {
  for (const from of SESSION_STATES) {
    for (const event of LIFECYCLE_EVENTS) {
      const to = TABLE[from][event];
      it(`${from} + ${event} → ${to ?? 'SessionStateError'}`, () => {
        if (to === undefined) expect(() => transition(from, event)).toThrow(SessionStateError);
        else expect(transition(from, event)).toBe(to);
      });
    }
  }

  it('property: every pair either follows the table or throws', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SESSION_STATES),
        fc.constantFrom(...LIFECYCLE_EVENTS),
        (from, event) => {
          const to = TABLE[from][event];
          if (to === undefined) {
            expect(() => transition(from, event)).toThrow(SessionStateError);
            expect(sourcesOf(event)).not.toContain(from);
          } else {
            expect(transition(from, event)).toBe(to);
            expect(sourcesOf(event)).toContain(from);
          }
        },
      ),
    );
  });
});

describe.runIf(ADMIN_URL !== undefined)('illegal transitions on Postgres 16', () => {
  let test: TestDatabase;
  beforeAll(async () => {
    test = await migratedDatabase(5);
  });
  afterAll(async () => {
    await test?.drop();
  });

  it('property: a transition from a state outside its sources leaves the row untouched', async () => {
    const env = lifecycleOn(test.db);
    env.entitlements.state.limits['max_concurrent_sessions'] = null;
    const w = await env.seed();
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SESSION_STATES),
        fc.constantFrom(...LIFECYCLE_EVENTS),
        async (state, event) => {
          const s = await env.service.create({
            workspaceId: w.workspace,
            creatorUserId: w.owner.user,
            creatorDeviceId: w.owner.device,
            name: 'Release',
            region: 'eu',
          });
          await test.db.updateTable('sessions').set({ state }).where('id', '=', s.id).execute();
          const before = await test.db
            .selectFrom('sessions')
            .selectAll()
            .where('id', '=', s.id)
            .executeTakeFirstOrThrow();
          const to = TABLE[state][event];
          const result = await env.repository.transition(s.id, sourcesOf(event), to ?? 'live', {
            at: new Date(env.clock.now + 1000),
            eventType: null,
          });
          const after = await test.db
            .selectFrom('sessions')
            .selectAll()
            .where('id', '=', s.id)
            .executeTakeFirstOrThrow();
          if (to === undefined) {
            expect(result).toBeNull();
            expect(after).toEqual(before);
          } else {
            expect(result?.row.state).toBe(to);
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
