/**
 * The approval store (B060): Redis, through B009's KeyValue (tests run it over the in-memory Redis).
 *
 * - **Pending approval:** `approval:<sid>:<apr>` -> the approval as JSON, written `SET NX` (one
 *   request per approval id), its TTL `expires_at` + 60 s.
 * - **Decision claim:** `approval:<sid>:<apr>:decided` -> `{by, frame, at, req, requester, exp,
 *   seq?}` (the decider, its frame, when, the request's frame and sender, the approval's expiry),
 *   written `SET NX` by
 *   the first decider or by the expiry sweep, so one decision is sequenced, and the timeout deny
 *   once even with several sweepers; `seq` is added once the decision is sequenced. Kept as long as
 *   a session list (a day), so no list entry can outlive its approval's claim, a later decision is
 *   recognised, and a decided approval id cannot be requested again.
 * - **Session list:** `approvals:<sid>` -> the session's pending approvals, so a sweep (after a
 *   restart too) and a cleanup find them; changed under `approvals:<sid>:mutex` (`SET NX PX`, 30 s,
 *   waited for at most 2 s), kept a day after its last change.
 *
 * Keys and values hold session, approval, agent and member ids, the risk and approver enums, times
 * and seqs only; `approvals.privacy.test.ts` scans them. Redis down: a 503-class error.
 *
 * Owns: persistence. Must not: store anything from `ct`.
 */
import { randomBytes } from 'node:crypto';
import { AppError, type KeyValue } from '@centcom/core';
import type { ApprovalStore, DecisionClaim, PendingApproval } from './ports.js';

/** How long a session's list is kept after its last change. */
export const APPROVAL_LIST_TTL_MS = 24 * 3_600_000;
/** How long the list mutex lives at most. */
export const APPROVAL_MUTEX_TTL_MS = 30_000;
/** How long a change waits for the mutex. */
export const APPROVAL_MUTEX_WAIT_MS = 2_000;

/** An approval's key. */
export const approvalKey = (sid: string, apr: string): string => `approval:${sid}:${apr}`;
const claimKey = (sid: string, apr: string): string => `approval:${sid}:${apr}:decided`;
const listKey = (sid: string): string => `approvals:${sid}`;
const mutexKey = (sid: string): string => `approvals:${sid}:mutex`;

const unavailable = (): AppError =>
  new AppError('service_unavailable', {
    detail: 'Approvals cannot be routed right now; try again shortly.',
    retryAfterS: 1,
  });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref());

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A stored approval, or null for a missing or unreadable one. */
function decodeApproval(text: string | null): PendingApproval | null {
  if (text === null) return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || typeof raw['approvalId'] !== 'string') return null;
    return raw as unknown as PendingApproval;
  } catch {
    return null;
  }
}

function encodeApproval(a: PendingApproval): string {
  return JSON.stringify({
    approvalId: a.approvalId,
    agentId: a.agentId,
    requester: a.requester,
    risk: a.risk,
    approver: a.approver,
    expiresAt: a.expiresAt,
    requestedAt: a.requestedAt,
    requestSeq: a.requestSeq,
    frameId: a.frameId,
  });
}

function decodeClaim(text: string | null): DecisionClaim | null {
  if (text === null) return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || typeof raw['by'] !== 'string' || typeof raw['frame'] !== 'string') {
      return null;
    }
    const claim: DecisionClaim = { by: raw['by'], frameId: raw['frame'] };
    if (typeof raw['seq'] === 'number') claim.seq = raw['seq'];
    if (typeof raw['at'] === 'number') claim.at = raw['at'];
    if (typeof raw['req'] === 'string') claim.requestFrame = raw['req'];
    if (typeof raw['requester'] === 'string') claim.requester = raw['requester'];
    if (typeof raw['exp'] === 'string') claim.expiresAt = raw['exp'];
    return claim;
  } catch {
    return null;
  }
}

const encodeClaim = (c: DecisionClaim): string =>
  JSON.stringify({
    by: c.by,
    frame: c.frameId,
    ...(c.at === undefined ? {} : { at: c.at }),
    ...(c.requestFrame === undefined ? {} : { req: c.requestFrame }),
    ...(c.requester === undefined ? {} : { requester: c.requester }),
    ...(c.expiresAt === undefined ? {} : { exp: c.expiresAt }),
    ...(c.seq === undefined ? {} : { seq: c.seq }),
  });

