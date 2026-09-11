const env = require('../config/env');
const { getRedisClient } = require('../config/redis');

/**
 * Sliding-window-log rate limiter, implemented as a single atomic Lua script.
 *
 * Why a Lua script and not plain INCR+EXPIRE: this service runs as multiple
 * stateless app instances behind a load balancer, all sharing one Redis. If
 * two instances each ran a separate "read count, then write" sequence for
 * the same client, a race between the read and write on either instance
 * could let both requests through even when the limit is exhausted -
 * classic check-then-act race. A Lua script executes as a single atomic
 * operation inside Redis (Redis is single-threaded per script), so the
 * "trim old entries, count, decide, record" sequence can't be interleaved
 * with another instance's request for the same key, no matter how many app
 * instances are calling it concurrently.
 *
 * Algorithm: sliding window log via a sorted set. Each allowed request is
 * recorded as a member scored by its timestamp; on every check we drop
 * entries older than the window, count what's left, and admit the request
 * only if under the limit - giving a precise (not approximated) sliding
 * window, unlike fixed-window counters which allow bursts at window edges.
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', key, 0, now - window_ms)
local count = redis.call('ZCARD', key)

if count < limit then
  local sequence_key = KEYS[2]
  local sequence = redis.call('INCR', sequence_key)
  redis.call('PEXPIRE', sequence_key, window_ms)
  redis.call('ZADD', key, now, tostring(sequence))
  redis.call('PEXPIRE', key, window_ms)
  return { 1, limit - count - 1 }
else
  return { 0, 0 }
end
`;

function getClientWithScript() {
  const redis = getRedisClient();
  if (!redis.slidingWindowLimit) {
    redis.defineCommand('slidingWindowLimit', {
      numberOfKeys: 2,
      lua: SLIDING_WINDOW_SCRIPT,
    });
  }
  return redis;
}

function distributedRateLimiter(options = {}) {
  const windowMs = (options.windowSeconds ?? env.rateLimit.windowSeconds) * 1000;
  const limit = options.maxRequests ?? env.rateLimit.maxRequests;

  return async function rateLimitMiddleware(req, res, next) {
    try {
      const redis = getClientWithScript();
      const key = `ratelimit:{${req.ip}}`; // hash tag: keeps this stable under Redis Cluster too
      const now = 0; // reserved argument; the Lua script uses Redis server time

      const [allowed, remaining] = await redis.slidingWindowLimit(key, `${key}:sequence`, now, windowMs, limit);

      res.set('X-RateLimit-Limit', String(limit));
      res.set('X-RateLimit-Remaining', String(Math.max(0, remaining)));
      res.set('X-Served-By', env.instanceId);

      if (!allowed) {
        res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
        return res.status(429).json({
          error: 'Too many requests',
          limit,
          windowSeconds: windowMs / 1000,
          servedBy: env.instanceId,
        });
      }

      next();
    } catch (err) {
      // Fail open: an infra hiccup shouldn't take the whole API down.
      console.error('[rateLimiter] redis error, failing open:', err.message);
      next();
    }
  };
}

module.exports = { distributedRateLimiter, SLIDING_WINDOW_SCRIPT };
