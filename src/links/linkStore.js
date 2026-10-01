'use strict';

const { HttpError, guardStorage } = require('../errors');

/**
 * Redis layout (the braces are Redis Cluster hash tags: both keys of one link
 * hash to the same slot, which the two-key script below needs):
 *
 *   link:{<code>}          string  original URL        (optional TTL)
 *   link:{<code>}:clicks   string  integer counter     (TTL tracks the link's)
 */
const linkKey = (code) => `link:{${code}}`;
const clicksKey = (code) => `link:{${code}}:clicks`;

/**
 * Resolve a link and count the click as ONE atomic step.
 *
 * Doing GET then a separate fire-and-forget INCR (the previous design) had two
 * flaws: a click could be recorded for a link that had just expired (leaving an
 * orphan counter with no TTL), and the counter was initialised by a separate
 * SET that could reset concurrent increments. Here the counter is only touched
 * if the link exists in the same atomic step, and it inherits the link's
 * remaining TTL so it disappears with it.
 */
const RESOLVE_AND_COUNT_SCRIPT = `
local url = redis.call('GET', KEYS[1])
if not url then return false end
redis.call('INCR', KEYS[2])
local ttl_ms = redis.call('PTTL', KEYS[1])
if ttl_ms > 0 then redis.call('PEXPIRE', KEYS[2], ttl_ms) end
return url
`;

class LinkStore {
  constructor(redis, { maxCodeAttempts }) {
    this.redis = redis;
    this.maxCodeAttempts = maxCodeAttempts;
    redis.defineCommand('resolveAndCount', { numberOfKeys: 2, lua: RESOLVE_AND_COUNT_SCRIPT });
  }

  /**
   * Atomically claim a fresh code for `url`.
   *
   * `SET key url NX [EX ttl]` is a single Redis command: it either creates the
   * key with its value (and TTL) or does nothing and reports that the key
   * exists. There is no check-then-set gap, so two requests can never be handed
   * the same code, a live link can never be overwritten, and no reader can see
   * a reserved-but-empty mapping. A collision (reply null) just means "try
   * another random code"; the number of attempts is bounded.
   *
   * Storage errors are NOT retried: after a timeout the SET may or may not
   * have been applied, and retrying could create a second mapping. The client
   * gets a 503 and decides. (Worst case: one unreferenced, harmless mapping.)
   */
  async reserve({ url, ttlSeconds, generateCode }) {
    for (let attempt = 1; attempt <= this.maxCodeAttempts; attempt += 1) {
      const code = generateCode();
      const args = [linkKey(code), url, 'NX'];
      if (ttlSeconds) args.push('EX', ttlSeconds);
      const reply = await guardStorage(() => this.redis.set(...args));
      if (reply === 'OK') return code;
    }
    throw new HttpError(503, 'Could not allocate a unique short code; please retry', {
      headers: { 'Retry-After': '1' },
    });
  }

  /** @returns {Promise<string|null>} the original URL, or null if absent/expired. */
  async resolve(code, { countClick }) {
    return guardStorage(() =>
      countClick
        ? this.redis.resolveAndCount(linkKey(code), clicksKey(code))
        : this.redis.get(linkKey(code))
    );
  }

  /** MGET is one atomic command, so url and clicks are a consistent pair. */
  async stats(code) {
    const [url, clicks] = await guardStorage(() => this.redis.mget(linkKey(code), clicksKey(code)));
    if (!url) return null;
    return { url, clicks: Number(clicks || 0) };
  }

  async ping() {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { LinkStore, linkKey, clicksKey, RESOLVE_AND_COUNT_SCRIPT };
