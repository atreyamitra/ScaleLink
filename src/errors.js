'use strict';

/** An error whose status and message are safe to show to the client. */
class HttpError extends Error {
  constructor(status, message, { headers = {}, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'HttpError';
    this.status = status;
    this.headers = headers;
  }
}

/**
 * Redis (the only datastore) failed, timed out, or is unreachable. Always a
 * 503: the request was not served because a dependency is unavailable, which
 * is different from "link not found" (404) or "you are over the limit" (429).
 * The underlying error is kept as `cause` for logs but never sent to clients.
 */
class StorageUnavailableError extends HttpError {
  constructor(cause) {
    super(503, 'Storage backend unavailable; please retry', {
      headers: { 'Retry-After': '1' },
      cause,
    });
    this.name = 'StorageUnavailableError';
  }
}

/** Run a Redis call; any failure becomes a StorageUnavailableError. */
async function guardStorage(fn) {
  try {
    return await fn();
  } catch (err) {
    throw new StorageUnavailableError(err);
  }
}

module.exports = { HttpError, StorageUnavailableError, guardStorage };
