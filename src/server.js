'use strict';

require('dotenv').config({ quiet: true });

const createApp = require('./app');
const { loadConfig } = require('./config/env');
const { createRedisClient, closeRedisClient } = require('./config/redis');
const { createLogger } = require('./logger');

const config = loadConfig();
const logger = createLogger(config);
const redis = createRedisClient(config, logger);
const app = createApp({ config, redis, logger });

const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, env: config.nodeEnv, trustProxy: config.trustProxy, rateLimit: config.rateLimit },
    'scalelink listening'
  );
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  // Never hang on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();

  server.close(async () => {
    await closeRedisClient(redis);
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'unhandled rejection; exiting');
  process.exit(1);
});
