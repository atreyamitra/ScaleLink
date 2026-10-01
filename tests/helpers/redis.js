'use strict';

/**
 * Test infrastructure for the REAL-Redis integration suite.
 *
 * These tests prove atomicity/concurrency properties, so they run against a
 * real Redis server (no ioredis-mock; a JS mock cannot demonstrate that a
 * Redis-side Lua script is atomic). If Redis is unreachable the suite FAILS
 * loudly; it never silently skips.
 *
 * Safety: the suite FLUSHDBs, so it refuses to touch database 0. Default is
 * redis://127.0.0.1:6379/15; override with TEST_REDIS_URL (use a non-zero db).
 */
const Redis = require('ioredis');
const pino = require('pino');
const supertest = require('supertest');

const { loadConfig } = require('../../src/config/env');
const { createRedisClient, closeRedisClient } = require('../../src/config/redis');
const createApp = require('../../src/app');

const TEST_REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const silentLogger = pino({ level: 'silent' });

function assertSafeDatabase() {
  const db = Number(new URL(TEST_REDIS_URL).pathname.replace('/', '') || 0);
  if (db === 0) {
    throw new Error(
      `Refusing to run: TEST_REDIS_URL (${TEST_REDIS_URL}) uses database 0 and these tests call FLUSHDB. Use a non-zero database, e.g. redis://127.0.0.1:6379/15.`
    );
  }
}

/** A plain admin connection for seeding/inspecting/flushing. Fails loudly if Redis is down. */
async function connectAdmin() {
  assertSafeDatabase();
  const admin = new Redis(TEST_REDIS_URL, { lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 0 });
  admin.on('error', () => {});
  try {
    await admin.connect();
    await admin.ping();
  } catch (err) {
    admin.disconnect();
    throw new Error(
      `A real Redis is REQUIRED for this test suite but ${TEST_REDIS_URL} is unreachable (${err.message}). ` +
        'Start one (e.g. `redis-server` or `docker run -p 6379:6379 redis:7-alpine`) or set TEST_REDIS_URL.'
    );
  }
  return admin;
}

/** Config for tests: real Redis, generous limit unless overridden, optional env overrides. */
function testConfig(env = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    REDIS_URL: TEST_REDIS_URL,
    RATE_LIMIT_MAX_REQUESTS: '100000',
    RATE_LIMIT_WINDOW_SECONDS: '60',
    INSTANCE_ID: 'test',
    ...env,
  });
}

function waitReady(client, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (client.status === 'ready') return resolve();
    const timer = setTimeout(() => reject(new Error('redis client did not become ready')), timeoutMs);
    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * One app instance with its OWN Redis connection, listening on an ephemeral
 * port. Call several times to model several instances sharing one Redis.
 */
async function startTestApp({ env = {}, generateCode, redisUrl, waitForRedis = true } = {}) {
  const config = testConfig({ ...env, ...(redisUrl ? { REDIS_URL: redisUrl } : {}) });
  // disconnectTimeout: ioredis arms a timer on disconnect() that is only cleared by a
  // later 'close' event; if the socket is already dead it would keep Jest alive for 2s.
  const redis = createRedisClient(config, silentLogger, { disconnectTimeout: 50 });
  if (waitForRedis) await waitReady(redis);
  const app = createApp({ config, redis, logger: silentLogger, generateCode });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    config,
    redis,
    server,
    url,
    request: supertest(server),
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await closeRedisClient(redis);
    },
  };
}

module.exports = { TEST_REDIS_URL, silentLogger, connectAdmin, testConfig, startTestApp, waitReady };