/** Approvals in Redis over `kv`. */
export function createRedisApprovalStore(deps: {
  kv: Pick<KeyValue, 'get' | 'set' | 'setIfAbsent' | 'del'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  mutexWaitMs?: number;
}): ApprovalStore {
  const clock = deps.clock ?? Date.now;
  const kv = deps.kv;
  const wait = deps.mutexWaitMs ?? APPROVAL_MUTEX_WAIT_MS;

  /** Any Redis failure becomes a 503. */
  const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw unavailable();
    }
  };

  /** Runs `change` on the session's list under its mutex, and saves what it returns. */
  async function withList(
    sid: string,
    change: (list: PendingApproval[]) => PendingApproval[],
  ): Promise<void> {
    const token = randomBytes(12).toString('base64url');
    const deadline = clock() + wait;
    for (;;) {
      if (await guarded(() => kv.setIfAbsent(mutexKey(sid), token, APPROVAL_MUTEX_TTL_MS))) break;
      if (clock() >= deadline) throw unavailable();
      await sleep(10);
    }
    try {
      await guarded(async () => {
        const next = change(await readList(sid));
        if (next.length === 0) await kv.del(listKey(sid));
        else {
          await kv.set(
            listKey(sid),
            JSON.stringify(next.map((a) => JSON.parse(encodeApproval(a)))),
            {
              ttlMs: APPROVAL_LIST_TTL_MS,
            },
          );
        }
      });
    } finally {
      try {
        if ((await kv.get(mutexKey(sid))) === token) await kv.del(mutexKey(sid));
      } catch {
        // The mutex expires on its own.
      }
    }
  }

  async function readList(sid: string): Promise<PendingApproval[]> {
    const text = await kv.get(listKey(sid));
    if (text === null) return [];
    try {
      const raw: unknown = JSON.parse(text);
      if (!Array.isArray(raw)) return [];
      return raw
        .map((entry) => decodeApproval(JSON.stringify(entry)))
        .filter((a): a is PendingApproval => a !== null);
    } catch {
      return [];
    }
  }

  return {
    async create(sid, a, ttlMs) {
      const won = await guarded(() =>
        kv.setIfAbsent(approvalKey(sid, a.approvalId), encodeApproval(a), Math.max(1, ttlMs)),
      );
      if (!won) {
        const existing = decodeApproval(
          await guarded(() => kv.get(approvalKey(sid, a.approvalId))),
        );
        // An unreadable record still holds the id.
        return existing ?? { ...a, frameId: '' };
      }
      try {
        await withList(sid, (list) => [...list.filter((x) => x.approvalId !== a.approvalId), a]);
      } catch (err) {
        await kv.del(approvalKey(sid, a.approvalId)).catch(() => undefined);
        throw err;
      }
      return null;
    },
    async get(sid, approvalId) {
      return decodeApproval(await guarded(() => kv.get(approvalKey(sid, approvalId))));
    },
    async update(sid, a, ttlMs) {
      await guarded(() =>
        kv.set(approvalKey(sid, a.approvalId), encodeApproval(a), { ttlMs: Math.max(1, ttlMs) }),
      );
      await withList(sid, (list) => list.map((x) => (x.approvalId === a.approvalId ? a : x)));
    },
    async remove(sid, approvalIds) {
      if (approvalIds.length === 0) return;
      const ids = new Set(approvalIds);
      await withList(sid, (list) => list.filter((x) => !ids.has(x.approvalId)));
      await guarded(async () => {
        for (const id of ids) await kv.del(approvalKey(sid, id));
      });
    },
    list: (sid) => guarded(() => readList(sid)),
    async claim(sid, approvalId, c) {
      const won = await guarded(() =>
        kv.setIfAbsent(claimKey(sid, approvalId), encodeClaim(c), APPROVAL_LIST_TTL_MS),
      );
      if (won) return true;
      const held = decodeClaim(await guarded(() => kv.get(claimKey(sid, approvalId))));
      return held ?? { by: '', frameId: '' };
    },
    async settle(sid, approvalId, c, seq) {
      await guarded(() =>
        kv.set(claimKey(sid, approvalId), encodeClaim({ ...c, seq }), {
          ttlMs: APPROVAL_LIST_TTL_MS,
        }),
      );
    },
    async release(sid, approvalId, c) {
      await guarded(async () => {
        const held = decodeClaim(await kv.get(claimKey(sid, approvalId)));
        if (
          held !== null &&
          held.by === c.by &&
          held.frameId === c.frameId &&
          held.seq === undefined
        ) {
          await kv.del(claimKey(sid, approvalId));
        }
      });
    },
    async claimOf(sid, approvalId) {
      return decodeClaim(await guarded(() => kv.get(claimKey(sid, approvalId))));
    },
  };
}
