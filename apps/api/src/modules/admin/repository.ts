/**
 * The admin API's reads and writes (B087), and the audit record of every call.
 *
 * - `reader`: lookups on the pool (users, devices, memberships, workspaces, sessions, staff, the
 *   staff audit). Columns are chosen one by one: no key material, token hash or content is read.
 * - `transaction(fn)`: one transaction in which `fn`'s writes and the call's audit rows (the
 *   `staff.access` event and its `staff_audit_details` row) commit together, or neither does.
 *
 * The transaction is Kysely's own, not B007's `withTransaction`: while it is open the admin API
 * calls other modules (flags, status, tokens) that run their own transactions on other
 * connections, which `withTransaction` refuses inside another. That is the intent: the audit row
 * is written first and commits only if the action succeeds (routes/internal-admin.ts), so the two
 * need not share a connection.
 *
 * Owns: the queries. Must not: read or return content, keys or credentials.
 */
import type { AuditEmitter, AuditEvent } from '@centcom/core';
import type { AdminDatabase, StaffRole, UserStatus } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import type { Api } from '@centcom/contracts';
import { STAFF_ACCESS_ACTION, type AdminAuditAction } from './actions.js';

/** A user, as the admin API reads one. */
export interface UserRecord {
  id: string;
  email: string;
  display_name: string;
  status: UserStatus;
  created_at: Date;
  deletion_requested_at: Date | null;
  login_disabled_at: Date | null;
}

/** A device, without its keys. */
export interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  created_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

/** One of a user's memberships. */
export interface MembershipRecord {
  id: string;
  workspace_id: string;
  role: Api.Role;
  created_at: Date;
}

/** A workspace. */
export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  created_at: Date;
  deleted_at: Date | null;
}

/** A workspace member with their user's address and name. */
export interface MemberRecord {
  id: string;
  user_id: string;
  email: string;
  display_name: string;
  role: Api.Role;
  created_at: Date;
}

/** A session's metadata. */
export interface SessionRecord {
  id: string;
  workspace_id: string | null;
  state: Api.Session['state'];
  region: string;
  created_at: Date;
  ended_at: Date | null;
  member_count: number;
  host_member: string | null;
}

/** A staff row. */
export interface StaffRecord {
  user_id: string;
  role: StaffRole;
  added_by: string | null;
  added_at: Date;
  disabled_at: Date | null;
}

/** A `staff.access` event with its reason and ticket. */
export interface StaffAuditRecord {
  id: string;
  created_at: Date;
  actor_type: string;
  actor_id: string;
  outcome: 'success' | 'denied' | 'failed';
  target_type: string | null;
  target_id: string | null;
  meta: Record<string, unknown>;
  reason: string | null;
  ticket: string | null;
}

/** Where a page of the staff audit starts, and what it is filtered by. */
export interface StaffAuditQuery {
  limit: number;
  /** The last row of the previous page. */
  after?: { at: string; id: string };
  actor?: string;
  target?: string;
}

/** Lookups. */
export interface AdminReader {
  user(id: string): Promise<UserRecord | null>;
  userByEmail(email: string): Promise<UserRecord | null>;
  devices(userId: string): Promise<DeviceRecord[]>;
  memberships(userId: string): Promise<MembershipRecord[]>;
  workspace(id: string): Promise<WorkspaceRecord | null>;
  /** The first `limit` members, oldest first, and how many there are. */
  members(workspaceId: string, limit: number): Promise<{ rows: MemberRecord[]; total: number }>;
  session(id: string): Promise<SessionRecord | null>;
  staff(userId: string): Promise<StaffRecord | null>;
  /** Up to `q.limit` events, newest first. */
  staffAudit(q: StaffAuditQuery): Promise<StaffAuditRecord[]>;
}

/** The reason and ticket of a call. */
export interface CallDetails {
  reason: string | null;
  ticket: string | null;
}

