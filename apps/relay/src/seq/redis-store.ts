/**
 * The Redis SeqStore (B041): one Lua script assigns every `seq`, so the dedupe check, the counter,
 * the buffer append, the trim and the dedupe record happen atomically (no frame is sequenced
 * twice, none is lost between its `seq` and the buffer). Keys, all under the `ct:<env>:` prefix,
 * with the session id as a Redis Cluster hash tag so one script's keys share a slot:
 *
 * - `relay:ses:{sid}:seq`: the counter (INCR; starts at 1);
 * - `relay:ses:{sid}:buf`: the hot buffer, a stream whose entry ids are `<seq>-0` and whose field
 *   `f` is the frame's exact JSON (so `range` is one XRANGE);
 * - `relay:ses:{sid}:times`: each buffered frame's receive time, in step with the buffer, so the
 *   age rule is checked without reading frames;
 * - `relay:ses:{sid}:dedupe:{from}:{id}`: `<seq>|<ts>`, for 24 h.
 *
 * The counter expires COUNTER_TTL_MS (31 days) after the session's last frame, the buffer and its
 * times BUFFER_TTL_MS (48 h) after it. A counter that was lost while the buffer survived is
 * recovered from the newest buffered frame (by `assign`, `head` and `oldest` alike); a flush of
 * the whole session is B042's to recover. The client is the module's own ioredis connection:
 * B009's `RedisBackend` is a key-value cache with an in-memory twin and exposes no generic
 * script or stream commands; this store keeps the same connection rules (prefix, timeouts,
 * reconnect backoff) and never logs keys, frames or the URL.
 *
 * Owns: the script and the key layout. Must not: read the clock inside the script (the caller
 * passes `now`), touch `ct`, or leave a key without a TTL.
 */
import { randomInt } from 'node:crypto';
import { unavailable, type Logger, type Secret } from '@centcom/core';
import { Redis, type RedisOptions } from 'ioredis';
import { parseStoredFrame, seqParts } from './frame.js';
import {
  BUFFER_TTL_MS,
  checkRange,
  COUNTER_TTL_MS,
  DEDUPE_TTL_MS,
  TRIM_STEP,
} from './retention.js';
import type { AssignResult, BufferLimits, SeqStore, StoredFrame } from './types.js';

/**
 * Assigns a `seq`. KEYS: counter, buffer, times, dedupe record. ARGV: the frame's JSON before and
 * after its `seq`, now (ms), ts, dedupe TTL (ms), min frames, min age (ms), max frames, buffer TTL
 * (ms), trim step, counter TTL (ms). Returns `{seq, duplicate (0 or 1), ts}`. The trimming mirrors
 * `dropCount` (retention.ts).
 */
