'use strict';

const pino = require('pino');
const { distributedRateLimiter, normalizeClientIp } = require('../../src/middleware/distributedRateLimiter');

// Pure unit tests of the middleware's decision mapping, with a stub limiter.
// (Redis-side atomicity is proven in tests/limiter.test.js against real Redis.)

const logger = pino({ level: 'silent' });

function run(limiter, req = { ip: '203.0.113.9' }) {
  const res = {
    headers: {},
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let nextArg = 'not called';
  const next = (arg) => {
    nextArg = arg;
  };
  return distributedRateLimiter({ limiter, instanceId: 'unit', logger })(req, res, next).then(() => ({ res, nextArg }));
}

describe('distributedRateLimiter middleware', () => {
  it('passes allowed requests through and sets headers', async () => {
    const limiter = { check: jest.fn().mockResolvedValue({ allowed: true, remaining: 4, retryAfterMs: 0, limit: 5 }) };
    const { res, nextArg } = await run(limiter);
    expect(nextArg).toBeUndefined();
    expect(res.statusCode).toBeUndefined();
    expect(res.headers).toMatchObject({ 'X-RateLimit-Limit': '5', 'X-RateLimit-Remaining': '4', 'X-Served-By': 'unit' });
    expect(limiter.check).toHaveBeenCalledWith('203.0.113.9');
  });

  it('answers 429 with Retry-After rounded UP to whole seconds', async () => {
    const limiter = { check: jest.fn().mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 1200, limit: 5 }) };
    const { res, nextArg } = await run(limiter);
    expect(nextArg).toBe('not called');
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('2');
  });

  it('never advertises a Retry-After of 0', async () => {
    const limiter = { check: jest.fn().mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 1, limit: 5 }) };
    const { res } = await run(limiter);
    expect(res.headers['Retry-After']).toBe('1');
  });

  it('FAILS CLOSED when the limiter backend errors: 503, handler never runs', async () => {
    const limiter = { check: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const { res, nextArg } = await run(limiter);
    expect(res.statusCode).toBeUndefined(); // handed to the error handler, not answered here
    expect(nextArg).toBeInstanceOf(Error);
    expect(nextArg.status).toBe(503);
    expect(nextArg.message).not.toMatch(/ECONNREFUSED/); // internals are not exposed
  });
});

describe('normalizeClientIp', () => {
  it('maps IPv4-mapped IPv6 to the IPv4 form so one client gets one bucket', () => {
    expect(normalizeClientIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeClientIp('203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeClientIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeClientIp(undefined)).toBe('unknown');
  });
});
