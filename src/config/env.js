'use strict';

/**
 * Configuration is read from an env-like object that is passed in, never from
 * module-load-time globals, so tests can build several differently configured
 * app instances inside one process. Invalid values fail fast at startup
 * instead of silently falling back to a default (the previous
 * `Number(x) || default` turned a typo like RATE_LIMIT_MAX_REQUESTS=abc into
 * "20" without a word).
 */

function readInt(env, name, fallback, { min, max }) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^-?\d+$/.test(String(raw).trim())) {
    throw new Error(`${name} must be an integer (got "${raw}")`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max} (got ${value})`);
  }
  return value;
}

/**
 * TRUST_PROXY decides whose X-Forwarded-For we believe. It feeds Express's
 * `trust proxy`, which determines req.ip, which is the rate-limiter identity.
 *
 *   unset / "false" / "0"   -> trust nobody: req.ip is the TCP peer address.
 *   "1", "2", ...           -> trust that many hops: req.ip is the address
 *                              the nearest trusted proxy saw.
 *   "loopback,10.0.0.0/8"   -> trust these proxies (IP, CIDR, or Express's
 *                              named ranges loopback/linklocal/uniquelocal).
 *
 * "true" is rejected on purpose: it trusts every hop, so any client can send
 * `X-Forwarded-For: <anything>` and receive a fresh rate-limit bucket.
 */
function parseTrustProxy(raw) {
  if (raw === undefined || raw === null) return false;
  const value = String(raw).trim();
  if (value === '' || value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') {
    throw new Error(
      'TRUST_PROXY=true trusts every hop, so any client can forge X-Forwarded-For and bypass the ' +
        'rate limiter. Use a hop count (e.g. 1) or a comma-separated list of proxy IPs/CIDRs.'
    );
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return hops === 0 ? false : hops;
  }
  const list = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return list.length > 0 ? list : false;
}

const MAX_TTL_SECONDS = 365 * 24 * 60 * 60;

function loadConfig(env = process.env) {
  const port = readInt(env, 'PORT', 8080, { min: 1, max: 65535 });
  const nodeEnv = env.NODE_ENV || 'development';

  return Object.freeze({
    port,
    nodeEnv,
    redisUrl: env.REDIS_URL || 'redis://localhost:6379',
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    // Identifies which instance answered (X-Served-By), so multi-instance
    // behaviour is observable from the outside.
    instanceId: env.INSTANCE_ID || 'local-dev',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    logLevel: env.LOG_LEVEL || (nodeEnv === 'test' ? 'silent' : 'info'),

    // Sliding-window log: at most `maxRequests` accepted per `windowSeconds`, per client IP.
    rateLimit: Object.freeze({
      windowSeconds: readInt(env, 'RATE_LIMIT_WINDOW_SECONDS', 10, { min: 1, max: 86400 }),
      maxRequests: readInt(env, 'RATE_LIMIT_MAX_REQUESTS', 20, { min: 1, max: 1_000_000_000 }),
    }),

    // Every Redis command is bounded by commandTimeoutMs, so a stalled Redis
    // surfaces as a fast 503 instead of a hung request.
    redis: Object.freeze({
      commandTimeoutMs: readInt(env, 'REDIS_COMMAND_TIMEOUT_MS', 1000, { min: 10, max: 60000 }),
      connectTimeoutMs: readInt(env, 'REDIS_CONNECT_TIMEOUT_MS', 2000, { min: 10, max: 60000 }),
    }),

    links: Object.freeze({
      codeLength: readInt(env, 'CODE_LENGTH', 7, { min: 1, max: 32 }),
      maxCodeAttempts: 5,
      maxUrlLength: 2048,
      maxTtlSeconds: MAX_TTL_SECONDS,
      // null = links never expire unless the caller sends ttlSeconds.
      defaultTtlSeconds: readInt(env, 'LINK_DEFAULT_TTL_SECONDS', 0, { min: 0, max: MAX_TTL_SECONDS }) || null,
    }),
  });
}

module.exports = { loadConfig, parseTrustProxy, MAX_TTL_SECONDS };