export const SEQ_ASSIGN_LUA = `
local seen = redis.call('GET', KEYS[4])
if seen then
  local bar = string.find(seen, '|', 1, true)
  return {tonumber(string.sub(seen, 1, bar - 1)), 1, string.sub(seen, bar + 1)}
end
local now = tonumber(ARGV[3])
if redis.call('EXISTS', KEYS[1]) == 0 then
  -- The counter is gone but the buffer survived (an evicted key): go on after its newest frame.
  local newest = redis.call('XREVRANGE', KEYS[2], '+', '-', 'COUNT', 1)
  if newest[1] then
    local id = newest[1][1]
    redis.call('SET', KEYS[1], string.sub(id, 1, string.find(id, '-', 1, true) - 1))
  end
end
local seq = redis.call('INCR', KEYS[1])
redis.call('XADD', KEYS[2], seq .. '-0', 'f', ARGV[1] .. seq .. ARGV[2])
local length = redis.call('XLEN', KEYS[2])
local timed = redis.call('RPUSH', KEYS[3], now)
if timed > length then
  redis.call('LTRIM', KEYS[3], timed - length, -1)
elseif timed < length then
  -- Times were lost: count the unknown ones as now (kept longer, never shorter).
  local missing = length - timed
  while missing > 0 do
    local n = math.min(missing, 1000)
    local pad = {}
    for i = 1, n do pad[i] = now end
    redis.call('LPUSH', KEYS[3], unpack(pad))
    missing = missing - n
  end
end
local drop = math.max(0, length - tonumber(ARGV[8]))
local room = math.min(length - drop - tonumber(ARGV[6]), tonumber(ARGV[10]))
if room > 0 then
  local cutoff = now - tonumber(ARGV[7])
  local times = redis.call('LRANGE', KEYS[3], drop, drop + room - 1)
  for i = 1, #times do
    if tonumber(times[i]) >= cutoff then break end
    drop = drop + 1
  end
end
if drop > 0 then
  redis.call('XTRIM', KEYS[2], 'MINID', (seq - length + 1 + drop) .. '-0')
  redis.call('LTRIM', KEYS[3], drop, -1)
end
redis.call('PEXPIRE', KEYS[1], ARGV[11])
redis.call('PEXPIRE', KEYS[2], ARGV[9])
redis.call('PEXPIRE', KEYS[3], ARGV[9])
redis.call('SET', KEYS[4], seq .. '|' .. ARGV[4], 'PX', ARGV[5])
return {seq, 0, ARGV[4]}
`;

/**
 * The session's head and buffer length. KEYS: counter, buffer. Returns `{head, length}`; a lost
 * counter is read from the newest buffered frame, as `SEQ_ASSIGN_LUA` recovers it.
 */
export const SEQ_WINDOW_LUA = `
local length = redis.call('XLEN', KEYS[2])
local head = redis.call('GET', KEYS[1])
if head then
  return {tonumber(head), length}
end
local newest = redis.call('XREVRANGE', KEYS[2], '+', '-', 'COUNT', 1)
if newest[1] then
  local id = newest[1][1]
  return {tonumber(string.sub(id, 1, string.find(id, '-', 1, true) - 1)), length}
end
return {0, length}
`;

/** The session's keys (the braces are a Redis Cluster hash tag). */
export const seqKeys = (
  sid: string,
): { seq: string; buf: string; times: string; dedupe: (from: string, id: string) => string } => ({
  seq: `relay:ses:{${sid}}:seq`,
  buf: `relay:ses:{${sid}}:buf`,
  times: `relay:ses:{${sid}}:times`,
  dedupe: (from, id) => `relay:ses:{${sid}}:dedupe:${from}:${id}`,
});

/** A command waits at most this long for Redis (as B009's). */
export const SEQ_COMMAND_TIMEOUT_MS = 2_000;
/** TCP connect timeout. */
export const SEQ_CONNECT_TIMEOUT_MS = 5_000;
/** Longest pause between reconnect attempts (plus up to 100 ms of jitter). */
export const SEQ_MAX_RECONNECT_DELAY_MS = 3_000;

/** The script as a client method. */
interface SeqCommands {
  relaySeqAssign(
    seqKey: string,
    bufKey: string,
    timesKey: string,
    dedupeKey: string,
    prefix: string,
    suffix: string,
    nowMs: number,
    ts: string,
    dedupeTtlMs: number,
    minFrames: number,
    minAgeMs: number,
    maxFrames: number,
    bufferTtlMs: number,
    trimStep: number,
    counterTtlMs: number,
  ): Promise<[number, number, string]>;
  relaySeqWindow(seqKey: string, bufKey: string): Promise<[number, number]>;
}

/** Options for createSeqRedisClient. */
export interface SeqRedisClientOptions {
  /** `redis://` or `rediss://` URL (`baseConfig().redisUrl`); never logged. */
  url: Secret<string>;
  /** `ct:<env>:` (`keyPrefixFor`). */
  keyPrefix: string;
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Connection trouble only, never keys or frames. */
  logger?: Logger;
}

