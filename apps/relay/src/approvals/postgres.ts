/**
 * Deciders on Postgres (B060): a session member's live role and, for a session in a workspace,
 * the user's workspace role (CT-WS-SESSION-EVENTS `approver: owner` = workspace owner or admin
 * members present in the session). The rules of B043's live membership apply: a member who left,
 * or whose workspace membership or workspace is gone, is not a decider, and the session role is
 * capped by the workspace role (`capRole`). Read on every decision (no cache): approvals are rare,
 * and a role change counts at once. `members` lists the session's current deciders this way for
 * the notification's recipients.
 *
 * Owns: the SQL. Must not: decide who may approve (router.ts does).
 */
import type { RelayDb } from '../modules.js';
import { capRole } from '../rooms/membership.js';
import type { SessionDecider } from './notify.js';
import type { Decider } from './ports.js';

/** A member row with what decides its live roles. */
interface MemberRow {
  id: string;
  role: string;
  user_id: string;
  left_at: Date | null;
  workspace_id: string | null;
  workspace_deleted_at: Date | null;
  workspace_role: string | null;
}

/** The member's live roles, or null when it is no member now. */
function liveDecider(row: MemberRow): Decider | null {
  if (row.left_at !== null) return null;
  if (row.workspace_id !== null) {
    // The user must still be a member of a live workspace.
    if (row.workspace_role === null || row.workspace_deleted_at !== null) return null;
  }
  const role = capRole(row.role as Parameters<typeof capRole>[0], row.workspace_role);
  if (role === null) return null;
  return {
    role,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    workspaceRole: row.workspace_role,
  };
}

/** Deciders over Postgres. */
export function createPostgresDeciders(db: RelayDb): {
  get(sid: string, mid: string): Promise<Decider | null>;
  members(sid: string): Promise<SessionDecider[]>;
} {
  const rows = (sid: string) =>
    db
      .selectFrom('session_members as sm')
      .innerJoin('sessions as s', 's.id', 'sm.session_id')
      .leftJoin('workspaces as w', 'w.id', 's.workspace_id')
      .leftJoin('memberships as m', (join) =>
        join.onRef('m.workspace_id', '=', 's.workspace_id').onRef('m.user_id', '=', 'sm.user_id'),
      )
      .select([
        'sm.id',
        'sm.role',
        'sm.user_id',
        'sm.left_at',
        's.workspace_id',
        'w.deleted_at as workspace_deleted_at',
        'm.role as workspace_role',
      ])
      .where('sm.session_id', '=', sid);
  return {
    async get(sid, mid) {
      const row = await rows(sid).where('sm.id', '=', mid).executeTakeFirst();
      return row === undefined ? null : liveDecider(row);
    },
    async members(sid) {
      const out: SessionDecider[] = [];
      for (const row of await rows(sid).where('sm.left_at', 'is', null).execute()) {
        const d = liveDecider(row);
        if (d !== null)
          out.push({ memberId: row.id, role: d.role, workspaceRole: d.workspaceRole });
      }
      return out;
    },
  };
}
