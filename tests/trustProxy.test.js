'use strict';

/**
 * Client identity for the rate limiter = req.ip = f(trust proxy).
 * The test client always connects from loopback, so `loopback` / a hop count
 * stand in for "a trusted reverse proxy is in front of us".
 */
const { connectAdmin, startTestApp } = require('./helpers/redis');

let admin;
const apps = [];
async function newApp(env) {
  const app = await startTestApp({ env: { RATE_LIMIT_MAX_REQUESTS: '2', ...env } });
  apps.push(app);
  return app;
}
const create = (app, headers = {}) => app.request.post('/api/shorten').set(headers).send({ url: 'https://example.com/' });

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

describe('default configuration (TRUST_PROXY unset): forwarded headers are ignored', () => {
  it('a client cannot dodge the limit by rotating X-Forwarded-For', async () => {
    const app = await newApp({});
    const statuses = [];
    for (let i = 1; i <= 6; i += 1) {
      statuses.push((await create(app, { 'X-Forwarded-For': `198.51.100.${i}` })).status);
    }
    // Regression: the previous `trust proxy: true` admitted all 6 (one fresh bucket each).
    expect(statuses).toEqual([201, 201, 429, 429, 429, 429]);
    expect(await admin.keys('rl:*')).toHaveLength(1);
  });

  it('also ignores X-Real-IP and Forwarded', async () => {
    const app = await newApp({});
    const statuses = [];
    for (let i = 1; i <= 4; i += 1) {
      statuses.push((await create(app, { 'X-Real-IP': `198.51.100.${i}`, Forwarded: `for=198.51.100.${i}` })).status);
    }
    expect(statuses).toEqual([201, 201, 429, 429]);
  });

  it('is exact under concurrency with a different forged header on every request', async () => {
    const app = await newApp({ RATE_LIMIT_MAX_REQUESTS: '10' });
    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, i) => create(app, { 'X-Forwarded-For': `203.0.113.${(i % 250) + 1}` }))
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(10);
  });
});

describe('behind a configured trusted proxy', () => {
  it('uses the address the trusted proxy reports (loopback is trusted here)', async () => {
    const app = await newApp({ TRUST_PROXY: 'loopback' });
    // Two different real clients as reported by the proxy: separate buckets.
    expect((await create(app, { 'X-Forwarded-For': '198.51.100.1' })).status).toBe(201);
    expect((await create(app, { 'X-Forwarded-For': '198.51.100.1' })).status).toBe(201);
    expect((await create(app, { 'X-Forwarded-For': '198.51.100.1' })).status).toBe(429);
    expect((await create(app, { 'X-Forwarded-For': '198.51.100.2' })).status).toBe(201);
  });

  it('ignores spoofed LEFT-hand entries: only the address the trusted proxy appended counts', async () => {
    const app = await newApp({ TRUST_PROXY: 'loopback' });
    const statuses = [];
    for (let i = 1; i <= 4; i += 1) {
      // The attacker prepends junk; the proxy appended the real peer, 203.0.113.7.
      statuses.push((await create(app, { 'X-Forwarded-For': `10.9.9.${i}, 203.0.113.7` })).status);
    }
    expect(statuses).toEqual([201, 201, 429, 429]);
    expect(await admin.keys('rl:*')).toEqual(['rl:{203.0.113.7}']);
  });

  it('hop-count mode (TRUST_PROXY=1) takes the rightmost entry, so forged left entries are ignored', async () => {
    const app = await newApp({ TRUST_PROXY: '1' });
    const statuses = [];
    for (let i = 1; i <= 4; i += 1) {
      statuses.push((await create(app, { 'X-Forwarded-For': `10.8.8.${i}, 203.0.113.50` })).status);
    }
    expect(statuses).toEqual([201, 201, 429, 429]);
  });

  it('an untrusted peer cannot use the header even when a proxy list is configured', async () => {
    // Only 192.0.2.1 is trusted; the test client connects from loopback, which is NOT.
    const app = await newApp({ TRUST_PROXY: '192.0.2.1' });
    const statuses = [];
    for (let i = 1; i <= 4; i += 1) {
      statuses.push((await create(app, { 'X-Forwarded-For': `198.51.100.${i}` })).status);
    }
    expect(statuses).toEqual([201, 201, 429, 429]);
  });
});

describe('misconfiguration is rejected at startup', () => {
  it('TRUST_PROXY=true refuses to boot', async () => {
    await expect(newApp({ TRUST_PROXY: 'true' })).rejects.toThrow(/forge X-Forwarded-For/);
  });
});
