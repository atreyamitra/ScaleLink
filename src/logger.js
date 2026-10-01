'use strict';

const pino = require('pino');

function createLogger(config) {
  return pino({ level: config.logLevel, base: { instance: config.instanceId } });
}

module.exports = { createLogger };
