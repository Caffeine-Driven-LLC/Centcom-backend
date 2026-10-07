/**
 * Postgres helpers for the audit tests (B036): a throwaway database with every migration applied
 * and a user to own workspaces, workspaces to point events at, and a valid event. They run only
 * with DATABASE_URL (CI's integration job).
 */
import { newId } from '@centcom/contracts';
import type { AuditEvent } from '@centcom/core';
import type { Kysely } from 'kysely';
import {
  closeDb,
  createDb,
  migrate,
  MIGRATIONS_DIR,
  type AuditDatabase,
  type CoreDatabase,
} from '../../src/index.js';
import { tempDatabase } from '../runner/helpers.js';

export { ADMIN_URL, onDatabase } from '../runner/helpers.js';

/** The core tables and audit_events. */
export type AuditTestDb = Kysely<CoreDatabase & AuditDatabase>;

/** A migrated throwaway database. */
export interface AuditTestDatabase {
  url: string;
  db: AuditTestDb;
  /** Owns the workspaces `addWorkspace` creates. */
  userId: string;
  drop: () => Promise<void>;
}

/** A new workspace owned by `userId`; returns its id. */
export async function addWorkspace(db: AuditTestDb, userId: string): Promise<string> {
  const id = newId('wsp');
  const slug = `ws-${id.slice(-10).toLowerCase()}`;
  await db
    .insertInto('workspaces')
    .values({ id, name: 'Acme', slug, created_by: userId })
    .execute();
  return id;
}

/** A throwaway database with every migration applied and one user. */
export async function auditDatabase(): Promise<AuditTestDatabase> {
  const { url, drop } = await tempDatabase();
  const db: AuditTestDb = createDb<CoreDatabase & AuditDatabase>({ url });
  const dropAll = async (): Promise<void> => {
    await closeDb(db);
    await drop();
  };
  try {
    await migrate(db, MIGRATIONS_DIR);
    const userId = newId('usr');
    await db
      .insertInto('users')
      .values({ id: userId, email: `${userId.toLowerCase()}@example.test`, display_name: 'Ada' })
      .execute();
    return { url, db, userId, drop: dropAll };
  } catch (err) {
    await dropAll();
    throw err;
  }
}

/** A valid event by `userId` in `workspaceId`. */
export function event(
  workspaceId: string,
  userId: string,
  overrides: Partial<AuditEvent> = {},
): AuditEvent {
  return {
    workspaceId,
    actor: { type: 'user', id: userId },
    action: 'workspace.update',
    target: { type: 'workspace', id: workspaceId },
    outcome: 'success',
    meta: { fields: 'name' },
    ...overrides,
  };
}
