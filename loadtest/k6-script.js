// k6 load test for ScaleLink. Drive it with scripts/bench.sh (see BENCHMARK.md).
//
// Open-model load: `constant-arrival-rate` fixes how many requests per second
// are *offered*, regardless of how fast the system answers. That is what lets
// us see saturation: when the system cannot keep up, k6 reports
// `dropped_iterations` and latency climbs, instead of the load quietly
// slowing down to match the server (closed-model "N virtual users" tests).
//
// Each run = a warm-up phase (unmeasured) then a measured phase at the same
// rate. Only the `phase:measure` metrics go into the summary.
//
// SCENARIO:
//   shorten   POST /api/shorten  (rate limiter + SET NX). Needs a huge limit
//             so the single client IP is never throttled: this measures the
//             limiter *path*, not rejections.
//   redirect  GET /:code         (Lua resolve+count). Not rate limited.
//   limited   POST /api/shorten with a small limit: asserts the limiter holds
//             under load. Hard invariant: any window of `WINDOW_S` seconds
//             admits at most LIMIT, so a run of D seconds admits at most
//             ceil(D / WINDOW_S) * LIMIT.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const SCENARIO = __ENV.SCENARIO || 'shorten';
const RATE = Number(__ENV.RATE || 200);
const DURATION_S = Number(__ENV.DURATION_S || 20);
const WARMUP_S = SCENARIO === 'limited' ? 0 : Number(__ENV.WARMUP_S || 5);
const LIMIT = Number(__ENV.LIMIT || 100); // `limited` only: must match the server's RATE_LIMIT_MAX_REQUESTS
const WINDOW_S = Number(__ENV.WINDOW_S || 10); // ... and RATE_LIMIT_WINDOW_SECONDS
const RESULTS_DIR = __ENV.RESULTS_DIR || '.';
const CODE_POOL = 50;

const created = new Counter('created_201');
const limited = new Counter('limited_429');
const redirected = new Counter('redirected_302');
const unexpected = new Counter('unexpected_status');
// Breakdown of unexpected responses, to tell load-generator/proxy trouble
// (status 0, 502, 504) apart from the application answering 503.
const unexpectedBy = {
  0: new Counter('unexpected_status_0_no_response'),
  502: new Counter('unexpected_status_502'),
  503: new Counter('unexpected_status_503'),
  504: new Counter('unexpected_status_504'),
  other: new Counter('unexpected_status_other'),
};
function countUnexpected(res) {
  unexpected.add(1);
  (unexpectedBy[res.status] || unexpectedBy.other).add(1);
}

function phase(name, startTime, duration) {
  return {
    executor: 'constant-arrival-rate',
    rate: RATE,
    timeUnit: '1s',
    duration: `${duration}s`,
    startTime: `${startTime}s`,
    preAllocatedVUs: Math.min(1000, Math.max(20, Math.ceil(RATE / 5))),
    maxVUs: Math.min(3000, Math.max(100, RATE * 2)),
    exec: SCENARIO === 'redirect' ? 'redirectOnce' : 'shortenOnce',
    tags: { phase: name },
  };
}

const scenarios = { measure: phase('measure', WARMUP_S, DURATION_S) };
if (WARMUP_S > 0) scenarios.warmup = phase('warmup', 0, WARMUP_S);

const thresholds = {
  // Referencing the tagged sub-metrics makes k6 compute them for the summary.
  'http_req_duration{phase:measure}': ['max>=0'],
  'http_reqs{phase:measure}': ['count>=0'],
  'http_req_failed{phase:measure}': ['rate>=0'],
  'dropped_iterations{phase:measure}': ['count>=0'],
  'created_201{phase:measure}': ['count>=0'],
  'limited_429{phase:measure}': ['count>=0'],
  'redirected_302{phase:measure}': ['count>=0'],
  'unexpected_status{phase:measure}': ['count>=0'],
  'unexpected_status_0_no_response{phase:measure}': ['count>=0'],
  'unexpected_status_502{phase:measure}': ['count>=0'],
  'unexpected_status_503{phase:measure}': ['count>=0'],
  'unexpected_status_504{phase:measure}': ['count>=0'],
  'unexpected_status_other{phase:measure}': ['count>=0'],
};
if (SCENARIO === 'limited') {
  // The invariant under test (see header). Fails the run if the limiter over-admits.
  thresholds['created_201{phase:measure}'] = [`count<=${Math.ceil(DURATION_S / WINDOW_S) * LIMIT}`];
}

