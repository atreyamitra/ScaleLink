'use strict';

const express = require('express');

/**
 * Order on POST /api/shorten matters: the rate limiter runs BEFORE the body
 * parser, so every attempt is metered, including malformed, oversized, or
 * invalid ones. (With the parser first, a client could send unlimited garbage
 * bodies for free.)
 */
function createRouters({ controller, rateLimiter, bodyLimit }) {
  const apiRouter = express.Router();
  apiRouter.post('/shorten', rateLimiter, express.json({ limit: bodyLimit }), controller.shorten);

  // Mounted at the root so the shortUrl returned by /api/shorten works as-is.
  // `/:code/stats` must be registered before `/:code`.
  const redirectRouter = express.Router();
  redirectRouter.get('/:code/stats', controller.stats);
  redirectRouter.get('/:code', controller.redirect);

  return { apiRouter, redirectRouter };
}

module.exports = { createRouters };
