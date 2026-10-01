'use strict';

/**
 * Short-code allocation and click counting against a REAL Redis.
 *
 * Collisions are forced by injecting the code generator (the one seam that is
 * otherwise random). Every concurrency assertion is an INVARIANT that must hold
 * for every possible interleaving, not a count that depends on timing.
 */
const { connectAdmin, startTestApp } = require('./helpers/redis');

let admin;
const apps = [];

async function newApp(options) {
  const app = await startTestApp(options);
  apps.push(app);
  return app;
}
const post = (app, url, extra = {}) => app.request.post('/api/shorten').send({ url, ...extra });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Link data only: POSTs also leave the limiter's own `rl:{ip}` key in the same DB.
const linkKeys = () => admin.keys('link:*');

/** Deterministic PRNG so a failing run's code sequence is reproducible. */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeAll(async () => {
  admin = await connectAdmin();
});
beforeEach(async () => {
  await admin.flushdb();
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
afterAll(async () => {
  await admin.quit();
});

describe('creating, resolving and counting', () => {
  it('stores the link and returns a well-formed response', async () => {
    const app = await newApp();
    const res = await post(app, 'https://example.com/some/long/path');
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^[A-Za-z0-9_-]{7}$/);
    expect(res.body).toMatchObject({ originalUrl: 'https://example.com/some/long/path', ttlSeconds: null, servedBy: 'test' });
    expect(res.body.shortUrl).toBe(`http://localhost:8080/${res.body.code}`);
    expect(await admin.get(`link:{${res.body.code}}`)).toBe('https://example.com/some/long/path');
  });

  it('redirects with 302 and counts the click; stats agrees', async () => {
    const app = await newApp();
    const { body } = await post(app, 'https://example.com/redirect-test');

    const res = await app.request.get(`/${body.code}`).redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/redirect-test');
    expect(res.headers['cache-control']).toBe('no-store');

    const stats = await app.request.get(`/${body.code}/stats`);
    expect(stats.body).toMatchObject({ code: body.code, originalUrl: 'https://example.com/redirect-test', clicks: 1 });
  });

  it('counts every one of 200 concurrent redirects, exactly (no lost updates)', async () => {
    const app = await newApp();
    const { body } = await post(app, 'https://example.com/hot');

    const responses = await Promise.all(Array.from({ length: 200 }, () => app.request.get(`/${body.code}`).redirects(0)));

    expect(responses.every((r) => r.status === 302)).toBe(true);
    expect(Number(await admin.get(`link:{${body.code}}:clicks`))).toBe(200);
  });

  it('HEAD resolves but is not counted as a click', async () => {
    const app = await newApp();
    const { body } = await post(app, 'https://example.com/head');
    const head = await app.request.head(`/${body.code}`).redirects(0);
    expect(head.status).toBe(302);
    expect((await app.request.get(`/${body.code}/stats`)).body.clicks).toBe(0);
  });

  it('404s for an unknown code and does NOT create an orphan counter', async () => {
    const app = await newApp();
    const res = await app.request.get('/doesnotexist').redirects(0);
    expect(res.status).toBe(404);
    expect(await linkKeys()).toEqual([]);
  });

  it('404s for malformed codes', async () => {
    const app = await newApp();
    expect((await app.request.get('/bad!code').redirects(0)).status).toBe(404);
    expect((await app.request.get(`/${'a'.repeat(100)}`).redirects(0)).status).toBe(404);
    expect((await app.request.get('/favicon.ico').redirects(0)).status).toBe(404);
  });
});

describe('short-code allocation is atomic (SET NX)', () => {
  it('a collision retries with a new code and leaves the existing link untouched', async () => {
    const codes = ['collide', 'fresh01'];
    const app = await newApp({ generateCode: () => codes.shift() });
    await admin.set('link:{collide}', 'https://example.com/ORIGINAL');
    await admin.set('link:{collide}:clicks', 42);

    const res = await post(app, 'https://example.com/new');

    expect(res.status).toBe(201);
    expect(res.body.code).toBe('fresh01');
    expect(await admin.get('link:{collide}')).toBe('https://example.com/ORIGINAL');
    expect(await admin.get('link:{collide}:clicks')).toBe('42');
  });

  it('exhausted retries answer 503 and NEVER overwrite the existing link or its clicks', async () => {
    const app = await newApp({ generateCode: () => 'collide' });
    await admin.set('link:{collide}', 'https://example.com/ORIGINAL');
    await admin.set('link:{collide}:clicks', 42);

    const res = await post(app, 'https://evil.example/NEW');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(await admin.get('link:{collide}')).toBe('https://example.com/ORIGINAL');
    expect(await admin.get('link:{collide}:clicks')).toBe('42');
  });

  it('30 concurrent creators all handed the SAME code: exactly one wins, the rest get 503, nothing is overwritten', async () => {
    const app = await newApp({ generateCode: () => 'collide' });

    const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => post(app, `https://example.com/u${i}`)));

    const winners = responses.filter((r) => r.status === 201);
    expect(winners).toHaveLength(1);
    expect(responses.filter((r) => r.status === 503)).toHaveLength(29);
    // The one user told "/collide is yours" is the one whose URL is stored.
    expect(await admin.get('link:{collide}')).toBe(winners[0].body.originalUrl);
    expect(await linkKeys()).toEqual(['link:{collide}']);
  });

  it('two app instances (separate Redis connections) racing for one code: exactly one winner', async () => {
    const a = await newApp({ generateCode: () => 'collide' });
    const b = await newApp({ generateCode: () => 'collide' });

    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) => post(i % 2 === 0 ? a : b, `https://example.com/i${i}`))
    );

    const winners = responses.filter((r) => r.status === 201);
    expect(winners).toHaveLength(1);
    expect(await admin.get('link:{collide}')).toBe(winners[0].body.originalUrl);
  });

  it('under heavy contention on a small code pool, every 201 owns a distinct code that stores its own URL', async () => {
    const POOL = 20;
    const rand = mulberry32(12345);
    const pool = Array.from({ length: POOL }, (_, i) => `pool${String(i).padStart(3, '0')}`);
    const generateCode = () => pool[Math.floor(rand() * POOL)];
    const a = await newApp({ generateCode });
    const b = await newApp({ generateCode });

    const responses = await Promise.all(
      Array.from({ length: 120 }, (_, i) => post(i % 2 === 0 ? a : b, `https://example.com/p${i}`))
    );

    const created = responses.filter((r) => r.status === 201);
    const failed = responses.filter((r) => r.status === 503);
    expect(created.length + failed.length).toBe(120);
    expect(created.length).toBeLessThanOrEqual(POOL);
    expect(created.length).toBeGreaterThan(0);

    const codes = created.map((r) => r.body.code);
    expect(new Set(codes).size).toBe(codes.length); // no code handed out twice
    for (const r of created) {
      // no silent overwrite: what is stored is what that caller was promised
      expect(await admin.get(`link:{${r.body.code}}`)).toBe(r.body.originalUrl);
    }
    expect(await linkKeys()).toHaveLength(created.length); // nothing extra, nothing lost
  });
});

