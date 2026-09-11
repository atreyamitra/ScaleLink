const env = require('./env');

let client;

function getRedisClient() {
  if (client) return client;

  if (env.nodeEnv === 'test' && process.env.REDIS_TEST_MODE !== 'real') {
    const RedisMock = require('ioredis-mock');
    client = new RedisMock();
  } else {
    const Redis = require('ioredis');
    client = new Redis(env.redisUrl, { maxRetriesPerRequest: 3 });
    client.on('error', (err) => console.error('[redis] error', err.message));
    client.on('connect', () => console.log(`[redis] connected -> ${env.redisUrl}`));
  }
  return client;
}

async function closeRedisClient() {
  if (client) {
    await client.quit().catch(() => client.disconnect());
    client = undefined;
  }
}

module.exports = { getRedisClient, closeRedisClient };