/** Lookups and writes in one transaction. */
export interface AdminWriter extends AdminReader {
  /** Sets `login_disabled_at` (kept when already set); null for an unknown user. */
  disableLogin(userId: string, at: Date): Promise<Date | null>;
  /** Ends the session (kept when already over); false for an unknown one. */
  endSession(id: string, at: Date): Promise<boolean>;
  /** Adds or changes (and re-enables) a staff row. */
  putStaff(userId: string, role: StaffRole, by: string, at: Date): Promise<StaffRecord>;
  /** Disables a staff row; null when there is none. */
  disableStaff(userId: string, at: Date): Promise<StaffRecord | null>;
  /** Writes the call's event and its details; resolves to the event's `aud_` id. */
  record(event: AuditEvent<AdminAuditAction>, details: CallDetails): Promise<string>;
}

/** The admin API's store. */
export interface AdminStore {
  reader: AdminReader;
  /** Runs `fn` in one transaction: committed when it resolves, rolled back when it throws. */
  transaction<T>(fn: (tx: AdminWriter) => Promise<T>): Promise<T>;
}

/** What the Postgres store needs. */
export interface AdminStoreDeps {
  db: Kysely<AdminDatabase>;
  /** An emitter with ADMIN_AUDIT_ACTIONS. */
  emitter: Pick<AuditEmitter<AdminAuditAction>, 'emit'>;
}

const USER_COLUMNS = [
  'id',
  'email',
  'display_name',
  'status',
  'created_at',
  'deletion_requested_at',
  'login_disabled_at',
] as const;

const STAFF_COLUMNS = ['user_id', 'role', 'added_by', 'added_at', 'disabled_at'] as const;

function readerOf(db: Kysely<AdminDatabase>): AdminReader {
  return {
    async user(id) {
      return (
        (await db
          .selectFrom('users')
          .select(USER_COLUMNS)
          .where('id', '=', id)
          .executeTakeFirst()) ?? null
      );
    },
    async userByEmail(email) {
      // users.email is citext: the match ignores case.
      return (
        (await db
          .selectFrom('users')
          .select(USER_COLUMNS)
          .where('email', '=', email)
          .executeTakeFirst()) ?? null
      );
    },
    devices(userId) {
      return db
        .selectFrom('devices')
        .select(['id', 'name', 'platform', 'created_at', 'last_seen_at', 'revoked_at'])
        .where('user_id', '=', userId)
        .orderBy('created_at')
        .orderBy('id')
        .limit(200)
        .execute();
    },
    memberships(userId) {
      return db
        .selectFrom('memberships')
        .select(['id', 'workspace_id', 'role', 'created_at'])
        .where('user_id', '=', userId)
        .orderBy('created_at')
        .orderBy('id')
        .limit(200)
        .execute();
    },
    async workspace(id) {
      return (
        (await db
          .selectFrom('workspaces')
          .select(['id', 'name', 'slug', 'created_at', 'deleted_at'])
          .where('id', '=', id)
          .executeTakeFirst()) ?? null
      );
    },
    async members(workspaceId, limit) {
      const [rows, count] = await Promise.all([
        db
          .selectFrom('memberships as m')
          .innerJoin('users as u', 'u.id', 'm.user_id')
          .select(['m.id', 'm.user_id', 'u.email', 'u.display_name', 'm.role', 'm.created_at'])
          .where('m.workspace_id', '=', workspaceId)
          .orderBy('m.created_at')
          .orderBy('m.id')
          .limit(limit)
          .execute(),
        db
          .selectFrom('memberships')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('workspace_id', '=', workspaceId)
          .executeTakeFirstOrThrow(),
      ]);
      return { rows, total: Number(count.n) };
    },
    async session(id) {
      const row = await db
        .selectFrom('sessions as s')
        .select((eb) => [
          's.id',
          's.workspace_id',
          's.state',
          's.region',
          's.created_at',
          's.ended_at',
          eb
            .selectFrom('session_members as m')
            .select((inner) => inner.fn.countAll<string>().as('n'))
            .whereRef('m.session_id', '=', 's.id')
            .where('m.left_at', 'is', null)
            .as('member_count'),
          eb
            .selectFrom('session_members as m')
            .select('m.id')
            .whereRef('m.session_id', '=', 's.id')
            .where('m.role', '=', 'host')
            .where('m.left_at', 'is', null)
            .orderBy('m.joined_at')
            .limit(1)
            .as('host_member'),
        ])
        .where('s.id', '=', id)
        .executeTakeFirst();
      if (row === undefined) return null;
      return { ...row, member_count: Number(row.member_count ?? 0), host_member: row.host_member };
    },
    async staff(userId) {
      return (
        (await db
          .selectFrom('staff_users')
          .select(STAFF_COLUMNS)
          .where('user_id', '=', userId)
          .executeTakeFirst()) ?? null
      );
    },
    async staffAudit(q) {
      let query = db
        .selectFrom('audit_events as e')
        .leftJoin('staff_audit_details as d', 'd.audit_id', 'e.id')
        .select([
          'e.id',
          'e.created_at',
          'e.actor_type',
          'e.actor_id',
          'e.outcome',
          'e.target_type',
          'e.target_id',
          'e.meta',
          'd.reason',
          'd.ticket',
        ])
        .where('e.action', '=', STAFF_ACCESS_ACTION);
      if (q.actor !== undefined) query = query.where('e.actor_id', '=', q.actor);
      if (q.target !== undefined) query = query.where('e.target_id', '=', q.target);
      if (q.after !== undefined) {
        const { at, id } = q.after;
        query = query.where(sql<boolean>`(e.created_at, e.id) < (${at}::timestamptz, ${id})`);
      }
      const rows = await query
        .orderBy('e.created_at', 'desc')
        .orderBy('e.id', 'desc')
        .limit(q.limit)
        .execute();
      return rows.map((r) => ({ ...r, meta: r.meta as Record<string, unknown> }));
    },
  };
}

