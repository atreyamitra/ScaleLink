'use strict';

const { parseShortenRequest } = require('../links/validate');

// Codes are nanoid output ([A-Za-z0-9_-]). Anything else cannot exist, so we
// answer 404 without touching Redis (favicon.ico, scanners, 10kb paths...).
const CODE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

function createLinkController({ store, config, generateCode }) {
  const notFound = (res) => res.status(404).json({ error: 'Short link not found' });

  async function shorten(req, res) {
    const { url, ttlSeconds } = parseShortenRequest(req, config.links);
    const effectiveTtl = ttlSeconds ?? config.links.defaultTtlSeconds;

    const code = await store.reserve({ url, ttlSeconds: effectiveTtl, generateCode });

    res.status(201).json({
      code,
      shortUrl: `${config.baseUrl}/${code}`,
      originalUrl: url,
      ttlSeconds: effectiveTtl,
      servedBy: config.instanceId,
    });
  }

  async function redirect(req, res) {
    const { code } = req.params;
    if (!CODE_PATTERN.test(code)) return notFound(res);

    // HEAD (link previews, uptime probes) resolves but is not a click.
    const url = await store.resolve(code, { countClick: req.method !== 'HEAD' });
    if (!url) return notFound(res);

    // 302, not 301: a permanent redirect would be cached by browsers and
    // intermediaries, so repeat visits would never reach us to be counted.
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, url);
  }

  async function stats(req, res) {
    const { code } = req.params;
    if (!CODE_PATTERN.test(code)) return notFound(res);

    const result = await store.stats(code);
    if (!result) return notFound(res);

    return res.json({
      code,
      originalUrl: result.url,
      clicks: result.clicks,
      servedBy: config.instanceId,
    });
  }

  return { shorten, redirect, stats };
}

module.exports = { createLinkController, CODE_PATTERN };
