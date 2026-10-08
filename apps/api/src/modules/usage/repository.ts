/**
 * The SQL of usage ingestion (B074): writing events and the lookups attribution needs.
 *
 * - `insertEvents` writes a batch in one statement, `on conflict (workspace_id, event_id) do
 *   nothing`: an event already stored (an earlier request, or a concurrent one) is a duplicate,
 *   and only new rows come back (their workspaces). So two requests carrying the same ids store
 *   each id once.
 * - `sessionAccess`: a session's workspace (when it is live) and whether the user takes part (a
 *   member row on any device, or the creator).
 * - `isMember` / `personalWorkspace`: as `/v1/me` resolves them (B022): a membership in a live
 *   workspace; the first live workspace the user created and owns.
 *
 * Owns: the statements. Must not: store anything but the contract fields, device and time.
 */
import type { UsageDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import type { UsageType } from './validate.js';

/** A row to store. */
export interface UsageRow {
  workspaceId: string;
  eventId: string;
  type: UsageType;
  qty: number;
  at: Date;
  sessionId: string | null;
  agentId: string | null;
  deviceId: string;
  receivedAt: Date;
}

/** What attribution reads. */
export interface AttributionStore {
  /**
   * The session's workspace (null when it has none or it is deleted) and whether `userId` takes
   * part in it; null when there is no such session.
   */
  sessionAccess(
    sessionId: string,
    userId: string,
  ): Promise<{ workspaceId: string | null; participant: boolean } | null>;
  /** Whether `userId` is a member of the live workspace `workspaceId`. */
  isMember(userId: string, workspaceId: string): Promise<boolean>;
  /** The user's personal workspace (the first live workspace they created and own), or null. */
  personalWorkspace(userId: string): Promise<string | null>;
}

/** Usage persistence. */
export interface UsageRepository extends AttributionStore {
  /** Stores the rows not stored yet; returns the workspace of each new row. */
  insertEvents(rows: readonly UsageRow[]): Promise<string[]>;
}

/** The repository on Postgres (table `usage_event`, migration 20260102002100). */
export function createUsageRepository<DB extends UsageDb>(database: Kysely<DB>): UsageRepository {
  // Kysely's types are invariant in the database type; only these tables are touched.
  const db = database as unknown as Kysely<UsageDb>;

  return {
    async insertEvents(rows) {
      if (rows.length === 0) return [];
      const inserted = await db
        .insertInto('usage_event')
        .values(
          rows.map((r) => ({
            workspace_id: r.workspaceId,
            event_id: r.eventId,
            type: r.type,
            qty: r.qty,
            at: r.at,
            session_id: r.sessionId,
            agent_id: r.agentId,
            device_id: r.deviceId,
            received_at: r.receivedAt,
          })),
        )
        .onConflict((oc) => oc.columns(['workspace_id', 'event_id']).doNothing())
        .returning('workspace_id')
        .execute();
      return inserted.map((r) => r.workspace_id);
    },

    async sessionAccess(sessionId, userId) {
      const session = await db
        .selectFrom('sessions')
        .leftJoin('workspaces', 'workspaces.id', 'sessions.workspace_id')
        .select(['sessions.workspace_id', 'sessions.created_by', 'workspaces.deleted_at'])
        .where('sessions.id', '=', sessionId)
        .executeTakeFirst();
      if (session === undefined) return null;
      let participant = session.created_by === userId;
      if (!participant) {
        const member = await db
          .selectFrom('session_members')
          .select('id')
          .where('session_id', '=', sessionId)
          .where('user_id', '=', userId)
          .executeTakeFirst();
        participant = member !== undefined;
      }
      const live = session.workspace_id !== null && session.deleted_at === null;
      return { workspaceId: live ? session.workspace_id : null, participant };
    },

    async isMember(userId, workspaceId) {
      const row = await db
        .selectFrom('memberships')
        .innerJoin('workspaces', 'workspaces.id', 'memberships.workspace_id')
        .select('memberships.id')
        .where('memberships.user_id', '=', userId)
        .where('memberships.workspace_id', '=', workspaceId)
        .where('workspaces.deleted_at', 'is', null)
        .executeTakeFirst();
      return row !== undefined;
    },

    async personalWorkspace(userId) {
      const row = await db
        .selectFrom('workspaces')
        .innerJoin('memberships', 'memberships.workspace_id', 'workspaces.id')
        .select('workspaces.id')
        .where('workspaces.created_by', '=', userId)
        .where('workspaces.deleted_at', 'is', null)
        .where('memberships.user_id', '=', userId)
        .where('memberships.role', '=', 'owner')
        .orderBy('workspaces.created_at')
        .orderBy('workspaces.id')
        .executeTakeFirst();
      return row?.id ?? null;
    },
  };
}
