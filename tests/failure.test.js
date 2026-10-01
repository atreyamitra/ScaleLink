'use strict';

/**
 * What happens when Redis fails. Faults are injected on the real TCP path
 * between the app and a real Redis using FaultProxy (no mocks).
 *
 * Policy under test (docs/ARCHITECTURE.md, "Failure semantics"):
 *   - Redis down/stalled  -> 503 + Retry-After, quickly, for create, redirect, stats
 *   - rate limiter        -> FAILS CLOSED (503), never silently admits
 *   - liveness (/health)  -> stays 200;  readiness (/ready) -> 503
 *   - a redirect never answers 404 for a link we merely cannot look up
 *   - no automatic re-send of an in-flight write after a connection loss
 *   - the instance recovers by itself when Redis returns
 */
const { TEST_REDIS_URL, connectAdmin, startTestApp } = require('./helpers/redis');
const { FaultProxy } = require('./helpers/faultProxy');

const COMMAND_TIMEOUT_MS = 300;
// Generous upper bound for "fails fast": a few command timeouts, never seconds of hanging.
const FAST_MS = 2000;

let admin;
let proxy;
let app;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const create = (url = 'https://example.com/x') => app.request.post('/api/shorten').send({ url });

async function until(fn, { timeoutMs = 8000, everyMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(everyMs);
  }
}

async function timed(promise) {
  const start = Date.now();
  const res = await promise;
  return { res, ms: Date.now() - start };
}

beforeAll(async () => {
  admin = await connectAdmin();
});
beforeEach(async () => {
  await admin.flushdb();
  const { hostname, port } = new URL(TEST_REDIS_URL);
  proxy = new FaultProxy({ host: hostname, port: Number(port) });
  const proxyPort = await proxy.start();
  const db = new URL(TEST_REDIS_URL).pathname;
  app = await startTestApp({
    redisUrl: `redis://127.0.0.1:${proxyPort}${db}`,
    env: { REDIS_COMMAND_TIMEOUT_MS: String(COMMAND_TIMEOUT_MS), RATE_LIMIT_MAX_REQUESTS: '1000' },
  });
});
afterEach(async () => {
  await app.close();
  await proxy.stop();
});
afterAll(async () => {
  await admin.quit();
});

describe('Redis unreachable (connection refused)', () => {
  beforeEach(async () => {
    // Establish a link while healthy so we can prove reads fail as 503, not 404.
    const ok = await create('https://example.com/exists');
    expect(ok.status).toBe(201);
    app.knownCode = ok.body.code;
    proxy.sever();
    await until(() => app.redis.status !== 'ready');
  });

  it('create -> fast 503 with Retry-After; nothing is admitted or written', async () => {
    const { res, ms } = await timed(create());
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body).toEqual({ error: 'Storage backend unavailable; please retry' });
    expect(ms).toBeLessThan(FAST_MS);
    expect(await admin.keys('link:*')).toHaveLength(1); // only the pre-existing link
  });

  it('redirect and stats -> 503, NOT 404 (we cannot say the link does not exist)', async () => {
    const redirect = await app.request.get(`/${app.knownCode}`).redirects(0);
    const stats = await app.request.get(`/${app.knownCode}/stats`);
    expect(redirect.status).toBe(503);
    expect(stats.status).toBe(503);
  });

  it('liveness stays 200, readiness is 503', async () => {
    expect((await app.request.get('/health')).status).toBe(200);
    const ready = await app.request.get('/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.status).toMatch(/redis unavailable/);
  });

  it('recovers on its own once Redis is reachable again, and earlier data is intact', async () => {
    await proxy.heal();
    await until(async () => (await app.request.get('/ready')).status === 200);

    expect((await create('https://example.com/after')).status).toBe(201);
    const redirect = await app.request.get(`/${app.knownCode}`).redirects(0);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe('https://example.com/exists');
  });
});

describe('Redis stalled (accepts connections, answers nothing)', () => {
  it('requests fail with 503 within the command timeout instead of hanging', async () => {
    proxy.setMode('stall');

    const create503 = await timed(create());
    const redirect503 = await timed(app.request.get('/abcdefg').redirects(0));
    const ready503 = await timed(app.request.get('/ready'));

    for (const { res, ms } of [create503, redirect503, ready503]) {
      expect(res.status).toBe(503);
      expect(ms).toBeGreaterThanOrEqual(COMMAND_TIMEOUT_MS - 50); // it did wait for the timeout...
      expect(ms).toBeLessThan(COMMAND_TIMEOUT_MS + FAST_MS); // ...and no longer than that
    }
  });

  it('the limiter fails CLOSED: with Redis stalled no request is ever admitted', async () => {
    proxy.setMode('stall');
    const results = await Promise.all(Array.from({ length: 10 }, () => create()));
    expect(results.every((r) => r.status === 503)).toBe(true);
    proxy.setMode('pass');
    expect(await admin.keys('link:*')).toEqual([]);
  });
});

describe('ambiguous write outcome: in-flight commands are never silently re-sent', () => {
  // Both tests lose the connection AFTER Redis has executed a write but BEFORE
  // the app saw the reply, then restore the connection while the command is
  // still pending (well inside the command timeout). With
  // autoResendUnfulfilledCommands=true ioredis would re-send the write on
  // reconnect and the app would act on the second execution's reply.
  async function loseReplyThenReconnect(trigger, request) {
    const sent = proxy.dropRepliesWhen(trigger);
    // supertest requests are lazy thenables: .then() is what actually sends it.
    const inFlight = request().then((r) => r);
    await sent;
    await sleep(60); // the write reaches Redis in well under a millisecond locally; 60ms is ample
    proxy.sever();
    await proxy.heal(); // reconnect succeeds ~50ms later, well within the 300ms command timeout
    const res = await inFlight;
    await until(async () => (await app.request.get('/ready')).status === 200);
    await sleep(300); // room for any (unwanted) late resend to show up
    return res;
  }

  it('create: 503 and exactly ONE mapping (a re-sent SET NX would look like a collision and mint a second code)', async () => {
    const res = await loseReplyThenReconnect(/SET[\s\S]*link:\{/i, () => create('https://example.com/ambiguous'));

    expect(res.status).toBe(503);
    const links = await admin.keys('link:*');
    expect(links).toHaveLength(1); // the original SET really was applied, exactly once
    expect(await admin.get(links[0])).toBe('https://example.com/ambiguous');
  });

  it('redirect: 503 and the click is counted exactly ONCE (a re-sent increment would double-count)', async () => {
    const { body } = await create('https://example.com/clicks');
    const res = await loseReplyThenReconnect(/link:\{[^}]+\}:clicks/, () => app.request.get(`/${body.code}`).redirects(0));

    expect(res.status).toBe(503);
    expect(await admin.get(`link:{${body.code}}:clicks`)).toBe('1');
  });
});
