'use strict';

function notFound(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
}

/**
 * Maps errors to responses without leaking internals:
 *  - HttpError (ours)            -> its status/message/headers
 *  - body-parser malformed JSON  -> 400 (parser text is not echoed)
 *  - body-parser oversize body   -> 413
 *  - anything else               -> 500 "Internal server error"
 * Only 5xx are logged as errors; client mistakes are not log noise.
 */
function createErrorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);

    let status = 500;
    let message = 'Internal server error';

    if (err.name === 'HttpError' || err.name === 'StorageUnavailableError') {
      status = err.status;
      message = err.message;
      for (const [name, value] of Object.entries(err.headers || {})) res.set(name, value);
    } else if (err.type === 'entity.parse.failed') {
      status = 400;
      message = 'Malformed JSON body';
    } else if (err.type === 'entity.too.large') {
      status = 413;
      message = 'Request body too large';
    }

    if (status >= 500) {
      logger.error({ err: err.cause?.message ?? err.message, stack: err.stack, path: req.path }, 'request failed');
    }
    return res.status(status).json({ error: message });
  };
}

module.exports = { notFound, createErrorHandler };