function writerOf(trx: Kysely<AdminDatabase>, deps: AdminStoreDeps): AdminWriter {
  return {
    ...readerOf(trx),
    async disableLogin(userId, at) {
      const row = await trx
        .updateTable('users')
        .set({ login_disabled_at: sql`coalesce(login_disabled_at, ${at})`, updated_at: at })
        .where('id', '=', userId)
        .returning('login_disabled_at')
        .executeTakeFirst();
      return row?.login_disabled_at ?? null;
    },
    async endSession(id, at) {
      const result = await trx
        .updateTable('sessions')
        .set({
          state: sql`case when state in ('ended', 'expired') then state else 'ended' end`,
          ended_at: sql`coalesce(ended_at, ${at})`,
        })
        .where('id', '=', id)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },
    async putStaff(userId, role, by, at) {
      return trx
        .insertInto('staff_users')
        .values({ user_id: userId, role, added_by: by, added_at: at, updated_at: at })
        .onConflict((oc) =>
          oc.column('user_id').doUpdateSet({
            role,
            added_by: by,
            disabled_at: null,
            updated_at: at,
          }),
        )
        .returning(STAFF_COLUMNS)
        .executeTakeFirstOrThrow();
    },
    async disableStaff(userId, at) {
      return (
        (await trx
          .updateTable('staff_users')
          .set({ disabled_at: sql`coalesce(disabled_at, ${at})`, updated_at: at })
          .where('user_id', '=', userId)
          .returning(STAFF_COLUMNS)
          .executeTakeFirst()) ?? null
      );
    },
    async record(event, details) {
      const id = await deps.emitter.emit(trx, event);
      await trx
        .insertInto('staff_audit_details')
        .values({ audit_id: id, reason: details.reason, ticket: details.ticket })
        .execute();
      return id;
    },
  };
}

/** The store on Postgres. */
export function createAdminStore(deps: AdminStoreDeps): AdminStore {
  return {
    reader: readerOf(deps.db),
    transaction: (fn) => deps.db.transaction().execute((trx) => fn(writerOf(trx, deps))),
  };
}
