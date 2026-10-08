/**
 * Postgres fixtures for the audit API tests (B082; DATABASE_URL, CI's integration job): audit
 * events seeded in bulk by one INSERT ... SELECT per chunk, with valid CT-IDS ids, 50 actors and
 * every catalogue action in turn, newest first from a given time.
 */
import { AUDIT_ACTIONS } from '@centcom/core';
import type { AuditApiDb } from '@centcom/db';
import { sql, type Kysely } from 'kysely';

export { ADMIN_URL, migratedDatabase } from '../modules/users/helpers.js';
export { pgUser, pgWorkspace } from '../notifications/dispatcher/postgres.js';

/** The catalogue's actions, which seeded events take in turn. */
export const SEED_ACTIONS: readonly string[] = Object.keys(AUDIT_ACTIONS);
/** Actors seeded events are spread over. */
export const SEED_ACTORS = 50;

/** The `usr_` id of seeded actor `n` (0..49). */
export const seedActor = (n: number): string =>
  `usr_01${n.toString(16).toUpperCase().padStart(24, '0')}`;

/** Options of `seedEvents`. */
export interface SeedOptions {
  /** Two characters (Crockford base 32) that keep ids apart between calls. */
  prefix: string;
  /** The newest event's time; event `g` is `stepMs * g` older. */
  newest: Date;
  /** Milliseconds between events (may be fractional: several share a millisecond). */
  stepMs?: number;
  /** Rows per statement. */
  chunk?: number;
}

/** Inserts `count` events into `workspaceId`. */
export async function seedEvents(
  db: Kysely<AuditApiDb>,
  workspaceId: string,
  count: number,
  opts: SeedOptions,
): Promise<void> {
  const chunk = opts.chunk ?? 20_000;
  const step = opts.stepMs ?? 50;
  const actions = sql.val([...SEED_ACTIONS]);
  for (let start = 0; start < count; start += chunk) {
    const end = Math.min(count, start + chunk) - 1;
    await sql`
      insert into audit_events
        (id, workspace_id, actor_type, actor_id, action, target_type, target_id, outcome, meta, created_at)
      select
        'aud_' || ${opts.prefix} || lpad(upper(to_hex(g)), 24, '0'),
        ${workspaceId},
        'user',
        'usr_01' || lpad(upper(to_hex(g % ${SEED_ACTORS})), 24, '0'),
        (${actions}::text[])[1 + g % ${SEED_ACTIONS.length}],
        'membership',
        'mem_' || ${opts.prefix} || lpad(upper(to_hex(g)), 24, '0'),
        'success',
        '{"role":"member"}'::jsonb,
        ${opts.newest}::timestamptz - (g * ${step}::float8) * interval '1 millisecond'
      from generate_series(${start}::int, ${end}::int) as g
    `.execute(db);
  }
}

/** Rows of `audit_events` in `workspaceId`. */
export async function countEvents(db: Kysely<AuditApiDb>, workspaceId: string): Promise<number> {
  const row = await db
    .selectFrom('audit_events')
    .select(sql<string>`count(*)`.as('n'))
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}
