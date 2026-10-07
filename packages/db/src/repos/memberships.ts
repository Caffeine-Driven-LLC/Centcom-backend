/**
 * Membership roles for RBAC (B021): the Postgres `MembershipReader` of @centcom/core. A workspace
 * role comes from `memberships` (none while the workspace is soft-deleted); a session role from
 * the member's live `session_members` rows (not left), the most powerful when a user sits in the
 * session on several devices. Wrap it in `cachedMembershipReader` (2 s).
 *
 * Owns: the SQL of role lookups. Must not: read a role from anywhere but these tables.
 */
import {
  isSessionRole,
  isWorkspaceRole,
  type MembershipReader,
  type SessionRole,
} from '@centcom/core';
import type { Kysely } from 'kysely';
import type { CoreDatabase } from '../schema/core.js';

const SESSION_RANK: Record<SessionRole, number> = { host: 0, editor: 1, viewer: 2 };

/** Role lookups over `db`. */
export function createMembershipRepo(db: Kysely<CoreDatabase>): MembershipReader {
  return {
    async workspaceRole(userId, workspaceId) {
      const row = await db
        .selectFrom('memberships')
        .innerJoin('workspaces', 'workspaces.id', 'memberships.workspace_id')
        .select('memberships.role')
        .where('memberships.workspace_id', '=', workspaceId)
        .where('memberships.user_id', '=', userId)
        .where('workspaces.deleted_at', 'is', null)
        .executeTakeFirst();
      return isWorkspaceRole(row?.role) ? row.role : null;
    },
    async sessionRole(userId, sessionId) {
      const rows = await db
        .selectFrom('session_members')
        .select('role')
        .where('session_id', '=', sessionId)
        .where('user_id', '=', userId)
        .where('left_at', 'is', null)
        .execute();
      const roles = rows.map((row) => row.role).filter(isSessionRole);
      if (roles.length === 0) return null;
      return roles.reduce((best, role) => (SESSION_RANK[role] < SESSION_RANK[best] ? role : best));
    },
  };
}
