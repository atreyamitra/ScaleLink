const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const pino = require('pino');

const env = require('./config/env');
const { apiRouter, redirectRouter } = require('./routes/linkRoutes');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const logger = pino({ level: env.nodeEnv === 'test' ? 'silent' : 'info' });

function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '10kb' }));

  // Direct clients cannot choose their limiter identity via forwarded headers.
  // Only explicitly configured reverse proxies may supply client addresses.
  app.set('trust proxy', env.trustProxy);
  if (env.nodeEnv !== 'test') {
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));
  }

  // Health check also reports which instance answered - useful during the
  // load test to visually confirm the load balancer is actually spreading
  // traffic across both app VMs, not just hammering one.
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', instance: env.instanceId, env: env.nodeEnv });
  });

  app.use('/api', apiRouter);
  // Root-level redirect matches the shortUrl format returned by /api/shorten
  app.use('/', redirectRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