/**
 * The sequence module's Redis connection, with B009's connection rules: every key under
 * `keyPrefix`, commands abandoned after 2 s, reconnects with backoff and jitter. It connects on its
 * first command (nothing here waits for Redis, and a relay stopped during startup has no socket
 * left to close).
 */
export function createSeqRedisClient(options: SeqRedisClientOptions): Redis {
  const ioOptions: RedisOptions = {
    keyPrefix: options.keyPrefix,
    lazyConnect: true,
    // A command cut off by a reconnect fails (the client resends the frame) instead of running
    // again later, after its caller was already told it failed.
    autoResendUnfulfilledCommands: false,
    commandTimeout: options.commandTimeoutMs ?? SEQ_COMMAND_TIMEOUT_MS,
    connectTimeout: options.connectTimeoutMs ?? SEQ_CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) =>
      Math.min(100 * 2 ** Math.min(times, 5), SEQ_MAX_RECONNECT_DELAY_MS) + randomInt(0, 100),
  };
  const client = new Redis(options.url.reveal(), ioOptions);
  let healthy = true;
  client.on('error', (err: unknown) => {
    if (!healthy) return;
    healthy = false;
    options.logger?.warn(
      { error: err instanceof Error ? err.name : typeof err },
      'relay.seq_redis_error',
    );
  });
  client.on('ready', () => {
    if (!healthy) options.logger?.info({}, 'relay.seq_redis_ready');
    healthy = true;
  });
  return client;
}

/** Any Redis failure: a 503 the sender can retry (no partial state: the script is atomic). */
const down = (err: unknown): never => {
  throw unavailable(1, 'Sequencing is unavailable right now; send the frame again shortly.', {
    cause: new Error(err instanceof Error ? err.name : 'redis error'),
  });
};

/** A SeqStore on `client` (an ioredis connection whose keyPrefix namespaces the keys). */
export function createRedisSeqStore(client: Redis, limits: BufferLimits): SeqStore {
  if (!('relaySeqAssign' in client)) {
    client.defineCommand('relaySeqAssign', { numberOfKeys: 4, lua: SEQ_ASSIGN_LUA });
    client.defineCommand('relaySeqWindow', { numberOfKeys: 2, lua: SEQ_WINDOW_LUA });
  }
  const window = async (sid: string): Promise<{ head: number; length: number }> => {
    const keys = seqKeys(sid);
    const [head, length] = await commands.relaySeqWindow(keys.seq, keys.buf).catch(down);
    return { head: Number(head), length: Number(length) };
  };
  const commands = client as unknown as SeqCommands;
  return {
    async assign(sid, key, frame, nowMs): Promise<AssignResult> {
      const keys = seqKeys(sid);
      const { prefix, suffix } = seqParts(frame);
      const [seq, duplicate, ts] = await commands
        .relaySeqAssign(
          keys.seq,
          keys.buf,
          keys.times,
          keys.dedupe(key.from, key.id),
          prefix,
          suffix,
          nowMs,
          frame.ts,
          DEDUPE_TTL_MS,
          limits.minFrames,
          limits.minAgeMs,
          limits.maxFrames,
          BUFFER_TTL_MS,
          TRIM_STEP,
          COUNTER_TTL_MS,
        )
        .catch(down);
      return { seq: Number(seq), duplicate: Number(duplicate) === 1, ts: String(ts) };
    },
    async head(sid) {
      return (await window(sid)).head;
    },
    async range(sid, afterSeq, limit): Promise<StoredFrame[]> {
      checkRange(afterSeq, limit);
      const entries = await client
        .xrange(seqKeys(sid).buf, `${afterSeq + 1}-0`, '+', 'COUNT', limit)
        .catch(down);
      return entries.map(([, fields]) => parseStoredFrame(fields[1] ?? 'null'));
    },
    async oldest(sid) {
      const { head, length } = await window(sid);
      return length === 0 ? null : head - length + 1;
    },
  };
}
