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

// Keep-alive ordering: the proxy in front must close idle connections BEFORE
// this server does. Node's default keepAliveTimeout is 5s while nginx keeps idle
// upstream connections for much longer, so nginx can reuse a connection at the
// instant Node closes it, which surfaces as a rare 502 ("recv() failed (104:
// Connection reset by peer) while reading response header from upstream").
// Observed under load (see BENCHMARK.md). nginx/nginx.conf sets its upstream
// keepalive_timeout to 55s; keep this larger. headersTimeout must exceed it.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

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
