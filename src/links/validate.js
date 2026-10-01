'use strict';

const { HttpError } = require('../errors');

const ALLOWED_FIELDS = new Set(['url', 'ttlSeconds']);

function badRequest(message) {
  return new HttpError(400, message);
}

/**
 * Validate and normalise the body of POST /api/shorten.
 *
 * Returns { url, ttlSeconds }. `url` is the WHATWG-normalised href, so
 * what is stored (and later redirected to) is exactly what we parsed, with no
 * stray whitespace/control characters.
 *
 * Rejected: non-JSON content type, non-object bodies, unknown fields,
 * non-http(s) schemes (javascript:, data:, file:...), over-long URLs, URLs
 * with embedded credentials (https://trusted.com@evil.example/ is a classic
 * phishing disguise), and out-of-range TTLs.
 */
function parseShortenRequest(req, { maxUrlLength, maxTtlSeconds }) {
  // express.json() leaves req.body undefined for any other content type.
  if (!req.is('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  const body = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }

  const unknown = Object.keys(body).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length > 0) {
    throw badRequest(`Unknown field(s): ${unknown.join(', ')}`);
  }

  const { url, ttlSeconds } = body;
  if (typeof url !== 'string' || url.length === 0) {
    throw badRequest('"url" is required and must be a string');
  }
  if (url.length > maxUrlLength) {
    throw badRequest(`"url" must be at most ${maxUrlLength} characters`);
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest('"url" must be a valid absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('"url" must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw badRequest('"url" must not contain embedded credentials');
  }

  let ttl = null;
  if (ttlSeconds !== undefined) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > maxTtlSeconds) {
      throw badRequest(`"ttlSeconds" must be an integer between 1 and ${maxTtlSeconds}`);
    }
    ttl = ttlSeconds;
  }

  return { url: parsed.href, ttlSeconds: ttl };
}

module.exports = { parseShortenRequest };
