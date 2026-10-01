'use strict';

const { parseShortenRequest } = require('../../src/links/validate');

const LIMITS = { maxUrlLength: 2048, maxTtlSeconds: 31536000 };

function req(body, contentType = 'application/json') {
  return { body, is: (type) => (contentType === type ? type : false) };
}
const parse = (body, contentType) => parseShortenRequest(req(body, contentType), LIMITS);
const status = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.status;
  }
  return 'no error';
};

describe('parseShortenRequest', () => {
  it('accepts http and https and returns the normalised href', () => {
    expect(parse({ url: 'https://example.com' })).toEqual({ url: 'https://example.com/', ttlSeconds: null });
    expect(parse({ url: 'http://example.com/a b?q=1' }).url).toBe('http://example.com/a%20b?q=1');
  });

  it('strips control characters rather than storing them', () => {
    expect(parse({ url: 'https://exa\tmple.com/\npath' }).url).toBe('https://example.com/path');
  });

  it.each([
    ['not a url', 'not-a-url'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,hi'],
    ['file scheme', 'file:///etc/passwd'],
    ['ftp scheme', 'ftp://example.com/'],
    ['relative', '/just/a/path'],
    ['embedded credentials', 'https://trusted.com@evil.example/'],
    ['empty', ''],
  ])('rejects %s', (_label, url) => {
    expect(status(() => parse({ url }))).toBe(400);
  });

  it('rejects over-long URLs', () => {
    expect(status(() => parse({ url: `https://example.com/${'a'.repeat(2048)}` }))).toBe(400);
    expect(status(() => parse({ url: `https://example.com/${'a'.repeat(2000)}` }))).toBe('no error');
  });

  it('rejects bad body shapes', () => {
    expect(status(() => parse({}))).toBe(400);
    expect(status(() => parse({ url: 42 }))).toBe(400);
    expect(status(() => parse({ url: ['https://example.com'] }))).toBe(400);
    expect(status(() => parse([]))).toBe(400);
    expect(status(() => parse(null))).toBe(400);
    expect(status(() => parse('https://example.com'))).toBe(400);
  });

  it('rejects unknown fields', () => {
    expect(status(() => parse({ url: 'https://example.com', code: 'mine' }))).toBe(400);
  });

  it('returns 415 for a non-JSON content type (Express 5 leaves req.body undefined)', () => {
    expect(status(() => parse(undefined, 'text/plain'))).toBe(415);
  });

  it('validates ttlSeconds', () => {
    expect(parse({ url: 'https://example.com', ttlSeconds: 60 }).ttlSeconds).toBe(60);
    for (const ttlSeconds of [0, -1, 1.5, '60', null, 31536001]) {
      expect(status(() => parse({ url: 'https://example.com', ttlSeconds }))).toBe(400);
    }
  });
});
