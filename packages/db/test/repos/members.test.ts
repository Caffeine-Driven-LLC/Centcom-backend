/**
 * The member store on Postgres 16 (B028; DATABASE_URL, CI's integration job), in a throwaway
 * database with every migration: members of live workspaces only, with names and addresses,
 * oldest first by keyset; role changes and removals in one transaction; a user added once (the
 * unique pair) and never a second owner (B027's index); and owner changes taking turns on the
 * workspace row, so a second transfer sees the first one's outcome.
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { newId } from '@centcom/contracts';
import { Secret, type SigningKeys } from '@centcom/core';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDb,
  createDb,
  createMemberStore,
  createWorkspaceStore,
  migrate,
  MIGRATIONS_DIR,
  type CoreDatabase,
  type MemberStore,
} from '../../src/index.js';
import { ADMIN_URL, tempDatabase } from '../runner/helpers.js';

const KEYS: SigningKeys = [{ id: 'k1', secret: new Secret(new Uint8Array(randomBytes(32))) }];

describe.runIf(ADMIN_URL !== undefined)('the member store on Postgres 16', () => {
  let db: Kysely<CoreDatabase>;
  let drop: () => Promise<void>;
  let members: MemberStore;
  beforeAll(async () => {
    let url: string;
    ({ url, drop } = await tempDatabase());
    db = createDb<CoreDatabase>({ url });
    await migrate(db, MIGRATIONS_DIR);
    members = createMemberStore(db);
  }, 60_000);
  afterAll(async () => {
    await closeDb(db);
    await drop();
  });

  const addUser = async (displayName = 'Ada'): Promise<string> => {
    const id = newId('usr');
    await db
      .insertInto('users')
      .values({ id, email: `${id.toLowerCase()}@example.test`, display_name: displayName })
      .execute();
    return id;
  };
  /** A workspace owned by `owner`, with members of the given roles; returns ids. */
  const workspace = async (
    owner: string,
    roles: ('admin' | 'member' | 'billing' | 'guest')[],
  ): Promise<{ id: string; mems: string[]; users: string[] }> => {
    const id = newId('wsp');
    await createWorkspaceStore(db).transaction((tx) =>
      tx.insert({
        id,
        name: 'Acme',
        slug: `ws-${randomBytes(4).toString('hex')}`,
        ownerId: owner,
        membershipId: newId('mem'),
      }),
    );
    const mems: string[] = [];
    const users: string[] = [];
    for (const role of roles) {
      const userId = await addUser(`Member ${role}`);
      const added = await members.transaction((tx) =>
        tx.add({ id: newId('mem'), workspaceId: id, userId, role }),
      );
      mems.push(added?.id ?? '');
      users.push(userId);
    }
    return { id, mems, users };
  };

  it('lists live members with names and addresses, oldest first, by keyset', async () => {
    const owner = await addUser('Owner');
    const { id, mems } = await workspace(owner, ['admin', 'member', 'billing', 'guest']);
    const params = { sort: 'joined', filterHash: 'f', keys: KEYS, now: Date.now() };
    const first = await members.list(id, { ...params, limit: 3 });
    const second = await members.list(id, { ...params, limit: 3, cursor: first.next_cursor ?? '' });
    const all = [...first.data, ...second.data];
    expect(all.map((m) => m.role)).toEqual(['owner', 'admin', 'member', 'billing', 'guest']);
    expect(all.slice(1).map((m) => m.id)).toEqual(mems);
    expect(all[0]).toMatchObject({
      workspaceId: id,
      userId: owner,
      displayName: 'Owner',
      email: `${owner.toLowerCase()}@example.test`,
    });
    expect(all[0]?.joinedAt).toBeInstanceOf(Date);
    expect(second.next_cursor).toBeNull();
    expect((await members.getLive(id, owner))?.role).toBe('owner');
    expect(await members.get(id, newId('mem'))).toBeNull();
    await createWorkspaceStore(db).transaction((tx) => tx.softDelete(id));
    expect((await members.list(id, { ...params, limit: 10 })).data).toEqual([]);
    expect(await members.get(id, mems[0] ?? '')).toBeNull();
    expect(await members.getLive(id, owner)).toBeNull();
  });

  it('changes a role and removes a member in one transaction, under row locks', async () => {
    const owner = await addUser();
    const { id, mems, users } = await workspace(owner, ['member', 'guest']);
    const [member, guest] = mems;
    await members.transaction(async (tx) => {
      expect(await tx.lockWorkspace(id)).toBe(true);
      expect(await tx.lockWorkspace(newId('wsp'))).toBe(false);
      expect((await tx.lockMember(id, member ?? ''))?.role).toBe('member');
      expect(await tx.lockMember(newId('wsp'), member ?? '')).toBeNull();
      expect((await tx.lockMemberOf(id, users[1] ?? ''))?.id).toBe(guest);
      await tx.setRole(member ?? '', 'billing');
      await tx.remove(guest ?? '');
    });
    expect((await members.get(id, member ?? ''))?.role).toBe('billing');
    expect(await members.get(id, guest ?? '')).toBeNull();
    // A failing transaction leaves nothing behind.
    await expect(
      members.transaction(async (tx) => {
        await tx.setRole(member ?? '', 'admin');
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect((await members.get(id, member ?? ''))?.role).toBe('billing');
  });

  it('adds a user once, and never a second owner', async () => {
    const owner = await addUser();
    const { id, mems, users } = await workspace(owner, ['admin']);
    const again = await members.transaction((tx) =>
      tx.add({ id: newId('mem'), workspaceId: id, userId: users[0] ?? '', role: 'member' }),
    );
    expect(again).toBeNull();
    const err = await members
      .transaction((tx) => tx.setRole(mems[0] ?? '', 'owner'))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: '23505', constraint: 'memberships_workspace_id_owner_key' });
  });

  it('makes owner changes take turns on the workspace row', async () => {
    const owner = await addUser();
    const { id, mems } = await workspace(owner, ['admin']);
    const ownerMem = (await members.getLive(id, owner))?.id ?? '';
    const first = members.transaction(async (tx) => {
      await tx.lockWorkspace(id);
      await sleep(300);
      await tx.setRole(ownerMem, 'admin');
      await tx.setRole(mems[0] ?? '', 'owner');
    });
    await sleep(100);
    const second = members.transaction(async (tx) => {
      await tx.lockWorkspace(id);
      return (await tx.lockMemberOf(id, owner))?.role;
    });
    const [, seen] = await Promise.all([first, second]);
    expect(seen).toBe('admin');
  });
});
