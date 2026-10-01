'use strict';

/** HTTP contract: status-code semantics, validation errors, headers, metering. Real Redis. */
const { connectAdmin, startTestApp } = require('./helpers/redis');

let admin;
const apps = [];
async function newApp(options) {
  const app = await startTestApp(options);
  apps.push(app);
  return app;
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

describe('POST /api/shorten input handling', () => {
  it.each([
    ['invalid URL', { url: 'not-a-url' }],
    ['missing url', {}],
    ['javascript: scheme', { url: 'javascript:alert(1)' }],
    ['non-string url', { url: 123 }],
    ['unknown field', { url: 'https://example.com', code: 'mine' }],
    ['bad ttl', { url: 'https://example.com', ttlSeconds: 0 }],
    ['credentials in URL', { url: 'https://trusted.com@evil.example/' }],
    ['URL over 2048 chars', { url: `https://example.com/${'a'.repeat(2100)}` }],
  ])('400 for %s', async (_label, body) => {
    const app = await newApp();
    const res = await app.request.post('/api/shorten').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
    expect(await admin.keys('link:*')).toEqual([]);
  });

  it('400 (not 500) for malformed JSON, without echoing parser internals', async () => {
    const app = await newApp();
    const res = await app.request.post('/api/shorten').set('Content-Type', 'application/json').send('{"url": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Malformed JSON body' });
  });

  it('415 (not 500) for a non-JSON content type, and for no body at all', async () => {
    const app = await newApp();
    const text = await app.request.post('/api/shorten').set('Content-Type', 'text/plain').send('hello');
    expect(text.status).toBe(415);
    const none = await app.request.post('/api/shorten');
    expect(none.status).toBe(415);
  });

  it('413 for a body over the 4kb limit', async () => {
    const app = await newApp();
    const res = await app.request.post('/api/shorten').send({ url: 'https://example.com/', pad: 'x'.repeat(5000) });
    expect(res.status).toBe(413);
  });

  it('stores the normalised URL', async () => {
    const app = await newApp();
    const res = await app.request.post('/api/shorten').send({ url: 'https://EXAMPLE.com' });
    expect(res.status).toBe(201);
    expect(res.body.originalUrl).toBe('https://example.com/');
  });
});

describe('rate limiting over HTTP', () => {
  it('sets rate-limit headers and Retry-After on 429', async () => {
    const app = await newApp({ env: { RATE_LIMIT_MAX_REQUESTS: '2', RATE_LIMIT_WINDOW_SECONDS: '30' } });
    const ok = await app.request.post('/api/shorten').send({ url: 'https://example.com/1' });
    expect(ok.headers['x-ratelimit-limit']).toBe('2');
    expect(ok.headers['x-ratelimit-remaining']).toBe('1');
    expect(ok.headers['x-served-by']).toBe('test');

    await app.request.post('/api/shorten').send({ url: 'https://example.com/2' });
    const limited = await app.request.post('/api/shorten').send({ url: 'https://example.com/3' });
    expect(limited.status).toBe(429);
    expect(limited.headers['x-ratelimit-remaining']).toBe('0');
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(30);
    expect(limited.body).toMatchObject({ error: 'Too many requests', limit: 2 });
  });

  it('admits exactly `limit` of 100 concurrent requests from one client', async () => {
    const app = await newApp({ env: { RATE_LIMIT_MAX_REQUESTS: '5' } });
    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, i) => app.request.post('/api/shorten').send({ url: `https://example.com/c${i}` }))
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(5);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(95);
    expect(await admin.keys('link:*')).toHaveLength(5);
  });

  it('meters EVERY attempt, including malformed ones (garbage is not free)', async () => {
    const app = await newApp({ env: { RATE_LIMIT_MAX_REQUESTS: '3' } });
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request.post('/api/shorten').set('Content-Type', 'application/json').send('{"url": ');
      statuses.push(res.status);
    }
    expect(statuses).toEqual([400, 400, 400, 429, 429]);
  });

  it('does not rate-limit redirects (the hot read path)', async () => {
    const app = await newApp({ env: { RATE_LIMIT_MAX_REQUESTS: '1' } });
    const { body } = await app.request.post('/api/shorten').send({ url: 'https://example.com/read' });
    const statuses = [];
    for (let i = 0; i < 10; i += 1) statuses.push((await app.request.get(`/${body.code}`).redirects(0)).status);
    expect(statuses.every((s) => s === 302)).toBe(true);
  });
});

describe('probes and misc', () => {
  it('/health (liveness) and /ready (readiness) report ok when Redis is reachable', async () => {
    const app = await newApp();
    const health = await app.request.get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: 'ok', instance: 'test' });
    const ready = await app.request.get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');
  });

  it('404s unknown routes as JSON', async () => {
    const app = await newApp();
    const res = await app.request.delete('/api/shorten');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Route not found/);
  });
});
