/**
 * The session's mode from the records (B110): `sessions.mode`, `command_post` or `branch`, chosen
 * when the session is created and never changed. Because it cannot change, a found mode is cached
 * for as long as this node runs (bounded: the oldest entries go first).
 *
 * Fails closed: a session that is not found is a command post (the stricter rules), and a failing
 * lookup rejects, so the stage that asked answers `service_unavailable` instead of accepting a frame
 * under the wrong mode. A missing answer is never cached.
 *
 * Owns: this one read. Must not: be asked for anything but the mode, or read a frame.
 */
import type { createDb, CoreDatabase } from '@centcom/db';
import type { AgentMode, SessionModePort } from './ports.js';

type ModeDbClient = ReturnType<typeof createDb<Pick<CoreDatabase, 'sessions'>>>;

/** How many sessions' modes one node remembers. */
export const MODE_CACHE_MAX = 10_000;

/** A mode port over Postgres. */
export function createPostgresSessionModes(
  db: object,
  options: { max?: number } = {},
): SessionModePort & { forget(sid: string): void } {
  const client = db as ModeDbClient;
  const max = options.max ?? MODE_CACHE_MAX;
  const known = new Map<string, AgentMode>();
  return {
    async modeOf(sid) {
      const hit = known.get(sid);
      if (hit !== undefined) return hit;
      const row = await client
        .selectFrom('sessions')
        .select('mode')
        .where('id', '=', sid)
        .executeTakeFirst();
      if (row === undefined) return 'command_post';
      known.set(sid, row.mode);
      if (known.size > max) {
        const oldest = known.keys().next();
        if (!oldest.done) known.delete(oldest.value);
      }
      return row.mode;
    },
    forget(sid) {
      known.delete(sid);
    },
  };
}
