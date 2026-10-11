/**
 * Agent stores (B057): Redis-backed with a Postgres write-through (`agent` table, migration
 * 20260102004700_agents.sql), and in memory (tests).
 *
 * - **Redis** holds each session's agents as one JSON document, `relay:agents:<sid>`, kept for
 *   48 h after its last change.
 * - **Lock:** `relay:agents:<sid>:lock` (`setIfAbsent`, 30 s, released explicitly), so two nodes
 *   never change one session's agents at once; waiting longer than 2 s for it is a 503.
 * - **Write order:** Postgres first (an upsert per changed agent, each taking the next `rev` from
 *   the database's `agent_rev_seq`), then the Redis document, which records the newest `rev` it
 *   reflects (its watermark). A Postgres failure keeps the change in Redis and retries the agent with the next
 *   save; a Redis failure deletes the document (best effort) so the next load rebuilds it.
 * - **Load:** the document when its watermark is not older than the session's newest Postgres row,
 *   else a rebuild from Postgres (a restart, a flushed Redis, or writes made while Redis was down).
 * - **Redis down:** the transaction is `degraded`: agents come from Postgres, changes go to
 *   Postgres only (their newer `rev` outdates the document once Redis returns), and the
 *   registry refuses new spawns (the limit fails closed).
 *
 * Owns: persistence. Must not: store anything from `ct` (label, branch, worktree, model).
 */
import { randomBytes } from 'node:crypto';
import { AppError, type KeyValue } from '@centcom/core';
import type { AgentsDatabase, createDb } from '@centcom/db';
import type { AgentMode, AgentOutcome, AgentStore, AgentTx, StoredAgent } from './ports.js';

/** The relay's client over the agent table (typed in @centcom/db). */
export type AgentsDb = ReturnType<typeof createDb<AgentsDatabase>>;

/** How long a session's document stays in Redis after its last change. */
export const AGENT_DOC_TTL_MS = 48 * 3_600_000;
/** How long the session lock lives at most (it is released when the frame is done). */
export const AGENT_LOCK_TTL_MS = 30_000;
/** How long a frame waits for the lock before it is refused (503). */
export const AGENT_LOCK_WAIT_MS = 2_000;

const docKey = (sid: string): string => `relay:agents:${sid}`;
const lockKey = (sid: string): string => `relay:agents:${sid}:lock`;

/** A session's Redis document. */
interface AgentDoc {
  /** The newest Postgres `rev` the document reflects; 0 for none. */
  at: number;
  agents: Map<string, StoredAgent>;
  /** Agents whose last Postgres write failed (written again with the next save). */
  pending: string[];
}

/** A stored agent from a parsed document entry; null when it is not one. */
function agentOf(v: unknown): StoredAgent | null {
  if (typeof v !== 'object' || v === null) return null;
  const a = v as Record<string, unknown>;
  if (
    typeof a['agentId'] !== 'string' ||
    typeof a['owner'] !== 'string' ||
    (a['mode'] !== 'command_post' && a['mode'] !== 'branch') ||
    typeof a['state'] !== 'string' ||
    typeof a['since'] !== 'string' ||
    typeof a['spawnedSeq'] !== 'number' ||
    typeof a['spawnFrameId'] !== 'string' ||
    typeof a['spawnedBy'] !== 'string'
  ) {
    return null;
  }
  return a as unknown as StoredAgent;
}

const encode = (doc: AgentDoc): string =>
  JSON.stringify({ v: 2, at: doc.at, pending: doc.pending, agents: [...doc.agents.values()] });

/** Decodes a document; null when it is not one (it is then rebuilt from Postgres). */
function decode(text: string): AgentDoc | null {
  try {
    const raw = JSON.parse(text) as {
      v?: unknown;
      at?: unknown;
      pending?: unknown;
      agents?: unknown;
    };
    if (raw.v !== 2 || typeof raw.at !== 'number' || !Array.isArray(raw.agents)) return null;
    const pending = Array.isArray(raw.pending)
      ? raw.pending.filter((p): p is string => typeof p === 'string')
      : [];
    const agents = new Map<string, StoredAgent>();
    for (const entry of raw.agents) {
      const agent = agentOf(entry);
      if (agent === null) return null;
      agents.set(agent.agentId, agent);
    }
    return { at: raw.at, agents, pending };
  } catch {
    return null;
  }
}

