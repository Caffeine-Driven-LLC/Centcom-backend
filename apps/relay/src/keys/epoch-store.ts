/**
 * Where a session's key epoch is kept (B049, CT-CRYPTO §5): Redis hash `relay:ses:{sid}:epoch`, so
 * it survives relay restarts (a restart must not accept stale epochs again).
 *
 * | Field | |
 * |---|---|
 * | `n` | The epoch counter: every rotation takes the next number (atomic, cluster-wide). |
 * | `kid` | The announced current epoch (`k<e>`); absent: `k1`. |
 * | `started_at` | When it was announced (ms). |
 * | `seq` | The `seq` of the `control.rotate_key` that announced it. |
 * | `r<e>` | The `seq` of the rotation into epoch `e`, for every epoch (stale-kid checks). |
 *
 * The key lives as long as the session's `seq` counter (31 days after the last rotation); a session
 * never rotated has no key and is at `k1`.
 *
 * Owns: the layout. Must not: hold or describe key material.
 */
import type { Redis } from 'ioredis';
import { COUNTER_TTL_MS } from '../seq/retention.js';

/** A session's epoch. */
export interface EpochState {
  /** The announced current epoch (1 = `k1`). */
  current: number;
  /** When it was announced (ms); 0 for `k1` never announced. */
  startedAt: number;
  /** The `seq` of the `rotate_key` that announced it; 0 for `k1`. */
  seq: number;
  /** epoch → the `seq` of the rotation into it. */
  rotations: Map<number, number>;
}

/** The epochs of every session. */
export interface EpochStore {
  read(sid: string): Promise<EpochState>;
  /** The next epoch number (2 for a session at `k1`); never the same twice. */
  next(sid: string): Promise<number>;
  /** Records the rotation into `epoch` at `seq`; it becomes current unless a newer one is. */
  announce(sid: string, epoch: number, seq: number, atMs: number): Promise<void>;
}

export const epochKey = (sid: string): string => `relay:ses:{${sid}}:epoch`;

const FIRST: () => EpochState = () => ({ current: 1, startedAt: 0, seq: 0, rotations: new Map() });

/** The state in a hash's fields. */
export function stateOf(fields: Record<string, string>): EpochState {
  const state = FIRST();
  const kid = fields['kid'];
  if (kid !== undefined && /^k[1-9]\d*$/.test(kid)) {
    state.current = Number(kid.slice(1));
    state.startedAt = Number(fields['started_at'] ?? 0);
    state.seq = Number(fields['seq'] ?? 0);
  }
  for (const [name, value] of Object.entries(fields)) {
    if (/^r[1-9]\d*$/.test(name)) state.rotations.set(Number(name.slice(1)), Number(value));
  }
  return state;
}

/** The store in this process (tests). */
export function createMemoryEpochStore(): EpochStore & {
  fields(sid: string): Record<string, string>;
} {
  const hashes = new Map<string, Record<string, string>>();
  const of = (sid: string): Record<string, string> => {
    let h = hashes.get(sid);
    if (h === undefined) {
      h = {};
      hashes.set(sid, h);
    }
    return h;
  };
  return {
    read: (sid) => Promise.resolve(stateOf({ ...of(sid) })),
    next(sid) {
      const h = of(sid);
      const n = Number(h['n'] ?? 1) + 1;
      h['n'] = String(n);
      return Promise.resolve(n);
    },
    announce(sid, epoch, seq, atMs) {
      const h = of(sid);
      h[`r${epoch}`] = String(seq);
      if (h['kid'] === undefined || epoch > stateOf(h).current) {
        h['kid'] = `k${epoch}`;
        h['started_at'] = String(atMs);
        h['seq'] = String(seq);
      }
      return Promise.resolve();
    },
    fields: (sid) => ({ ...of(sid) }),
  };
}

/**
 * Records a rotation. KEYS: the hash. ARGV: epoch, seq, now (ms), TTL (ms). The rotation's `r<e>` is
 * always kept; the epoch becomes current only if it is newer than the current one.
 */
export const EPOCH_ANNOUNCE_LUA = `
local epoch = tonumber(ARGV[1])
redis.call('HSET', KEYS[1], 'r' .. epoch, ARGV[2])
local kid = redis.call('HGET', KEYS[1], 'kid')
local current = 1
if kid then current = tonumber(string.sub(kid, 2)) end
if (not kid) or epoch > current then
  redis.call('HSET', KEYS[1], 'kid', 'k' .. epoch, 'started_at', ARGV[3], 'seq', ARGV[2])
end
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
`;

/** The Redis store, on the relay's own connection (`ct:<env>:` prefix). */
export function createRedisEpochStore(client: Redis): EpochStore {
  if (!('relayEpochAnnounce' in client)) {
    client.defineCommand('relayEpochAnnounce', { numberOfKeys: 1, lua: EPOCH_ANNOUNCE_LUA });
  }
  const announce = client as unknown as {
    relayEpochAnnounce(
      key: string,
      epoch: number,
      seq: number,
      now: number,
      ttl: number,
    ): Promise<number>;
  };
  return {
    async read(sid) {
      return stateOf(await client.hgetall(epochKey(sid)));
    },
    async next(sid) {
      const key = epochKey(sid);
      const replies = await client
        .multi()
        .hsetnx(key, 'n', '1')
        .hincrby(key, 'n', 1)
        .pexpire(key, COUNTER_TTL_MS)
        .exec();
      const reply = replies?.[1];
      if (reply === undefined || reply[0] !== null)
        throw new Error('epoch: the counter did not answer');
      return Number(reply[1]);
    },
    async announce(sid, epoch, seq, atMs) {
      await announce.relayEpochAnnounce(epochKey(sid), epoch, seq, atMs, COUNTER_TTL_MS);
    },
  };
}