describe('expiry', () => {
  it('ttlSeconds sets the link TTL and the click counter inherits the link\'s remaining TTL', async () => {
    const app = await newApp();
    const { body } = await post(app, 'https://example.com/ttl', { ttlSeconds: 100 });
    expect(body.ttlSeconds).toBe(100);

    const linkTtl = await admin.pttl(`link:{${body.code}}`);
    expect(linkTtl).toBeGreaterThan(99000);
    expect(linkTtl).toBeLessThanOrEqual(100000);

    await app.request.get(`/${body.code}`).redirects(0);
    const clicksTtl = await admin.pttl(`link:{${body.code}}:clicks`);
    expect(clicksTtl).toBeGreaterThan(0);
    expect(clicksTtl).toBeLessThanOrEqual(linkTtl);
    expect(linkTtl - clicksTtl).toBeLessThan(1000); // same expiry instant, within a second of test overhead
  });

  it('LINK_DEFAULT_TTL_SECONDS applies when the caller sends none, and the caller can override it', async () => {
    const app = await newApp({ env: { LINK_DEFAULT_TTL_SECONDS: '50' } });
    const dflt = await post(app, 'https://example.com/d');
    expect(dflt.body.ttlSeconds).toBe(50);
    expect(await admin.pttl(`link:{${dflt.body.code}}`)).toBeLessThanOrEqual(50000);

    const override = await post(app, 'https://example.com/o', { ttlSeconds: 500 });
    expect(await admin.pttl(`link:{${override.body.code}}`)).toBeGreaterThan(50000);
  });

  it('links without a TTL never expire', async () => {
    const app = await newApp();
    const { body } = await post(app, 'https://example.com/forever');
    expect(await admin.pttl(`link:{${body.code}}`)).toBe(-1);
  });

  it('after expiry the link is 404 and BOTH keys are gone (real elapsed time; ~1s TTL + 400ms slack)', async () => {
    const app = await newApp();
    const { body } = await post(app, 'https://example.com/short-lived', { ttlSeconds: 1 });
    await app.request.get(`/${body.code}`).redirects(0); // counter now exists, with the link's TTL

    await sleep(1000 + 400);

    expect((await app.request.get(`/${body.code}`).redirects(0)).status).toBe(404);
    expect((await app.request.get(`/${body.code}/stats`)).status).toBe(404);
    expect(await linkKeys()).toEqual([]);
  });
});
