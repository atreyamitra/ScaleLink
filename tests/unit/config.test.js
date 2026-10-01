'use strict';

const { loadConfig, parseTrustProxy } = require('../../src/config/env');

describe('parseTrustProxy', () => {
  it.each([undefined, null, '', '  ', 'false', 'FALSE', '0'])('trusts nobody for %p', (raw) => {
    expect(parseTrustProxy(raw)).toBe(false);
  });

  it('accepts a hop count', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });

  it('accepts a list of proxies / CIDRs / named ranges', () => {
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toEqual(['loopback', '10.0.0.0/8']);
    expect(parseTrustProxy('172.18.0.5')).toEqual(['172.18.0.5']);
  });

  it('refuses "true", which would let any client forge X-Forwarded-For', () => {
    expect(() => parseTrustProxy('true')).toThrow(/forge X-Forwarded-For/);
    expect(() => parseTrustProxy('TRUE')).toThrow(/forge/);
  });
});

describe('loadConfig', () => {
  it('has safe defaults', () => {
    const c = loadConfig({});
    expect(c.trustProxy).toBe(false);
    expect(c.rateLimit).toEqual({ windowSeconds: 10, maxRequests: 20 });
    expect(c.redis.commandTimeoutMs).toBe(1000);
    expect(c.links.defaultTtlSeconds).toBeNull();
    expect(c.baseUrl).toBe('http://localhost:8080');
  });

  it('fails fast on garbage instead of silently using a default', () => {
    expect(() => loadConfig({ RATE_LIMIT_MAX_REQUESTS: 'abc' })).toThrow(/RATE_LIMIT_MAX_REQUESTS must be an integer/);
    expect(() => loadConfig({ RATE_LIMIT_MAX_REQUESTS: '0' })).toThrow(/between 1 and/);
    expect(() => loadConfig({ RATE_LIMIT_WINDOW_SECONDS: '-5' })).toThrow(/between 1 and/);
    expect(() => loadConfig({ PORT: '99999' })).toThrow(/PORT/);
    expect(() => loadConfig({ CODE_LENGTH: '0' })).toThrow(/CODE_LENGTH/);
  });

  it('reads overrides and strips a trailing slash from BASE_URL', () => {
    const c = loadConfig({ RATE_LIMIT_MAX_REQUESTS: '7', BASE_URL: 'https://s.example/', TRUST_PROXY: '1', LINK_DEFAULT_TTL_SECONDS: '60' });
    expect(c.rateLimit.maxRequests).toBe(7);
    expect(c.baseUrl).toBe('https://s.example');
    expect(c.trustProxy).toBe(1);
    expect(c.links.defaultTtlSeconds).toBe(60);
  });
});
