/**
 * The sessions repository (B053): session rows, the host's member row and slot, the policy
 * defaults (B051's `session_policy`), the outbox, and the conditional transitions.
 *
 * - **Transitions** are `UPDATE … WHERE id = ? AND state IN (sources) [AND still due]
 *   RETURNING`, with the outbox row inserted in the same transaction. A transition another
 *   instance already made matches no row and returns null, so it is never applied twice.
 * - **The sweep** (`pauseDue`, `expireDue`) does the same in bulk, under a transaction-scoped
 *   advisory lock (`SWEEP_LOCK_KEY`). A second sweeper running at the same time skips the run and
 *   reports nothing. Each run touches at most `limit` rows, and the next run takes the rest.
 * - **Lists** page by id (ULID) descending through @centcom/core's keyset `paginate`, so rows
 *   inserted between pages never repeat or shift a page.
 * - Rows are never deleted here (retention jobs own deletion).
 *
 * Owns: the SQL. Must not: decide who may act or what a transition is (the service and the state
 * machine do).
 */
import { paginate, type Page, type SigningKeys } from '@centcom/core';
import type { createDb, SessionsLifecycleDatabase } from '@centcom/db';
import { sql, type Transaction } from 'kysely';
import { PAUSED_EXPIRY_MS } from './host-loss.js';
import type { SessionPolicyDefaults } from './ports.js';
import type { SessionState } from './state-machine.js';

/** The API's client over the sessions tables. */
export type SessionsDb = ReturnType<typeof createDb<SessionsLifecycleDatabase>>;
type Tx = Transaction<SessionsLifecycleDatabase>;

/** `pg_try_advisory_xact_lock` key of the expiry sweep. */
export const SWEEP_LOCK_KEY = 53_053;

/** A session row. */
export interface SessionRow {
  id: string;
  workspace_id: string | null;
  name: string;
  state: SessionState;
  region: string;
  created_by: string;
  created_at: Date;
  ended_at: Date | null;
  host_member_id: string | null;
  host_connected: boolean;
  last_host_seen_at: Date;
  paused_at: Date | null;
  expires_at: Date | null;
  end_reason: 'done' | 'abandoned' | 'error' | 'expired' | null;
}

/** A row with its policy (null: the defaults). */
export interface StoredSession {
  row: SessionRow;
  policy: SessionPolicyDefaults | null;
}

/** An outbox row to deliver. */
export interface OutboxRow {
  id: string;
  sessionId: string;
  state: SessionState;
  eventType: 'session.created' | 'session.started' | 'session.ended' | null;
  eventId: string;
  relaySent: boolean;
  eventSent: boolean;
  attempts: number;
  createdAt: Date;
  /** The session as it is now (the relay is told its current state; the event's data). */
  currentState: SessionState;
  workspaceId: string | null;
  name: string;
  host: string | null;
  createdBy: string;
}

/** What a new session is written with. */
export interface NewSession {
  id: string;
  workspaceId: string;
  name: string;
  region: string;
  createdBy: string;
  at: Date;
  host: { id: string; userId: string; deviceId: string };
  policy?: SessionPolicyDefaults;
}

/** The filters of a list. */
export interface ListQuery {
  workspace?: string;
  state?: SessionState;
  /** Sessions this user is a current member of. */
  mineUserId?: string;
  limit: number;
  cursor?: string;
}

const COLUMNS = [
  'sessions.id',
  'sessions.workspace_id',
  'sessions.name',
  'sessions.state',
  'sessions.region',
  'sessions.created_by',
  'sessions.created_at',
  'sessions.ended_at',
  'sessions.host_member_id',
  'sessions.host_connected',
  'sessions.last_host_seen_at',
  'sessions.paused_at',
  'sessions.expires_at',
  'sessions.end_reason',
] as const;

const POLICY_COLUMNS = [
  'session_policy.auto_approve',
  'session_policy.share_history',
  'session_policy.queue_limit',
  'session_policy.locked',
  'session_policy.auto_failover',
] as const;

