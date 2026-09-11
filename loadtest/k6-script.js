import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// Usage:
//   k6 run -e BASE_URL=http://<load_balancer_public_ip> loadtest/k6-script.js
//
// Run this AFTER `terraform apply` finishes and the app VMs have had a
// couple of minutes to finish their cloud-init bootstrap (installing
// Docker, cloning the repo, building the image). Hit /health a few times
// manually first to confirm both instances are actually up.

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
// Free Cloudflare quick tunnels are explicitly not built for sustained high
// concurrency (Cloudflare's own docs: "no uptime guarantee... not intended
// for production"). Peak throughput is configurable so you can test at a
// level the tunnel handles cleanly: -e PEAK_RPS=150 for a conservative,
// trustworthy run; omit it for the default aggressive 1000 req/s ceiling
// (best reserved for testing against a real cloud deployment, not a free
// tunnel).
const PEAK_RPS = Number(__ENV.PEAK_RPS) || 1000;

const rateLimited = new Counter('rate_limited_responses');
const created = new Counter('created_responses');
const shortenLatency = new Trend('shorten_latency_ms');

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    // Ramps up gradually so you can see the throughput ceiling rather than
    // just slamming the service at max concurrency from second zero.
    ramping_throughput: {
      executor: 'ramping-arrival-rate',
      startRate: Math.min(50, PEAK_RPS),
      timeUnit: '1s',
      preAllocatedVUs: Math.min(200, PEAK_RPS * 2),
      maxVUs: Math.min(500, PEAK_RPS * 3),
      stages: [
        { target: Math.round(PEAK_RPS * 0.2), duration: '20s' },
        { target: Math.round(PEAK_RPS * 0.5), duration: '30s' },
        { target: PEAK_RPS, duration: '30s' },
        { target: PEAK_RPS, duration: '20s' }, // hold at peak to see steady-state p99
        { target: 0, duration: '10s' },
      ],
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(99)<500'], // fails the run if p99 exceeds this - tune per your results
  },
};

export default function () {
  const payload = JSON.stringify({ url: `https://example.com/loadtest/${__VU}/${__ITER}` });

  // VUs share the load generator's actual source IP. Do not spoof identity.
  // For isolated throughput tests, raise the deployed limiter threshold;
  // keep a separate run at the production limit to measure enforcement.
  const params = { headers: { 'Content-Type': 'application/json' },
    responseCallback: http.expectedStatuses(201, 429) };

  const res = http.post(`${BASE_URL}/api/shorten`, payload, params);

  shortenLatency.add(res.timings.duration);

  if (res.status === 201) {
    created.add(1);
  } else if (res.status === 429) {
    rateLimited.add(1);
  }

  check(res, {
    'status is 201 or 429': (r) => r.status === 201 || r.status === 429,
  });
}

export function handleSummary(data) {
  const p50 = data.metrics.http_req_duration.values['med'];
  const p95 = data.metrics.http_req_duration.values['p(95)'];
  const p99 = data.metrics.http_req_duration.values['p(99)'];
  const rps = data.metrics.http_reqs.values.rate;

  console.log('\n=== ScaleLink Load Test Summary ===');
  console.log(`Requests/sec (avg): ${rps.toFixed(1)}`);
  console.log(`Latency p50/p95/p99 (ms): ${p50.toFixed(1)} / ${p95.toFixed(1)} / ${p99.toFixed(1)}`);
  console.log(`Total requests: ${data.metrics.http_reqs.values.count}`);
  console.log(`Created: ${data.metrics.created_responses?.values.count || 0}`);
  console.log(`Rate limited: ${data.metrics.rate_limited_responses?.values.count || 0}`);
  console.log('Aggregate request throughput includes rejected requests; report created responses separately.');

  return {
    stdout: JSON.stringify(data, null, 2), // keep default JSON output too
  };
}
