process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_MAX_REQUESTS = '2';
process.env.TRUST_PROXY = '';
const request = require('supertest');
const createApp = require('../src/app');
const { getRedisClient, closeRedisClient } = require('../src/config/redis');
afterEach(async () => { await getRedisClient().flushall(); });
afterAll(closeRedisClient);
test('untrusted callers cannot evade the limit by changing forwarded IP headers', async () => {
  const app = createApp();
  const statuses = [];
  for (let i = 1; i <= 3; i++) {
    statuses.push((await request(app).post('/api/shorten')
      .set('X-Forwarded-For', `203.0.113.${i}`)
      .send({ url: 'https://example.com/' })).status);
  }
  expect(statuses).toEqual([201, 201, 429]);
});
