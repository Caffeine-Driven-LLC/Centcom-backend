/**
 * Test helpers for the session lifecycle (B053): a SessionService on a migrated throwaway Postgres
 * database (DATABASE_URL, CI's integration job), with a fake clock, an entitlements port built
 * from `contracts/fixtures/entitlements/*.json` (or made to fail or hang), and recorders for the
 * relay notifier and the domain events (each able to fail). `seed()` makes a workspace with an
 * owner, an admin, a member and a guest, each with a device.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { newId } from '@centcom/contracts';
import { Secret, type SigningKeys } from '@centcom/core';
import type { CoreDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';
import {
  createSessionRepository,
  SessionService,
  type EntitlementsPort,
  type SessionDomainEvent,
  type SessionsDb,
  type SessionState,
} from '../../../src/modules/sessions/index.js';
import { pgJoin, pgUser, pgWorkspace } from '../../notifications/dispatcher/postgres.js';

export { ADMIN_URL, migratedDatabase } from '../../notifications/dispatcher/postgres.js';

export const KEYS: SigningKeys = [
  { id: 'k1', secret: new Secret(new Uint8Array(randomBytes(32))) },
];
export const T0 = Date.parse('2026-10-10T12:00:00.000Z');

/** A plan's limits from the contract's fixtures. */
export function planLimits(plan: 'free' | 'pro' | 'team'): Record<string, unknown> {
  const doc = JSON.parse(
    readFileSync(
      new URL(`../../../../../contracts/fixtures/entitlements/${plan}.json`, import.meta.url),
      'utf8',
    ),
  ) as { data: { limits: Record<string, unknown> } };
  return doc.data.limits;
}

/** An entitlements port over `limits`; `mode` makes it fail or hang. */
export function fakeEntitlements(limits: Record<string, unknown>) {
  const state = { limits, mode: 'ok' as 'ok' | 'fail' | 'hang', calls: 0 };
  const port: EntitlementsPort = {
    check(_workspace, key, current) {
      state.calls += 1;
      if (state.mode === 'fail') return Promise.reject(new Error('postgres down'));
      if (state.mode === 'hang') return new Promise(() => undefined);
      const value = state.limits[key];
      if (key === 'relay_access') {
        return Promise.resolve(
          value === true ? { allowed: true } : { allowed: false, reason: 'flag_off' },
        );
      }
      if (value === null) return Promise.resolve({ allowed: true });
      const limit = typeof value === 'number' ? value : 0;
      return Promise.resolve(
        (current ?? 0) < limit ? { allowed: true } : { allowed: false, reason: 'count_reached' },
      );
    },
  };
  return { state, port };
}

/** The service on `db`, with its recorders. */
export function lifecycleOn(db: Kysely<CoreDatabase>, plan: 'free' | 'pro' | 'team' = 'team') {
  const clock = { now: T0 };
  const entitlements = fakeEntitlements(planLimits(plan));
  const relayed: { sid: string; state: SessionState }[] = [];
  const events: SessionDomainEvent[] = [];
  const failing = { relay: false, events: false };
  const repository = createSessionRepository(db as unknown as SessionsDb);
  const service = new SessionService({
    repository,
    entitlements: entitlements.port,
    relay: {
      notify(sid, state) {
        if (failing.relay) return Promise.reject(new Error('relay down'));
        relayed.push({ sid, state });
        return Promise.resolve();
      },
    },
    events: {
      publish(event) {
        if (failing.events) return Promise.reject(new Error('queue down'));
        events.push(event);
        return Promise.resolve();
      },
    },
    cursorKeys: KEYS,
    clock: () => clock.now,
    entitlementsTimeoutMs: 100,
  });

  /** A workspace with an owner, an admin, a member and a guest, each with a device. */
  async function seed() {
    const person = async () => {
      const user = await pgUser(db);
      const device = newId('dev');
      await db
        .insertInto('devices')
        .values({
          id: device,
          user_id: user,
          name: 'Laptop',
          platform: 'linux',
          x25519_pub: 'A'.repeat(43),
          ed25519_pub: 'B'.repeat(43),
          fingerprint: 'AAAA-BBBB-CCCC',
        })
        .execute();
      return { user, device };
    };
    const owner = await person();
    const workspace = await pgWorkspace(db, owner.user);
    await pgJoin(db, workspace, owner.user, 'owner');
    const admin = await person();
    await pgJoin(db, workspace, admin.user, 'admin');
    const member = await person();
    await pgJoin(db, workspace, member.user, 'member');
    const guest = await person();
    await pgJoin(db, workspace, guest.user, 'guest');
    return { workspace, owner, admin, member, guest };
  }

  /** `who` joins session `sid` as `role` (a session member row). */
  async function join(
    sid: string,
    who: { user: string; device: string },
    role: 'editor' | 'viewer',
    slot: number,
  ) {
    const id = newId('mem');
    await db
      .insertInto('session_members')
      .values({ id, session_id: sid, user_id: who.user, device_id: who.device, role, slot })
      .execute();
    return id;
  }

  /** The stored state of `sid`. */
  const stateOf = async (sid: string) => (await service.get(sid))?.state;

  return {
    clock,
    entitlements,
    relayed,
    events,
    failing,
    repository,
    service,
    seed,
    join,
    stateOf,
  };
}
