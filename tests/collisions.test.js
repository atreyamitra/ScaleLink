process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_MAX_REQUESTS = '100';
jest.mock('nanoid', () => ({ nanoid: jest.fn() }));
const { nanoid } = require('nanoid');
const request = require('supertest');
const createApp = require('../src/app');
const { getRedisClient, closeRedisClient } = require('../src/config/redis');
const app = createApp();
afterEach(async () => { await getRedisClient().flushall(); jest.resetAllMocks(); });
afterAll(closeRedisClient);

test('exhausted collisions preserve the existing URL and analytics', async () => {
  const redis = getRedisClient();
  await redis.set('url:collide', 'https://example.com/original');
  await redis.set('clicks:collide', 42);
  nanoid.mockReturnValue('collide');
  const res = await request(app).post('/api/shorten').send({ url: 'https://example.com/new' });
  expect(res.status).toBe(503);
  expect(await redis.get('url:collide')).toBe('https://example.com/original');
  expect(await redis.get('clicks:collide')).toBe('42');
});

test('simultaneous allocations of one code never overwrite each other', async () => {
  nanoid.mockReturnValue('collide');
  const responses = await Promise.all(['first', 'second'].map(id =>
    request(app).post('/api/shorten').send({ url: `https://example.com/${id}` })));
  expect(responses.map(r => r.status).sort()).toEqual([201, 503]);
  const winner = responses.find(r => r.status === 201);
  expect(await getRedisClient().get('url:collide')).toBe(winner.body.originalUrl);
});

test('collision retry can reserve a different code', async () => {
  await getRedisClient().set('url:collide', 'https://example.com/original');
  nanoid.mockReturnValueOnce('collide').mockReturnValue('newcode');
  const res = await request(app).post('/api/shorten').send({ url: 'https://example.com/new' });
  expect(res.status).toBe(201);
  expect(res.body.code).toBe('newcode');
  expect(await getRedisClient().get('url:collide')).toBe('https://example.com/original');
});
