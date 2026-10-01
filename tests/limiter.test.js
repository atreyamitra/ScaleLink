'use strict';

/**
 * The sliding-window limiter against a REAL Redis. No mocks.
 *
 * Timing policy: anything decided by Redis's own clock cannot be driven by a
 * fake clock, so these tests avoid sleeping wherever possible by SEEDING the
 * sorted set with scores computed from `TIME` on the same server (clearly
 * inside or clearly outside the window). Only the two tests that must observe
 * real elapsed time sleep, with the tolerances stated in-line.
 */
const Redis = require('ioredis');
const { SlidingWindowLimiter, limiterKey } = require('../src/limiter/slidingWindowLimiter');
const { TEST_REDIS_URL, connectAdmin } = require('./helpers/redis');

let admin;
const clients = [];

function newClient() {
  const client = new Redis(TEST_REDIS_URL);
  client.on('error', () => {});
  clients.push(client);
  return client;
}

async function serverNowMs() {
  const [sec, micro] = await admin.time();
  return Number(sec) * 1000 + Math.floor(Number(micro) / 1000);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  admin = await connectAdmin();
});
beforeEach(async () => {
  await admin.flushdb();
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.quit().catch(() => c.disconnect())));
  await admin.quit();
});

describe('sliding window limiter (real Redis)', () => {
  it('admits EXACTLY `limit` of 200 concurrent requests spread over 8 independent connections', async () => {
    const limit = 10;
    // 8 separate connections = 8 independent "app instances" racing on one key.
    const limiters = Array.from({ length: 8 }, () => new SlidingWindowLimiter(newClient(), { windowMs: 60000, limit }));

    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => limiters[i % 8].check('client-a')));

    expect(results.filter((r) => r.allowed)).toHaveLength(limit);
    expect(results.filter((r) => !r.allowed)).toHaveLength(190);
    expect(await admin.zcard(limiterKey('client-a'))).toBe(limit);
  });

  it('is exact at the boundary: request N is admitted, N+1 is rejected, remaining counts down', async () => {
    const limiter = new SlidingWindowLimiter(newClient(), { windowMs: 60000, limit: 5 });
    const remaining = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await limiter.check('c');
      expect(r.allowed).toBe(true);
      remaining.push(r.remaining);
    }
    expect(remaining).toEqual([4, 3, 2, 1, 0]);

    const rejected = await limiter.check('c');
    expect(rejected).toMatchObject({ allowed: false, remaining: 0 });
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
    expect(rejected.retryAfterMs).toBeLessThanOrEqual(60000);
  });

  it('keeps clients independent', async () => {
    const limiter = new SlidingWindowLimiter(newClient(), { windowMs: 60000, limit: 2 });
    expect((await limiter.check('a')).allowed).toBe(true);
    expect((await limiter.check('a')).allowed).toBe(true);
    expect((await limiter.check('a')).allowed).toBe(false);
    expect((await limiter.check('b')).allowed).toBe(true);
  });

  it('rejected requests record nothing: the set is bounded by `limit` and the TTL is not extended', async () => {
    const limiter = new SlidingWindowLimiter(newClient(), { windowMs: 60000, limit: 3 });
    for (let i = 0; i < 3; i += 1) await limiter.check('c');
    const ttlAfterAccepts = await admin.pttl(limiterKey('c'));

    await Promise.all(Array.from({ length: 500 }, () => limiter.check('c')));

    expect(await admin.zcard(limiterKey('c'))).toBe(3);
    expect(await admin.pttl(limiterKey('c'))).toBeLessThanOrEqual(ttlAfterAccepts);
  });

  it('gives every accepted request a UNIQUE member, even when many land in the same millisecond', async () => {
    const limiters = Array.from({ length: 4 }, () => new SlidingWindowLimiter(newClient(), { windowMs: 60000, limit: 2000 }));

    const results = await Promise.all(Array.from({ length: 1000 }, (_, i) => limiters[i % 4].check('burst')));
    expect(results.every((r) => r.allowed)).toBe(true);

    // If any two accepted requests had produced the same member, ZADD would
    // have overwritten one and the set would be smaller than the number accepted.
    expect(await admin.zcard(limiterKey('burst'))).toBe(1000);

    // Precondition that makes the assertion above meaningful: some requests
    // really did share a millisecond.
    const scores = (await admin.zrange(limiterKey('burst'), 0, -1, 'WITHSCORES')).filter((_, i) => i % 2 === 1);
    const perMs = new Map();
    for (const s of scores) perMs.set(s, (perMs.get(s) || 0) + 1);
    expect(Math.max(...perMs.values())).toBeGreaterThanOrEqual(2);
  });

  describe('window membership, seeded from Redis TIME (no sleeping)', () => {
    it('drops entries older than the window, counts those inside it, and cleans up', async () => {
      const windowMs = 10000;
      const limit = 5;
      const key = limiterKey('seeded');
      const now = await serverNowMs();
      // 5 entries well OUTSIDE the window (5s past its edge), 3 well INSIDE it (1s old).
      for (let i = 0; i < 5; i += 1) await admin.zadd(key, now - windowMs - 5000, `old-${i}`);
      for (let i = 0; i < 3; i += 1) await admin.zadd(key, now - 1000, `fresh-${i}`);

      const limiter = new SlidingWindowLimiter(newClient(), { windowMs, limit });
      const first = await limiter.check('seeded');

      // Old entries must not count (else 8 >= 5 would reject) and must be deleted.
      expect(first).toMatchObject({ allowed: true, remaining: 1 });
      expect(await admin.zcard(key)).toBe(4); // 3 fresh + the new one; the 5 old are gone
      expect((await limiter.check('seeded')).remaining).toBe(0);
      expect((await limiter.check('seeded')).allowed).toBe(false);
    });

    it('reports retryAfterMs from the OLDEST live entry (when a slot actually frees up)', async () => {
      const windowMs = 10000;
      const key = limiterKey('retry');
      const now = await serverNowMs();
      // Oldest live entry is 4s old -> frees up in ~6s. Others are newer.
      await admin.zadd(key, now - 4000, 'a', now - 2000, 'b');

      const limiter = new SlidingWindowLimiter(newClient(), { windowMs, limit: 2 });
      const r = await limiter.check('retry');

      expect(r.allowed).toBe(false);
      // Tolerance: seeded from TIME a few ms earlier; allow 500ms of scheduling slack.
      expect(r.retryAfterMs).toBeGreaterThan(6000 - 500);
      expect(r.retryAfterMs).toBeLessThanOrEqual(6000);
    });
  });

  describe('real elapsed time (explicit tolerances)', () => {
    it('re-admits exactly when the oldest entry ages out, and not before', async () => {
      const windowMs = 1500;
      const limiter = new SlidingWindowLimiter(newClient(), { windowMs, limit: 2 });
      expect((await limiter.check('t')).allowed).toBe(true);
      expect((await limiter.check('t')).allowed).toBe(true);
      const blocked = await limiter.check('t');
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBeLessThanOrEqual(windowMs);

      // Still inside the window 400ms before the reported time (tolerance: a
      // scheduler stall > 400ms here would make this flaky; allowed headroom).
      await sleep(Math.max(0, blocked.retryAfterMs - 400));
      expect((await limiter.check('t')).allowed).toBe(false);

      // Past the reported time (+150ms slack for timer granularity): admitted.
      await sleep(400 + 150);
      expect((await limiter.check('t')).allowed).toBe(true);
    });

    it('expires an idle client\'s key on its own (no unbounded growth)', async () => {
      const limiter = new SlidingWindowLimiter(newClient(), { windowMs: 800, limit: 3 });
      await limiter.check('idle');
      const ttl = await admin.pttl(limiterKey('idle'));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(800);

      await sleep(800 + 300); // window + slack for Redis's expiry cycle
      expect(await admin.exists(limiterKey('idle'))).toBe(0);
    });
  });

  it('uses Redis time, not the caller\'s clock: an app instance with a skewed clock cannot widen the window', async () => {
    // Regression for the previous implementation, where the app passed
    // Date.now() into the script. A second instance whose clock was one window
    // ahead then saw every entry as expired and jointly admitted 2x the limit.
    const limiter = new SlidingWindowLimiter(newClient(), { windowMs: 10000, limit: 10 });
    for (let i = 0; i < 10; i += 1) expect((await limiter.check('skew')).allowed).toBe(true);

    const realNow = Date.now;
    Date.now = () => realNow() + 11000; // this process's clock is now 11s fast
    try {
      const results = await Promise.all(Array.from({ length: 10 }, () => limiter.check('skew')));
      expect(results.filter((r) => r.allowed)).toHaveLength(0);
    } finally {
      Date.now = realNow;
    }
  });

  it('validates its constructor arguments', () => {
    const redis = newClient();
    expect(() => new SlidingWindowLimiter(redis, { windowMs: 0, limit: 5 })).toThrow(/windowMs/);
    expect(() => new SlidingWindowLimiter(redis, { windowMs: 1000, limit: 0 })).toThrow(/limit/);
    expect(() => new SlidingWindowLimiter(redis, { windowMs: 1.5, limit: 5 })).toThrow(/windowMs/);
  });
});
