/**
 * Postgres fixtures for the dispatcher tests (B063; DATABASE_URL, CI's integration job): users,
 * workspaces with memberships, and sessions with members, written straight into a migrated
 * throwaway database.
 */
import { newId } from '@centcom/contracts';
import type { WorkspaceRole } from '@centcom/core';
import type { CoreDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';

export { ADMIN_URL, migratedDatabase } from '../../modules/users/helpers.js';

/** Inserts an active (or deleted) user; returns the id. */
export async function pgUser(
  db: Kysely<CoreDatabase>,
  status: 'active' | 'deleted' = 'active',
): Promise<string> {
  const id = newId('usr');
  await db
    .insertInto('users')
    .values({ id, email: `${id.toLowerCase()}@example.test`, display_name: 'User', status })
    .execute();
  return id;
}

/** Inserts a workspace created by `owner` (deleted when asked); returns the id. */
export async function pgWorkspace(
  db: Kysely<CoreDatabase>,
  owner: string,
  deleted = false,
): Promise<string> {
  const id = newId('wsp');
  await db
    .insertInto('workspaces')
    .values({
      id,
      name: 'Acme',
      slug: `acme-${id.slice(-8).toLowerCase()}`,
      created_by: owner,
      ...(deleted ? { deleted_at: new Date() } : {}),
    })
    .execute();
  return id;
}

export async function pgJoin(
  db: Kysely<CoreDatabase>,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<void> {
  await db
    .insertInto('memberships')
    .values({ id: newId('mem'), workspace_id: workspaceId, user_id: userId, role })
    .execute();
}

/** Inserts a session of `workspaceId`; returns the id. */
export async function pgSession(
  db: Kysely<CoreDatabase>,
  workspaceId: string,
  owner: string,
): Promise<string> {
  const id = newId('ses');
  await db
    .insertInto('sessions')
    .values({ id, workspace_id: workspaceId, name: 'Pairing', region: 'eu', created_by: owner })
    .execute();
  return id;
}

let slots = 0;

/** Adds `userId` to the session (with a device of theirs); returns the `mem_` id. */
export async function pgJoinSession(
  db: Kysely<CoreDatabase>,
  sessionId: string,
  userId: string,
  left = false,
): Promise<string> {
  const device = newId('dev');
  await db
    .insertInto('devices')
    .values({
      id: device,
      user_id: userId,
      name: 'Laptop',
      platform: 'linux',
      x25519_pub: 'A'.repeat(43),
      ed25519_pub: 'B'.repeat(43),
      fingerprint: 'AAAA-BBBB-CCCC',
    })
    .execute();
  const id = newId('mem');
  await db
    .insertInto('session_members')
    .values({
      id,
      session_id: sessionId,
      user_id: userId,
      device_id: device,
      role: 'editor',
      slot: slots++,
      ...(left ? { left_at: new Date() } : {}),
    })
    .execute();
  return id;
}
