'use strict';

const Redis = require('ioredis');

/**
 * One ioredis client per app instance. The options encode the failure policy
 * (see docs/ARCHITECTURE.md, "Failure semantics"):
 *
 *  - commandTimeout: every command is bounded, so a stalled Redis becomes a
 *    fast error (-> 503) instead of a hung request.
 *  - enableOfflineQueue=false: while the connection is down, commands are
 *    rejected immediately rather than queued. A Redis outage sheds load at
 *    once instead of piling up pending requests.
 *  - autoResendUnfulfilledCommands=false: if the connection drops while a
 *    command is in flight we do NOT silently re-send it after reconnecting.
 *    The command may or may not have executed; re-sending a write could apply
 *    it twice (e.g. a second click, or a second link). The caller gets an
 *    error and decides whether to retry.
 *  - the reconnect strategy is ioredis's default capped exponential backoff
 *    (50ms * attempts, max 2s), so the instance heals by itself.
 */
function createRedisClient(config, logger, extraOptions = {}) {
  const client = new Redis(config.redisUrl, {
    connectTimeout: config.redis.connectTimeoutMs,
    commandTimeout: config.redis.commandTimeoutMs,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    maxRetriesPerRequest: null,
    ...extraOptions,
  });

  // Reconnect attempts fail with the same error every ~second; log each
  // distinct failure once, and log recovery.
  let lastError;
  client.on('error', (err) => {
    if (err.message !== lastError) {
      lastError = err.message;
      logger.warn({ err: err.message }, 'redis error');
    }
  });
  client.on('ready', () => {
    lastError = undefined;
    logger.info('redis ready');
  });
  client.on('close', () => logger.warn('redis connection closed'));

  return client;
}

async function closeRedisClient(client) {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

module.exports = { createRedisClient, closeRedisClient };
