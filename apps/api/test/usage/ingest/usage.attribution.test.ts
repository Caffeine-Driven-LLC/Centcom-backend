/**
 * Attribution (B074 acceptance 6): an event with `session_id` goes to that session's workspace even
 * when the token's `wsp` claim names another; without one, to the `wsp` workspace while the caller
 * is still its member; else to the caller's personal workspace. A session without a live workspace
 * falls through the same way; one batch may span several workspaces. With nowhere to go, 403. On
 * Postgres 16 (DATABASE_URL), the same lookups in SQL, the creator and members on any device
 * counting as participants.
 */
import type { UsageDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { attribute } from '../../../src/modules/usage/attribution.js';
import { createUsageRepository } from '../../../src/modules/usage/repository.js';
import {
  pgJoin,
  pgJoinSession,
  pgSession,
  pgUser,
  pgWorkspace,
} from '../../notifications/dispatcher/postgres.js';
import { ADMIN_URL, migratedDatabase } from '../../modules/users/helpers.js';
import { memoryUsage, newId, usageApp, usageEvent } from './helpers.js';

describe('attribution', () => {
  it("puts session events in the session's workspace, whatever the wsp claim says", async () => {
    const claimed = newId('wsp');
    const ctx = await usageApp();
    const d = await ctx.device({ workspaceId: claimed });
    ctx.memory.join(d.userId, claimed);
    const sessionWorkspace = newId('wsp');
    const session = newId('ses');
    ctx.memory.sessions.set(session, {
      workspaceId: sessionWorkspace,
      createdBy: newId('usr'),
      members: [d.userId],
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/usage/events',
      headers: d.headers(),
      payload: { events: [usageEvent({ session_id: session }), usageEvent()] },
    });
    expect(response.json()).toEqual({ accepted: 2, duplicates: 0 });
    expect([...ctx.memory.rows.values()].map((r) => [r.sessionId, r.workspaceId])).toEqual([
      [session, sessionWorkspace],
      [null, claimed],
    ]);
    await ctx.app.close();
  });

  it('uses the wsp claim only while the caller is a member, else the personal workspace', async () => {
    const memory = memoryUsage();
    const user = newId('usr');
    const personal = memory.personal(user);
    const claimed = newId('wsp');
    const principal = { userId: user, deviceId: newId('dev'), workspaceId: claimed };
    expect((await attribute(memory.repository, principal, [], true)).fallback).toBe(personal);
    memory.join(user, claimed);
    expect((await attribute(memory.repository, principal, [], true)).fallback).toBe(claimed);
    const noClaim = { userId: principal.userId, deviceId: principal.deviceId };
    expect((await attribute(memory.repository, noClaim, [], true)).fallback).toBe(personal);
  });

  it('falls through for a session without a live workspace, and refuses with nowhere to go', async () => {
    const memory = memoryUsage();
    const user = newId('usr');
    const session = newId('ses');
    memory.sessions.set(session, { workspaceId: null, createdBy: user, members: [] });
    const principal = { userId: user, deviceId: newId('dev') };
    await expect(attribute(memory.repository, principal, [session], false)).rejects.toMatchObject({
      code: 'forbidden',
    });
    const personal = memory.personal(user);
    const result = await attribute(memory.repository, principal, [session], false);
    expect(result.fallback).toBe(personal);
    expect(result.bySession.size).toBe(0);
  });
});

describe.runIf(ADMIN_URL !== undefined)('attribution on Postgres 16', () => {
  it('reads sessions, participants, memberships and the personal workspace', async () => {
    const t = await migratedDatabase(5);
    try {
      const repository = createUsageRepository(t.db as unknown as Kysely<UsageDb>);
      const owner = await pgUser(t.db);
      const member = await pgUser(t.db);
      const outsider = await pgUser(t.db);
      const personal = await pgWorkspace(t.db, owner);
      await pgJoin(t.db, personal, owner, 'owner');
      const team = await pgWorkspace(t.db, member);
      await pgJoin(t.db, team, member, 'owner');
      await pgJoin(t.db, team, owner, 'member');
      const session = await pgSession(t.db, team, member);
      await pgJoinSession(t.db, session, owner);

      expect(await repository.sessionAccess(session, member)).toEqual({
        workspaceId: team,
        participant: true,
      });
      expect(await repository.sessionAccess(session, owner)).toEqual({
        workspaceId: team,
        participant: true,
      });
      expect(await repository.sessionAccess(session, outsider)).toEqual({
        workspaceId: team,
        participant: false,
      });
      expect(await repository.sessionAccess(newId('ses'), owner)).toBeNull();
      expect(await repository.isMember(owner, team)).toBe(true);
      expect(await repository.isMember(outsider, team)).toBe(false);
      expect(await repository.personalWorkspace(owner)).toBe(personal);
      expect(await repository.personalWorkspace(outsider)).toBeNull();
    } finally {
      await t.drop();
    }
  }, 60_000);
});
