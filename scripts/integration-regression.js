/** Real Redis + two independent Node processes. Use a dedicated test database. */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const Redis = require('ioredis');
const { SLIDING_WINDOW_SCRIPT } = require('../src/middleware/distributedRateLimiter');
if (!process.env.REDIS_URL) throw new Error('Set REDIS_URL to a dedicated test Redis');
const children = [];
const urls = [];

async function start(id) {
  const child = spawn(process.execPath, ['-e', `
    const server = require('./src/app')().listen(0, '127.0.0.1', () => {
      process.send({ port: server.address().port });
    });
  `], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', REDIS_TEST_MODE: 'real',
      TRUST_PROXY: '', INSTANCE_ID: id, RATE_LIMIT_MAX_REQUESTS: '10', RATE_LIMIT_WINDOW_SECONDS: '30' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Worker startup timed out')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Worker exited: ${code}`)); });
    child.once('message', ({ port }) => { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`); });
  });
}

async function main() {
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
  const key = `ratelimit:{test-${randomUUID()}}`;
  try {
    redis.defineCommand('testLimit', { numberOfKeys: 2, lua: SLIDING_WINDOW_SCRIPT });
    const sequence = `${key}:sequence`;
    const allowed = await redis.testLimit(key, sequence, 0, 100, 1);
    assert.equal(allowed[0], 1);
    assert.equal((await redis.testLimit(key, sequence, Date.now() + 3600000, 100, 1))[0], 0);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await redis.testLimit(key, sequence, 0, 100, 1))[0], 1, 'window must expire');
    await redis.del(key, sequence);
    const bases = await Promise.all([start('test-app-1'), start('test-app-2')]);
    const responses = await Promise.all(Array.from({ length: 200 }, async (_, i) => {
      const res = await fetch(`${bases[i % 2]}/api/shorten`, {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          'X-Forwarded-For': `203.0.113.${i + 1}` },
        body: JSON.stringify({ url: `https://example.com/test/${i}` }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await res.json();
      if (body.code) urls.push(body.code);
      return { status: res.status, instance: res.headers.get('x-served-by') };
    }));
    assert.equal(responses.filter(r => r.status === 201).length, 10);
    assert.equal(responses.filter(r => r.status === 429).length, 190);
    assert.deepEqual([...new Set(responses.map(r => r.instance))].sort(), ['test-app-1', 'test-app-2']);
    console.log('PASS: two independent app processes, 200 requests, 10 created, 190 rejected; forged IPs cannot bypass the shared limit');
    console.log('PASS: Redis-time window expiration and clock-skew resistance');
  } finally {
    await Promise.all(children.map(child => {
      if (child.exitCode !== null) return Promise.resolve();
      const exited = once(child, 'exit');
      child.kill();
      return exited;
    }));
    await redis.del(key, `${key}:sequence`, 'ratelimit:{127.0.0.1}', 'ratelimit:{127.0.0.1}:sequence');
    if (urls.length) await redis.del(...urls.flatMap(code => [`url:${code}`, `clicks:${code}`]));
    await redis.quit();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
