'use strict';

const { StorageUnavailableError } = require('../errors');

/** `::ffff:1.2.3.4` and `1.2.3.4` are the same client; don't give them two buckets. */
function normalizeClientIp(ip) {
  if (!ip) return 'unknown';
  return ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice('::ffff:'.length) : ip;
}

/**
 * Express middleware around a SlidingWindowLimiter.
 *
 * Identity is req.ip. What req.ip means is decided entirely by the app's
 * `trust proxy` setting (config.trustProxy, default: trust nobody), never by
 * this middleware reading headers itself.
 *
 * Failure policy: FAIL CLOSED. If the limiter's Redis call fails we answer 503
 * and the request does not proceed. Rationale: the protected handler needs the
 * same Redis, so failing open would not keep the endpoint working, it would
 * only remove protection for the moment Redis comes back; and a limiter that
 * silently disables itself on error hides bugs. See docs/ARCHITECTURE.md.
 */
function distributedRateLimiter({ limiter, instanceId, logger }) {
  return async function rateLimitMiddleware(req, res, next) {
    let result;
    try {
      result = await limiter.check(normalizeClientIp(req.ip));
    } catch (err) {
      logger.error({ err: err.message }, 'rate limiter backend failure; failing closed');
      return next(new StorageUnavailableError(err));
    }

    res.set('X-RateLimit-Limit', String(result.limit));
    res.set('X-RateLimit-Remaining', String(result.remaining));
    res.set('X-Served-By', instanceId);

    if (!result.allowed) {
      // Time until the oldest counted request ages out of the window, i.e.
      // the earliest moment a retry can be admitted.
      const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: 'Too many requests',
        limit: result.limit,
        retryAfterSeconds,
        servedBy: instanceId,
      });
    }

    return next();
  };
}

module.exports = { distributedRateLimiter, normalizeClientIp };
