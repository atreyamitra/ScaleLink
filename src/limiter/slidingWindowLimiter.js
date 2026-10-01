'use strict';

/**
 * Sliding-window-LOG rate limiter as one atomic Redis Lua script.
 *
 * State: one sorted set per client, `rl:{<client>}`. Each ACCEPTED request is
 * one member; its score is the Redis-server time in ms at acceptance. Rejected
 * requests record nothing, so a client hammering a closed window cannot grow
 * its own set: the set never holds more than `limit` members.
 *
 * Decision, in one script (Redis runs a script to completion before any other
 * command, so "trim, count, decide, record" cannot interleave with another
 * request for the same client, from any app instance or connection):
 *
 *   1. now := Redis TIME (ms)
 *   2. drop members with score <= now - window       -> live window is (now-window, now]
 *   3. count := ZCARD
 *   4. count >= limit  -> reject, record nothing, report when the oldest entry ages out
 *      count <  limit  -> ZADD (now, unique member), PEXPIRE key window, accept
 *
 * Why Redis TIME and not the app's Date.now(): with the app's clock, two
 * instances whose clocks differ by >= window would each treat the other's
 * entries as expired and jointly admit 2x the limit (reproduced against the
 * previous implementation). With Redis TIME, every instance is judged by the
 * one clock that owns the data. Requires Redis >= 5 (effects replication,
 * which allows TIME before a write inside a script).
 *
 * Why the member is `<now>-<k>` with k = ZCOUNT(now, now): members must be
 * unique or ZADD would overwrite an existing member and under-count. Entries
 * stamped with the current millisecond are never trimmed (step 2 only removes
 * scores <= now - window, and window >= 1), so counting them yields the next
 * free suffix, deterministically and without randomness or a second key.
 *
 * Cleanup: PEXPIRE on every accept means an idle client's key disappears
 * `window` ms after its last accepted request, i.e. exactly when its newest
 * entry would have aged out.
 *
 * Complexity per request: O(log N + M), N <= limit entries in the set, M the
 * number of expired entries removed (each entry is removed once).
 */
const SLIDING_WINDOW_SCRIPT = `
local window_ms = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window_ms)
local count = redis.call('ZCARD', KEYS[1])

if count >= limit then
  local retry_after_ms = 1
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  if oldest[2] then
    retry_after_ms = tonumber(oldest[2]) + window_ms - now
    if retry_after_ms < 1 then retry_after_ms = 1 end
  end
  return { 0, 0, retry_after_ms }
end

local same_ms = redis.call('ZCOUNT', KEYS[1], now, now)
redis.call('ZADD', KEYS[1], now, string.format('%d-%d', now, same_ms))
redis.call('PEXPIRE', KEYS[1], window_ms)
return { 1, limit - count - 1, 0 }
`;

const KEY_PREFIX = 'rl:';

/** `{...}` is a Redis Cluster hash tag: the key's slot depends only on the identity. */
function limiterKey(identity) {
  return `${KEY_PREFIX}{${identity}}`;
}

class SlidingWindowLimiter {
  constructor(redis, { windowMs, limit }) {
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new Error('windowMs must be a positive integer');
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
    this.redis = redis;
    this.windowMs = windowMs;
    this.limit = limit;
    // Registers the script; ioredis sends EVALSHA and falls back to EVAL on NOSCRIPT.
    redis.defineCommand('slidingWindowCheck', { numberOfKeys: 1, lua: SLIDING_WINDOW_SCRIPT });
  }

  /**
   * Record-and-decide for one request from `identity`.
   * Rejects (throws) if Redis fails; the caller decides the failure policy.
   * @returns {Promise<{allowed: boolean, remaining: number, retryAfterMs: number, limit: number}>}
   */
  async check(identity) {
    const [allowed, remaining, retryAfterMs] = await this.redis.slidingWindowCheck(
      limiterKey(identity),
      this.windowMs,
      this.limit
    );
    return { allowed: allowed === 1, remaining, retryAfterMs, limit: this.limit };
  }
}

module.exports = { SlidingWindowLimiter, SLIDING_WINDOW_SCRIPT, limiterKey, KEY_PREFIX };