export const options = {
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios,
  thresholds,
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function setup() {
  if (SCENARIO !== 'redirect') return {};
  const codes = [];
  for (let i = 0; i < CODE_POOL; i += 1) {
    const res = http.post(`${BASE_URL}/api/shorten`, JSON.stringify({ url: `https://example.com/bench/${i}` }), { headers: JSON_HEADERS });
    if (res.status !== 201) throw new Error(`setup: could not create link ${i} (status ${res.status}); is RATE_LIMIT_MAX_REQUESTS high enough?`);
    codes.push(res.json('code'));
  }
  return { codes };
}

export function shortenOnce() {
  // Unique URL per iteration so every request really performs a SET NX.
  const body = JSON.stringify({ url: `https://example.com/bench/${__VU}/${__ITER}` });
  const expected = SCENARIO === 'limited' ? [201, 429] : [201];
  const res = http.post(`${BASE_URL}/api/shorten`, body, {
    headers: JSON_HEADERS,
    responseCallback: http.expectedStatuses(...expected),
  });
  if (res.status === 201) created.add(1);
  else if (res.status === 429) limited.add(1);
  else countUnexpected(res);
  check(res, { 'expected status': (r) => expected.includes(r.status) });
}

export function redirectOnce(data) {
  const code = data.codes[__ITER % data.codes.length];
  const res = http.get(`${BASE_URL}/${code}`, { redirects: 0, responseCallback: http.expectedStatuses(302) });
  if (res.status === 302) redirected.add(1);
  else countUnexpected(res);
  check(res, { 'is 302': (r) => r.status === 302 });
}

function metric(data, name, field) {
  const m = data.metrics[name];
  return m && m.values ? m.values[field] : undefined;
}

export function handleSummary(data) {
  const t = (field) => metric(data, 'http_req_duration{phase:measure}', field);
  const requests = metric(data, 'http_reqs{phase:measure}', 'count');
  const summary = {
    scenario: SCENARIO,
    offered_rate_per_s: RATE,
    measured_seconds: DURATION_S,
    warmup_seconds: WARMUP_S,
    requests,
    achieved_rate_per_s: requests === undefined ? undefined : requests / DURATION_S,
    dropped_iterations: metric(data, 'dropped_iterations{phase:measure}', 'count') || 0,
    failed_rate: metric(data, 'http_req_failed{phase:measure}', 'rate'),
    status: {
      created_201: metric(data, 'created_201{phase:measure}', 'count') || 0,
      limited_429: metric(data, 'limited_429{phase:measure}', 'count') || 0,
      redirected_302: metric(data, 'redirected_302{phase:measure}', 'count') || 0,
      unexpected: metric(data, 'unexpected_status{phase:measure}', 'count') || 0,
      unexpected_breakdown: {
        no_response_status_0: metric(data, 'unexpected_status_0_no_response{phase:measure}', 'count') || 0,
        status_502: metric(data, 'unexpected_status_502{phase:measure}', 'count') || 0,
        status_503: metric(data, 'unexpected_status_503{phase:measure}', 'count') || 0,
        status_504: metric(data, 'unexpected_status_504{phase:measure}', 'count') || 0,
        other: metric(data, 'unexpected_status_other{phase:measure}', 'count') || 0,
      },
    },
    latency_ms: { avg: t('avg'), p50: t('med'), p90: t('p(90)'), p95: t('p(95)'), p99: t('p(99)'), max: t('max') },
    limited_invariant:
      SCENARIO === 'limited'
        ? { limit: LIMIT, window_s: WINDOW_S, max_admissible: Math.ceil(DURATION_S / WINDOW_S) * LIMIT }
        : undefined,
  };

  const f = (n) => (n === undefined ? 'n/a' : n.toFixed(1));
  const text =
    `\n=== ScaleLink k6 (${SCENARIO}) offered ${RATE}/s for ${DURATION_S}s (after ${WARMUP_S}s warm-up) ===\n` +
    `requests: ${requests}   achieved: ${f(summary.achieved_rate_per_s)}/s   dropped iterations: ${summary.dropped_iterations}\n` +
    `status: 201=${summary.status.created_201} 429=${summary.status.limited_429} 302=${summary.status.redirected_302} unexpected=${summary.status.unexpected} ${JSON.stringify(summary.status.unexpected_breakdown)}\n` +
    `latency ms: p50=${f(t('med'))} p95=${f(t('p(95)'))} p99=${f(t('p(99)'))} max=${f(t('max'))}\n`;

  return {
    stdout: text,
    [`${RESULTS_DIR}/${SCENARIO}-${RATE}.json`]: JSON.stringify(summary, null, 2),
  };
}
