'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const { nanoid } = require('nanoid');

const { LinkStore } = require('./links/linkStore');
const { SlidingWindowLimiter } = require('./limiter/slidingWindowLimiter');
const { distributedRateLimiter } = require('./middleware/distributedRateLimiter');
const { createLinkController } = require('./controllers/linkController');
const { createRouters } = require('./routes/linkRoutes');
const { notFound, createErrorHandler } = require('./middleware/errorHandler');

/**
 * Builds one app instance from explicit dependencies, so tests can run several
 * differently configured instances (each with its own Redis connection) in one
 * process, and inject a deterministic code generator to force collisions.
 *
 * @param {object} deps
 * @param {object} deps.config     result of loadConfig()
 * @param {object} deps.redis      an ioredis client
 * @param {object} deps.logger     a pino logger
 * @param {() => string} [deps.generateCode]
 */
function createApp({ config, redis, logger, generateCode }) {
  const codeGenerator = generateCode || (() => nanoid(config.links.codeLength));

  const store = new LinkStore(redis, { maxCodeAttempts: config.links.maxCodeAttempts });
  const limiter = new SlidingWindowLimiter(redis, {
    windowMs: config.rateLimit.windowSeconds * 1000,
    limit: config.rateLimit.maxRequests,
  });
  const controller = createLinkController({ store, config, generateCode: codeGenerator });
  const { apiRouter, redirectRouter } = createRouters({
    controller,
    rateLimiter: distributedRateLimiter({ limiter, instanceId: config.instanceId, logger }),
    bodyLimit: '4kb',
  });

  const app = express();

  // Whose X-Forwarded-For we believe. Default: nobody, so req.ip is the TCP
  // peer and a client cannot choose its own rate-limit bucket. See
  // parseTrustProxy() in config/env.js and docs/ARCHITECTURE.md.
  app.set('trust proxy', config.trustProxy);

  app.use(helmet());
  app.use(cors());
  if (config.logLevel !== 'silent') {
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' } }));
  }

  // Liveness: the process is up and serving HTTP. Deliberately independent of
  // Redis, so a Redis outage does not make an orchestrator restart healthy app
  // containers.
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', instance: config.instanceId, env: config.nodeEnv });
  });

  // Readiness: this instance can reach Redis right now. Used for startup
  // ordering (compose `depends_on: service_healthy`) and load-balancer checks.
  app.get('/ready', async (req, res) => {
    if (await store.ping()) {
      return res.json({ status: 'ready', instance: config.instanceId });
    }
    return res.status(503).json({ status: 'redis unavailable', instance: config.instanceId });
  });

  app.use('/api', apiRouter);
  app.use('/', redirectRouter);

  app.use(notFound);
  app.use(createErrorHandler(logger));

  return app;
}

module.exports = createApp;
