'use strict';

/**
 * Two (or more) REAL app instances: separate `node src/server.js` OS processes,
 * each with its own event loop and Redis connection, sharing one real Redis.
 * Requests are sent over real HTTP, round-robin across the instances.
 */
const { connectAdmin } = require('./helpers/redis');
const { startInstance } = require('./helpers/spawnApp');

let admin;
let instances = [];

async function startPair(env = {}) {
  const pair = await Promise.all([
    startInstance({ instanceId: 'app-a', env }),
    startInstance({ instanceId: 'app-b', env }),
  ]);
  instances.push(...pair);
  return pair;
}

const jsonPost = (baseUrl, body, headers = {}) =>
  fetch(`${baseUrl}/api/shorten`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function summarise(responses) {
  return {
    statuses: responses.map((r) => r.status),
    servedBy: new Set(responses.map((r) => r.headers.get('x-served-by'))),
  };
}

beforeAll(async () => {
  admin = await connectAdmin();
});
beforeEach(async () => {
  await admin.flushdb();
});
afterEach(async () => {
  await Promise.all(instances.splice(0).map((i) => i.stop()));
});
afterAll(async () => {
  await admin.quit();
});

describe('two app processes sharing one Redis: one rate limit', () => {
  it('admits EXACTLY `limit` of 200 concurrent requests from one client split across both instances', async () => {
    const limit = 10;
    const [a, b] = await startPair({ RATE_LIMIT_MAX_REQUESTS: String(limit), RATE_LIMIT_WINDOW_SECONDS: '60' });

    const responses = await Promise.all(
      Array.from({ length: 200 }, (_, i) => jsonPost((i % 2 === 0 ? a : b).url, { url: `https://example.com/m${i}` }))
    );
    const { statuses, servedBy } = await summarise(responses);

    expect(statuses.filter((s) => s === 201)).toHaveLength(limit);
    expect(statuses.filter((s) => s === 429)).toHaveLength(200 - limit);
    expect(servedBy).toEqual(new Set(['app-a', 'app-b'])); // both really took part
    expect(await admin.keys('link:*')).toHaveLength(limit);
    expect(await admin.zcard('rl:{127.0.0.1}')).toBe(limit);
  });

  it('one client alternating between the instances sees a single shared budget', async () => {
    const [a, b] = await startPair({ RATE_LIMIT_MAX_REQUESTS: '6', RATE_LIMIT_WINDOW_SECONDS: '60' });
    const statuses = [];
    for (let i = 0; i < 10; i += 1) {
      statuses.push((await jsonPost((i % 2 === 0 ? a : b).url, { url: `https://example.com/s${i}` })).status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 201, 429, 429, 429, 429]);
  });

  it('forged X-Forwarded-For does not widen the shared limit (default: trust nobody)', async () => {
    const limit = 10;
    const [a, b] = await startPair({ RATE_LIMIT_MAX_REQUESTS: String(limit), RATE_LIMIT_WINDOW_SECONDS: '60' });

    const responses = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        jsonPost((i % 2 === 0 ? a : b).url, { url: `https://example.com/f${i}` }, { 'X-Forwarded-For': `203.0.113.${(i % 250) + 1}` })
      )
    );

    expect((await summarise(responses)).statuses.filter((s) => s === 201)).toHaveLength(limit);
    expect(await admin.keys('rl:*')).toEqual(['rl:{127.0.0.1}']);
  });
});

describe('two app processes sharing one Redis: one link namespace', () => {
  it('a link created on one instance is redirectable from the other, and clicks aggregate', async () => {
    const [a, b] = await startPair();
    const created = await (await jsonPost(a.url, { url: 'https://example.com/shared' })).json();

    const hits = await Promise.all(
      Array.from({ length: 100 }, (_, i) => fetch(`${(i % 2 === 0 ? a : b).url}/${created.code}`, { redirect: 'manual' }))
    );
    expect(hits.every((r) => r.status === 302 && r.headers.get('location') === 'https://example.com/shared')).toBe(true);

    const stats = await (await fetch(`${b.url}/${created.code}/stats`)).json();
    expect(stats).toMatchObject({ clicks: 100, originalUrl: 'https://example.com/shared' });
  });

  it('REAL code collisions across processes: with only 64 possible codes, no code is ever issued twice or overwritten', async () => {
    // CODE_LENGTH=1 shrinks the keyspace to the 64 nanoid characters, so
    // collisions are certain, not mocked. 150 creators race for them from two processes.
    const [a, b] = await startPair({ CODE_LENGTH: '1' });

    const responses = await Promise.all(
      Array.from({ length: 150 }, (_, i) => jsonPost((i % 2 === 0 ? a : b).url, { url: `https://example.com/k${i}` }))
    );
    const bodies = await Promise.all(responses.map(async (r) => ({ status: r.status, body: await r.json() })));
    const created = bodies.filter((r) => r.status === 201);
    const failed = bodies.filter((r) => r.status === 503);

    expect(created.length + failed.length).toBe(150); // every request got a definite answer
    expect(created.length).toBeLessThanOrEqual(64);
    expect(created.length).toBeGreaterThan(30); // allocation made real progress
    expect(failed.length).toBeGreaterThan(0); // and collisions really did exhaust retries

    const codes = created.map((r) => r.body.code);
    expect(new Set(codes).size).toBe(codes.length); // no code issued twice
    for (const r of created) {
      // no overwrite: the stored URL is the one promised to that code's owner
      expect(await admin.get(`link:{${r.body.code}}`)).toBe(r.body.originalUrl);
    }
    expect(await admin.keys('link:*')).toHaveLength(created.length);
  });
});
