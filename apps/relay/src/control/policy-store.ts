/**
 * Session policy (B051, CT-WS-CONTROL `control.policy`): the host's settings for the session,
 * stored on it and read by the queue service (B052) through `PolicyStore.get`.
 *
 * - A session that never had a `control.policy` has `DEFAULT_POLICY`: ask before running, no
 *   shared history, a queue of 20, unlocked, no failover, nobody trusted, no approvers, the queue
 *   running.
 * - `policyFrom(p, previous)`: the policy a frame sets. The codec (B039) has already checked `p`
 *   against the generated schema; the three required fields replace the previous ones, and an
 *   optional field the frame leaves out keeps its previous value (an older client that does not
 *   know `queue_paused` does not unpause the queue). `trusted` and `approvers` are deduplicated
 *   and hold at most `MAX_POLICY_MEMBERS` ids.
 * - `get` reads the store every time (no cache), so a policy written on any node is what the next
 *   frame sees.
 *
 * Owns: the policy type, its defaults, and its store. Must not: decide anything the policy
 * governs (auto-approval and queue limits are B052's).
 */
import type { createDb } from '@centcom/db';
import type { ControlDatabase } from '@centcom/db';

/** A session's policy. */
export interface SessionPolicy {
  auto_approve: 'ask' | 'trusted' | 'everyone';
  share_history: boolean;
  queue_limit: number;
  locked: boolean;
  auto_failover: boolean;
  /** `mem_` ids. */
  trusted: string[];
  approvers: string[];
  queue_paused: boolean;
}

/** The policy of a session without one. */
export const DEFAULT_POLICY: Readonly<SessionPolicy> = Object.freeze({
  auto_approve: 'ask',
  share_history: false,
  queue_limit: 20,
  locked: false,
  auto_failover: false,
  trusted: [],
  approvers: [],
  queue_paused: false,
});

/** Most ids in `trusted` or `approvers` (a session's member cap). */
export const MAX_POLICY_MEMBERS = 50;
/** Largest `queue_limit` stored. */
export const MAX_QUEUE_LIMIT = 100_000;

const AUTO_APPROVE: ReadonlySet<string> = new Set(['ask', 'trusted', 'everyone']);
const MEMBER_ID = /^mem_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Why `policyFrom` refused a payload: the JSON pointer of the field. */
export interface PolicyError {
  pointer: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function members(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = [...new Set(value)];
  if (ids.length > MAX_POLICY_MEMBERS) return null;
  return ids.every((id): id is string => typeof id === 'string' && MEMBER_ID.test(id)) ? ids : null;
}

/** The policy `p` sets over `previous`, or the field that is wrong. */
export function policyFrom(p: unknown, previous: SessionPolicy): SessionPolicy | PolicyError {
  if (!isRecord(p)) return { pointer: '/p' };
  const { auto_approve, share_history, queue_limit } = p;
  if (typeof auto_approve !== 'string' || !AUTO_APPROVE.has(auto_approve)) {
    return { pointer: '/p/auto_approve' };
  }
  if (typeof share_history !== 'boolean') return { pointer: '/p/share_history' };
  if (
    typeof queue_limit !== 'number' ||
    !Number.isInteger(queue_limit) ||
    queue_limit < 0 ||
    queue_limit > MAX_QUEUE_LIMIT
  ) {
    return { pointer: '/p/queue_limit' };
  }
  const policy: SessionPolicy = {
    ...previous,
    auto_approve: auto_approve as SessionPolicy['auto_approve'],
    share_history,
    queue_limit,
  };
  for (const flag of ['locked', 'auto_failover', 'queue_paused'] as const) {
    const value = p[flag];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return { pointer: `/p/${flag}` };
    policy[flag] = value;
  }
  for (const list of ['trusted', 'approvers'] as const) {
    if (p[list] === undefined) continue;
    const ids = members(p[list]);
    if (ids === null) return { pointer: `/p/${list}` };
    policy[list] = ids;
  }
  return policy;
}

/** True when `value` is a refusal of `policyFrom`. */
export const isPolicyError = (value: SessionPolicy | PolicyError): value is PolicyError =>
  'pointer' in value;

/** A stored policy and the `seq` of the frame that set it (null: none yet, or being sequenced). */
export interface StoredPolicy {
  policy: SessionPolicy;
  updatedSeq: number | null;
}

/** Where policies are kept. */
export interface PolicyStore {
  /** The session's policy now (DEFAULT_POLICY when it never had one). */
  get(sid: string): Promise<SessionPolicy>;
  /** The policy with the `seq` that set it. */
  read(sid: string): Promise<StoredPolicy>;
  /** Stores `policy` as set by the frame at `bySeq` (null: that frame is being sequenced). */
  set(sid: string, policy: SessionPolicy, bySeq: number | null): Promise<void>;
}

const copy = (p: SessionPolicy): SessionPolicy => ({
  ...p,
  trusted: [...p.trusted],
  approvers: [...p.approvers],
});

/** Policies in memory (tests, and relays without Postgres). */
export function createMemoryPolicyStore(): PolicyStore & { failing: boolean } {
  const policies = new Map<string, StoredPolicy>();
  const store = {
    failing: false,
    async read(sid: string): Promise<StoredPolicy> {
      if (store.failing) throw new Error('policy store down');
      const found = policies.get(sid);
      return found === undefined
        ? { policy: copy(DEFAULT_POLICY), updatedSeq: null }
        : { policy: copy(found.policy), updatedSeq: found.updatedSeq };
    },
    async get(sid: string): Promise<SessionPolicy> {
      return (await store.read(sid)).policy;
    },
    set(sid: string, policy: SessionPolicy, bySeq: number | null): Promise<void> {
      if (store.failing) return Promise.reject(new Error('policy store down'));
      policies.set(sid, { policy: copy(policy), updatedSeq: bySeq });
      return Promise.resolve();
    },
  };
  return store;
}

/** The relay's client over the control tables. */
export type ControlDb = ReturnType<typeof createDb<ControlDatabase>>;

/** Policies in Postgres (`session_policy`). */
export function createPostgresPolicyStore(db: ControlDb): PolicyStore {
  const store: PolicyStore = {
    async read(sid) {
      const row = await db
        .selectFrom('session_policy')
        .select([
          'auto_approve',
          'share_history',
          'queue_limit',
          'locked',
          'auto_failover',
          'trusted',
          'approvers',
          'queue_paused',
          'updated_seq',
        ])
        .where('session_id', '=', sid)
        .executeTakeFirst();
      if (row === undefined) return { policy: copy(DEFAULT_POLICY), updatedSeq: null };
      const { updated_seq, ...policy } = row;
      return { policy, updatedSeq: updated_seq === null ? null : Number(updated_seq) };
    },
    async get(sid) {
      return (await store.read(sid)).policy;
    },
    async set(sid, policy, bySeq) {
      const values = {
        auto_approve: policy.auto_approve,
        share_history: policy.share_history,
        queue_limit: policy.queue_limit,
        locked: policy.locked,
        auto_failover: policy.auto_failover,
        trusted: policy.trusted,
        approvers: policy.approvers,
        queue_paused: policy.queue_paused,
        updated_seq: bySeq,
      };
      await db
        .insertInto('session_policy')
        .values({ session_id: sid, ...values })
        .onConflict((oc) =>
          oc.column('session_id').doUpdateSet({ ...values, updated_at: new Date() }),
        )
        .execute();
    },
  };
  return store;
}
