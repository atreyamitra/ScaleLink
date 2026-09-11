/** Concurrent limiter verification against an explicitly selected test Redis. */
process.env.NODE_ENV = 'development';
if (!process.env.REDIS_URL) throw new Error('Set REDIS_URL to a dedicated test Redis');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { getRedisClient, closeRedisClient } = require('./src/config/redis');
async function main() {
  const redis = getRedisClient();
  const key = `ratelimit:{verify-${randomUUID()}}`;
  const sequence = `${key}:sequence`;
  redis.defineCommand('slidingWindowLimit', {
    numberOfKeys: 2,
    lua: require('./src/middleware/distributedRateLimiter').SLIDING_WINDOW_SCRIPT,
  });
  try {
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) =>
      // Deliberately skew the obsolete client clock argument in both directions.
      redis.slidingWindowLimit(key, sequence, i % 2 ? 0 : Date.now() + 3600000, 5000, 10)));
    assert.equal(results.filter(([allowed]) => allowed === 1).length, 10);
    assert.equal(results.filter(([allowed]) => allowed === 0).length, 190);
    assert.equal(await redis.zcard(key), 10);
    console.log('PASS: 200 concurrent calls, 10 allowed, 190 denied, client clock skew ignored');
  } finally {
    await redis.del(key, sequence);
    await closeRedisClient();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