type Joined = SessionRow & {
  auto_approve: SessionPolicyDefaults['auto_approve'] | null;
  share_history: boolean | null;
  queue_limit: number | null;
  locked: boolean | null;
  auto_failover: boolean | null;
};

function split(r: Joined): StoredSession {
  const { auto_approve, share_history, queue_limit, locked, auto_failover, ...row } = r;
  return {
    row,
    policy:
      auto_approve === null
        ? null
        : {
            auto_approve,
            share_history: share_history ?? false,
            queue_limit: queue_limit ?? 20,
            locked: locked ?? false,
            auto_failover: auto_failover ?? false,
          },
  };
}

/** The repository over `db`. */
export function createSessionRepository(db: SessionsDb) {
  const selectSession = (q: SessionsDb | Tx) =>
    q
      .selectFrom('sessions')
      .leftJoin('session_policy', 'session_policy.session_id', 'sessions.id')
      .select([...COLUMNS, ...POLICY_COLUMNS]);

  async function insertOutbox(
    trx: Tx,
    sid: string,
    state: SessionState,
    eventType: OutboxRow['eventType'],
  ): Promise<void> {
    await trx
      .insertInto('session_outbox')
      .values({ session_id: sid, state, event_type: eventType })
      .execute();
  }

  async function upsertPolicy(trx: Tx | SessionsDb, sid: string, policy: SessionPolicyDefaults) {
    const values = {
      auto_approve: policy.auto_approve,
      share_history: policy.share_history,
      queue_limit: policy.queue_limit,
      locked: policy.locked,
      auto_failover: policy.auto_failover,
    };
    await trx
      .insertInto('session_policy')
      .values({ session_id: sid, ...values })
      .onConflict((oc) =>
        oc.column('session_id').doUpdateSet({ ...values, updated_at: new Date() }),
      )
      .execute();
  }

  const repo = {
    /** Writes the session (live), its host member (slot 0), its policy and the outbox row. */
    async insert(s: NewSession): Promise<StoredSession> {
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('sessions')
          .values({
            id: s.id,
            workspace_id: s.workspaceId,
            name: s.name,
            state: 'live',
            region: s.region,
            created_by: s.createdBy,
            created_at: s.at,
            host_member_id: s.host.id,
            host_connected: false,
            last_host_seen_at: s.at,
            updated_at: s.at,
          })
          .execute();
        await trx
          .insertInto('session_members')
          .values({
            id: s.host.id,
            session_id: s.id,
            user_id: s.host.userId,
            device_id: s.host.deviceId,
            role: 'host',
            slot: 0,
            joined_at: s.at,
          })
          .execute();
        await trx
          .insertInto('session_member_slots')
          .values({ session_id: s.id, member_id: s.host.id, slot: 0 })
          .execute();
        if (s.policy !== undefined) await upsertPolicy(trx, s.id, s.policy);
        await insertOutbox(trx, s.id, 'live', 'session.created');
      });
      const stored = await repo.get(s.id);
      if (stored === null) throw new Error('sessions: the new session is gone');
      return stored;
    },

    async get(id: string): Promise<StoredSession | null> {
      const r = await selectSession(db).where('sessions.id', '=', id).executeTakeFirst();
      return r === undefined ? null : split(r as Joined);
    },

    /** A page of sessions, newest first. */
    async list(
      q: ListQuery,
      paging: { keys: SigningKeys; now: number; filterHash: string },
    ): Promise<Page<StoredSession>> {
      let query = selectSession(db);
      if (q.workspace !== undefined) query = query.where('sessions.workspace_id', '=', q.workspace);
      if (q.state !== undefined) query = query.where('sessions.state', '=', q.state);
      if (q.mineUserId !== undefined) {
        const user = q.mineUserId;
        query = query.where(({ exists, selectFrom }) =>
          exists(
            selectFrom('session_members')
              .select('session_members.id')
              .whereRef('session_members.session_id', '=', 'sessions.id')
              .where('session_members.user_id', '=', user)
              .where('session_members.left_at', 'is', null),
          ),
        );
      }
      const result = await paginate(
        query,
        { sorts: { id: { column: 'sessions.id', direction: 'desc' } }, idColumn: 'sessions.id' },
        {
          limit: q.limit,
          ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
          sort: 'id',
          filterHash: paging.filterHash,
          keys: paging.keys,
          now: paging.now,
        },
      );
      return { ...result, data: result.data.map((r) => split(r as Joined)) };
    },

    /** Sessions of the workspace that are not over (live, paused, pending). */
    async countActive(workspaceId: string): Promise<number> {
      const r = await db
        .selectFrom('sessions')
        .select(db.fn.countAll<string>().as('n'))
        .where('workspace_id', '=', workspaceId)
        .where('state', 'in', ['pending', 'live', 'paused'])
        .executeTakeFirstOrThrow();
      return Number(r.n);
    },

    /** `userId`'s role in workspace `workspaceId`, or null. */
    async workspaceRole(workspaceId: string, userId: string): Promise<string | null> {
      const r = await db
        .selectFrom('memberships')
        .select('role')
        .where('workspace_id', '=', workspaceId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      return r?.role ?? null;
    },

    /** `userId`'s current member id in session `sid`, or null. */
    async memberOf(sid: string, userId: string): Promise<string | null> {
      const r = await db
        .selectFrom('session_members')
        .select('id')
        .where('session_id', '=', sid)
        .where('user_id', '=', userId)
        .where('left_at', 'is', null)
        .orderBy('joined_at', 'desc')
        .executeTakeFirst();
      return r?.id ?? null;
    },

    /**
     * Moves `id` from one of `from` to `to` with `patch`, and writes the outbox row, in one
     * transaction; null when the row was not in one of `from` (nothing written).
     */
    async transition(
      id: string,
      from: readonly SessionState[],
      to: SessionState,
      patch: {
        at: Date;
        endReason?: SessionRow['end_reason'];
        eventType: OutboxRow['eventType'];
        hostSeen?: boolean;
      },
    ): Promise<StoredSession | null> {
      const moved = await db.transaction().execute(async (trx) => {
        const r = await trx
          .updateTable('sessions')
          .set({
            state: to,
            updated_at: patch.at,
            ...(to === 'paused'
              ? { paused_at: patch.at, expires_at: new Date(patch.at.getTime() + PAUSED_EXPIRY_MS) }
              : { expires_at: null }),
            ...(to === 'ended' || to === 'expired'
              ? { ended_at: patch.at, end_reason: patch.endReason ?? null }
              : {}),
            ...(patch.hostSeen === true
              ? { host_connected: true, last_host_seen_at: patch.at }
              : {}),
          })
          .where('id', '=', id)
          .where('state', 'in', [...from])
          .returning('id')
          .executeTakeFirst();
        if (r === undefined) return false;
        await insertOutbox(trx, id, to, patch.eventType);
        return true;
      });
      return moved ? repo.get(id) : null;
    },

    /** Records the host connected (`at`) or gone (last seen `at`). */
    async setHostSeen(id: string, connected: boolean, at: Date): Promise<void> {
      await db
        .updateTable('sessions')
        .set({ host_connected: connected, last_host_seen_at: at, updated_at: at })
        .where('id', '=', id)
        .execute();
    },

    async rename(id: string, name: string, at: Date): Promise<boolean> {
      const r = await db
        .updateTable('sessions')
        .set({ name, updated_at: at })
        .where('id', '=', id)
        .where('state', 'in', ['pending', 'live', 'paused'])
        .executeTakeFirst();
      return Number(r.numUpdatedRows) === 1;
    },

    setPolicy: (id: string, policy: SessionPolicyDefaults) => upsertPolicy(db, id, policy),

    /**
     * The sweep, under the advisory lock: pauses live sessions whose host was last seen at or
     * before `pauseCutoff`, and expires sessions paused at or before `expireCutoff`, `limit` each.
     * Null when another sweeper holds the lock.
     */
    async sweep(
      now: Date,
      pauseCutoff: Date,
      expireCutoff: Date,
      limit: number,
    ): Promise<{ paused: string[]; expired: string[] } | null> {
      return db.transaction().execute(async (trx) => {
        const locked = await sql<{
          ok: boolean;
        }>`select pg_try_advisory_xact_lock(${SWEEP_LOCK_KEY}) as ok`.execute(trx);
        if (locked.rows[0]?.ok !== true) return null;
        const paused = await trx
          .updateTable('sessions')
          .set({
            state: 'paused',
            paused_at: now,
            expires_at: new Date(now.getTime() + PAUSED_EXPIRY_MS),
            updated_at: now,
          })
          .where('id', 'in', (eb) =>
            eb
              .selectFrom('sessions')
              .select('id')
              .where('state', 'in', ['pending', 'live'])
              .where('host_connected', '=', false)
              .where('last_host_seen_at', '<=', pauseCutoff)
              .orderBy('last_host_seen_at')
              .limit(limit),
          )
          .where('state', 'in', ['pending', 'live'])
          .where('host_connected', '=', false)
          .returning('id')
          .execute();
        const expired = await trx
          .updateTable('sessions')
          .set({
            state: 'expired',
            ended_at: now,
            end_reason: 'expired',
            expires_at: null,
            updated_at: now,
          })
          .where('id', 'in', (eb) =>
            eb
              .selectFrom('sessions')
              .select('id')
              .where('state', '=', 'paused')
              .where('paused_at', '<=', expireCutoff)
              .orderBy('paused_at')
              .limit(limit),
          )
          .where('state', '=', 'paused')
          .returning('id')
          .execute();
        for (const r of paused) await insertOutbox(trx, r.id, 'paused', null);
        for (const r of expired) await insertOutbox(trx, r.id, 'expired', 'session.ended');
        return { paused: paused.map((r) => r.id), expired: expired.map((r) => r.id) };
      });
    },

    /** Outbox rows due at `now` (oldest first), with their session. */
    async pendingOutbox(now: Date, limit: number, sessionId?: string): Promise<OutboxRow[]> {
      let q = db
        .selectFrom('session_outbox')
        .innerJoin('sessions', 'sessions.id', 'session_outbox.session_id')
        .select([
          'session_outbox.id',
          'session_outbox.session_id',
          'session_outbox.state',
          'session_outbox.event_type',
          'session_outbox.event_id',
          'session_outbox.relay_sent_at',
          'session_outbox.event_sent_at',
          'session_outbox.attempts',
          'session_outbox.created_at',
          'sessions.state as current_state',
          'sessions.workspace_id',
          'sessions.name',
          'sessions.host_member_id',
          'sessions.created_by',
        ])
        .where('session_outbox.next_attempt_at', '<=', now)
        .where((eb) =>
          eb.or([
            eb('session_outbox.relay_sent_at', 'is', null),
            eb.and([
              eb('session_outbox.event_type', 'is not', null),
              eb('session_outbox.event_sent_at', 'is', null),
            ]),
          ]),
        )
        .orderBy('session_outbox.id')
        .limit(limit);
      if (sessionId !== undefined) q = q.where('session_outbox.session_id', '=', sessionId);
      const rows = await q.execute();
      return rows.map((r) => ({
        id: String(r.id),
        sessionId: r.session_id,
        state: r.state as SessionState,
        eventType: r.event_type,
        eventId: r.event_id,
        relaySent: r.relay_sent_at !== null,
        eventSent: r.event_sent_at !== null,
        attempts: r.attempts,
        createdAt: r.created_at,
        currentState: r.current_state,
        workspaceId: r.workspace_id,
        name: r.name,
        host: r.host_member_id,
        createdBy: r.created_by,
      }));
    },

    /** Records what was delivered, or schedules the next attempt. */
    async settleOutbox(
      id: string,
      done: { relay: boolean; event: boolean },
      at: Date,
      retryAt: Date | null,
      attempts: number,
    ): Promise<void> {
      await db
        .updateTable('session_outbox')
        .set({
          ...(done.relay ? { relay_sent_at: at } : {}),
          ...(done.event ? { event_sent_at: at } : {}),
          attempts,
          ...(retryAt === null ? {} : { next_attempt_at: retryAt }),
        })
        .where('id', '=', id)
        .execute();
    },
  };
  return repo;
}

/** The repository's type. */
export type SessionRepository = ReturnType<typeof createSessionRepository>;
