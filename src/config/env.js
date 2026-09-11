require('dotenv').config();

module.exports = {
  trustProxy: process.env.TRUST_PROXY
    ? process.env.TRUST_PROXY.split(',').map(value => value.trim()).filter(Boolean)
    : false,
  port: Number(process.env.PORT) || 8080,
  nodeEnv: process.env.NODE_ENV || 'development',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  baseUrl: process.env.BASE_URL || 'http://localhost:8080',

  // Sliding-window rate limiter: N requests per window, per IP.
  rateLimit: {
    windowSeconds: Number(process.env.RATE_LIMIT_WINDOW_SECONDS) || 10,
    maxRequests: Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 20,
  },

  // Identifies which app instance served a request — set per-VM in Terraform
  // (e.g. "app-1", "app-2") so load test results can show the LB actually
  // spreading traffic, and so the rate limiter's cross-instance consistency
  // can be directly observed.
  instanceId: process.env.INSTANCE_ID || 'local-dev',
};