/** A row as a stored agent. */
function fromRow(r: {
  agent_id: string;
  owner_member: string;
  mode: AgentMode;
  state: string;
  since: string;
  spawned_seq: string;
  spawn_frame_id: string;
  spawned_by: string;
  exited_seq: string | null;
  outcome: AgentOutcome | null;
  error_code: string | null;
}): StoredAgent {
  return {
    agentId: r.agent_id,
    owner: r.owner_member,
    mode: r.mode,
    state: r.state,
    since: r.since,
    spawnedSeq: Number(r.spawned_seq),
    spawnFrameId: r.spawn_frame_id,
    spawnedBy: r.spawned_by,
    ...(r.exited_seq === null ? {} : { exitedSeq: Number(r.exited_seq) }),
    ...(r.outcome === null
      ? {}
      : {
          exited: {
            outcome: r.outcome,
            ...(r.error_code === null ? {} : { errorCode: r.error_code }),
          },
        }),
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref());

/** What the store needs from Postgres. */
interface AgentRows {
  /** The session's agents and the newest `rev` (0 for none). */
  load(sid: string): Promise<{ agents: Map<string, StoredAgent>; at: number }>;
  /** The newest `rev` of the session (0 for none). */
  newest(sid: string): Promise<number>;
  /** Upserts `agents`; resolves to the newest `rev` written. */
  upsert(sid: string, agents: readonly StoredAgent[]): Promise<number>;
}

/** The `agent` table. */
function postgresRows(db: AgentsDb): AgentRows {
  return {
    async load(sid) {
      const rows = await db
        .selectFrom('agent')
        .select([
          'agent_id',
          'owner_member',
          'mode',
          'state',
          'since',
          'spawned_seq',
          'spawn_frame_id',
          'spawned_by',
          'exited_seq',
          'outcome',
          'error_code',
          'rev',
        ])
        .where('session_id', '=', sid)
        .orderBy('spawned_seq')
        .execute();
      return {
        agents: new Map(rows.map((r) => [r.agent_id, fromRow(r)])),
        at: Math.max(0, ...rows.map((r) => Number(r.rev))),
      };
    },
    async newest(sid) {
      const row = await db
        .selectFrom('agent')
        .select((eb) => eb.fn.max('rev').as('at'))
        .where('session_id', '=', sid)
        .executeTakeFirst();
      const at = row?.at as string | number | null | undefined;
      return at === null || at === undefined ? 0 : Number(at);
    },
    upsert(sid, agents) {
      if (agents.length === 0) return Promise.resolve(0);
      // One transaction: all of a save's rows (and their revs) commit, or none.
      return db.transaction().execute(async (trx) => {
        let newest = 0;
        for (const a of agents) {
          const row = await trx
            .insertInto('agent')
            .values({
              session_id: sid,
              agent_id: a.agentId,
              owner_member: a.owner,
              mode: a.mode,
              state: a.state,
              since: a.since,
              spawned_seq: a.spawnedSeq,
              spawn_frame_id: a.spawnFrameId,
              spawned_by: a.spawnedBy,
              exited_seq: a.exitedSeq ?? null,
              outcome: a.exited?.outcome ?? null,
              error_code: a.exited?.errorCode ?? null,
            })
            .onConflict((oc) =>
              oc.columns(['session_id', 'agent_id']).doUpdateSet((eb) => ({
                state: eb.ref('excluded.state'),
                since: eb.ref('excluded.since'),
                exited_seq: eb.ref('excluded.exited_seq'),
                outcome: eb.ref('excluded.outcome'),
                error_code: eb.ref('excluded.error_code'),
                rev: eb.fn<string>('nextval', [eb.val('agent_rev_seq')]),
                updated_at: eb.fn('now'),
              })),
            )
            .returning('rev')
            .executeTakeFirstOrThrow();
          newest = Math.max(newest, Number(row.rev));
        }
        return newest;
      });
    },
  };
}

/** The Redis side the store needs. */
type DocKv = Pick<KeyValue, 'get' | 'set' | 'setIfAbsent' | 'del'>;

/** The store over a document store and rows (shared by the Redis and memory stores). */
function documentStore(deps: {
  kv: DocKv;
  rows: AgentRows;
  clock: () => number;
  lockWaitMs: number;
}): AgentStore {
  const { kv, rows } = deps;

  async function readDoc(sid: string): Promise<AgentDoc | null> {
    const text = await kv.get(docKey(sid));
    return text === null ? null : decode(text);
  }

  /**
   * The session's current agents: the document unless Postgres has something newer. With
   * Postgres unreachable the document is used as it is (its `pending` list covers the writes).
   */
  async function current(sid: string, store: boolean): Promise<AgentDoc> {
    const doc = await readDoc(sid);
    if (doc !== null) {
      let newest: number;
      try {
        newest = await rows.newest(sid);
      } catch {
        return doc;
      }
      if (newest <= doc.at) return doc;
    }
    const rebuilt = await rows.load(sid);
    const fresh: AgentDoc = { at: rebuilt.at, agents: rebuilt.agents, pending: [] };
    if (store) {
      // A document Redis refuses (over its value limit) is skipped: Postgres serves the session.
      await kv.set(docKey(sid), encode(fresh), { ttlMs: AGENT_DOC_TTL_MS }).catch(() => undefined);
    }
    return fresh;
  }

  /** The lock's token, or null when Redis cannot be reached. */
  async function acquire(sid: string): Promise<string | null> {
    const token = randomBytes(12).toString('base64url');
    const deadline = deps.clock() + deps.lockWaitMs;
    for (;;) {
      let got: boolean;
      try {
        got = await kv.setIfAbsent(lockKey(sid), token, AGENT_LOCK_TTL_MS);
      } catch {
        return null;
      }
      if (got) return token;
      if (deps.clock() >= deadline) {
        throw new AppError('service_unavailable', {
          detail: 'The session agents are busy; try again shortly.',
          retryAfterS: 1,
        });
      }
      await sleep(10);
    }
  }

  async function release(sid: string, token: string): Promise<void> {
    try {
      if ((await kv.get(lockKey(sid))) === token) await kv.del(lockKey(sid));
    } catch {
      // The lock expires on its own.
    }
  }

  return {
    async withSession(sid, fn) {
      const token = await acquire(sid);
      if (token === null) {
        return fn({
          degraded: true,
          load: async () => (await rows.load(sid)).agents,
          async save(agents, changed) {
            await rows.upsert(
              sid,
              changed.flatMap((id) => agents.get(id) ?? []),
            );
          },
        });
      }
      try {
        let doc: AgentDoc | null = null;
        const tx: AgentTx = {
          degraded: false,
          async load() {
            const loaded = await current(sid, true);
            doc = loaded;
            return new Map(loaded.agents);
          },
          async save(agents, changed) {
            const before: AgentDoc = doc ?? { at: 0, agents: new Map(), pending: [] };
            // A write another node made without the lock (its Redis was down) since this load:
            // take its agents (not the ones changed here) before writing the document.
            try {
              if ((await rows.newest(sid)) > before.at) {
                const fresh = await rows.load(sid);
                const mine = new Set(changed);
                const merged = new Map(agents);
                for (const [id, a] of fresh.agents) if (!mine.has(id)) merged.set(id, a);
                agents = merged;
              }
            } catch {
              // Postgres unreachable: the upsert below fails too and marks the ids pending.
            }
            const ids = [...new Set([...changed, ...before.pending])];
            let at = before.at;
            let pending: string[] = [];
            let pgError: unknown;
            try {
              const written = await rows.upsert(
                sid,
                ids.flatMap((id) => agents.get(id) ?? []),
              );
              at = Math.max(at, written);
            } catch (err) {
              pending = ids;
              pgError = err;
            }
            const next: AgentDoc = { at, agents: new Map(agents), pending };
            try {
              await kv.set(docKey(sid), encode(next), { ttlMs: AGENT_DOC_TTL_MS });
              doc = next;
            } catch (err) {
              await kv.del(docKey(sid)).catch(() => 0);
              throw err;
            }
            if (pgError !== undefined) throw pgError;
          },
        };
        return await fn(tx);
      } finally {
        await release(sid, token);
      }
    },
    async read(sid) {
      try {
        return new Map((await current(sid, false)).agents);
      } catch {
        const doc = await readDoc(sid).catch(() => null);
        return doc !== null ? new Map(doc.agents) : (await rows.load(sid)).agents;
      }
    },
  };
}

/** What the Redis/Postgres store needs. */
export interface RedisAgentStoreDeps {
  kv: DocKv;
  db: AgentsDb;
  /** Milliseconds; default Date.now (lock waits only). */
  clock?: () => number;
  lockWaitMs?: number;
}

/** Agents in Redis, written through to Postgres. */
export function createRedisAgentStore(deps: RedisAgentStoreDeps): AgentStore {
  return documentStore({
    kv: deps.kv,
    rows: postgresRows(deps.db),
    clock: deps.clock ?? Date.now,
    lockWaitMs: deps.lockWaitMs ?? AGENT_LOCK_WAIT_MS,
  });
}

/**
 * Agents in memory (tests): the same rules over a map standing in for Redis and one for the
 * `agent` table (whose `rev` is a counter, as the database's sequence).
 * `redisDown` makes Redis unreachable; `postgresDown` makes the table unreachable.
 */
export function createMemoryAgentStore(): AgentStore & {
  redis: Map<string, string>;
  postgres: Map<string, Map<string, StoredAgent>>;
  redisDown: boolean;
  postgresDown: boolean;
} {
  const redis = new Map<string, string>();
  const postgres = new Map<string, Map<string, StoredAgent>>();
  const updated = new Map<string, number>();
  let dbClock = 0;
  const flags = { redisDown: false, postgresDown: false };
  const down = (): Promise<never> => Promise.reject(new Error('redis down'));
  const prefix = 'relay:agents:';
  const kv: DocKv = {
    get: (key) =>
      flags.redisDown ? down() : Promise.resolve(redis.get(key.slice(prefix.length)) ?? null),
    set(key, value) {
      if (flags.redisDown) return down();
      redis.set(key.slice(prefix.length), value);
      return Promise.resolve();
    },
    setIfAbsent: () => (flags.redisDown ? down() : Promise.resolve(true)),
    del(key) {
      if (flags.redisDown) return down();
      return Promise.resolve(redis.delete(key.slice(prefix.length)) ? 1 : 0);
    },
  };
  const rows: AgentRows = {
    load(sid) {
      if (flags.postgresDown) return Promise.reject(new Error('postgres down'));
      const agents = new Map(
        [...(postgres.get(sid) ?? new Map<string, StoredAgent>())].map(([k, v]) => [k, { ...v }]),
      );
      return Promise.resolve({ agents, at: updated.get(sid) ?? 0 });
    },
    newest: (sid) =>
      flags.postgresDown
        ? Promise.reject(new Error('postgres down'))
        : Promise.resolve(updated.get(sid) ?? 0),
    upsert(sid, agents) {
      if (flags.postgresDown) return Promise.reject(new Error('postgres down'));
      if (agents.length === 0) return Promise.resolve(0);
      const table = postgres.get(sid) ?? new Map<string, StoredAgent>();
      for (const a of agents) table.set(a.agentId, { ...a });
      postgres.set(sid, table);
      dbClock += 1;
      updated.set(sid, dbClock);
      return Promise.resolve(dbClock);
    },
  };
  // The lock: chained per session in this process (setIfAbsent always grants here).
  const locks = new Map<string, Promise<unknown>>();
  const inner = documentStore({ kv, rows, clock: Date.now, lockWaitMs: AGENT_LOCK_WAIT_MS });
  return {
    redis,
    postgres,
    get redisDown() {
      return flags.redisDown;
    },
    set redisDown(v: boolean) {
      flags.redisDown = v;
    },
    get postgresDown() {
      return flags.postgresDown;
    },
    set postgresDown(v: boolean) {
      flags.postgresDown = v;
    },
    async withSession(sid, fn) {
      const before = locks.get(sid) ?? Promise.resolve();
      let releaseLock: () => void = () => undefined;
      const mine = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      locks.set(
        sid,
        before.then(() => mine),
      );
      await before.catch(() => undefined);
      try {
        return await inner.withSession(sid, fn);
      } finally {
        releaseLock();
      }
    },
    read: (sid) => inner.read(sid),
  };
}
