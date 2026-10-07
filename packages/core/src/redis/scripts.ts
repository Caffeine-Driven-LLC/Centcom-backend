/**
 * Lua scripts (B009) for the operations Redis must do atomically, run with EVALSHA (ioredis
 * reloads a script the server evicted, NOSCRIPT, and retries). The in-memory implementation
 * mirrors them step for step.
 *
 * Owns: the script sources. Must not: read the clock inside a script (the caller passes `now`,
 * so every implementation agrees and tests can fake time), or leave a key without a TTL.
 */

/**
 * Sliding-window rate limit. KEYS[1] is a sorted set of counted calls scored by time.
 * ARGV: now (ms), window (ms), limit, cost, nonce (unique per call, for distinct members).
 * Drops calls older than the window, counts `cost` more if they fit, refreshes the TTL, and
 * returns `{allowed (1 or 0), remaining, oldest counted call (ms) or -1}`.
 */
export const RATE_LIMIT_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local nonce = ARGV[5]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
local allowed = 0
if count + cost <= limit then
  for i = 1, cost do
    redis.call('ZADD', key, now, nonce .. ':' .. i)
  end
  count = count + cost
  allowed = 1
end
local oldest = -1
local first = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
if first[2] then
  oldest = tonumber(first[2])
end
if count > 0 then
  redis.call('PEXPIRE', key, window)
end
return {allowed, limit - count, oldest}
`;

/**
 * Counter with a TTL. KEYS[1] is the counter, ARGV[1] the TTL (ms) for a new key. Adds 1, gives
 * the key the TTL if it has none, and returns the new value.
 */
export const INCR_LUA = `
local value = redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return value
`;
