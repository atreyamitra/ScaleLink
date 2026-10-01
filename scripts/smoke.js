#!/usr/bin/env node
'use strict';

/**
 * End-to-end smoke test against a RUNNING deployment (docker compose, a tunnel,
 * a VM...). Exits non-zero if any check fails.
 *
 *   node scripts/smoke.js http://localhost:8080
 *
 * Checks (each prints PASS/FAIL):
 *   1. both app instances answer through the load balancer
 *   2. a link created via one request redirects, and clicks are counted
 *   3. the shared rate limit is exact: across ALL instances, a single client is
 *      admitted exactly `limit` times, even while forging a different
 *      X-Forwarded-For on every request
 *
 * Assumes the default per-client limit window is long enough (>= ~5s) that the
 * script finishes inside one window, and that this script is the only client
 * sharing its IP with the limiter during the run.
 */
const baseUrl = (process.argv[2] || 'http://localhost:8080').replace(/\/+$/, '');
const EXTRA_REQUESTS = 40; // sent beyond the limit, concurrently, with forged headers

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

async function post(body, headers = {}) {
  const res = await fetch(`${baseUrl}/api/shorten`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => ({})) };
}

async function main() {
  console.log(`Smoke testing ${baseUrl}\n`);

  // 1. Both instances take traffic.
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) {
    const res = await fetch(`${baseUrl}/health`);
    seen.add((await res.json()).instance);
  }
  check('both app instances answered via the load balancer', seen.size >= 2, `instances seen: ${[...seen].join(', ')}`);

  // 2. Create, redirect (alternating instances), count.
  let accepted = 0;
  const created = await post({ url: 'https://example.com/smoke' });
  if (created.status === 201) accepted += 1;
  check('create returns 201', created.status === 201, `status ${created.status}`);
  const limit = Number(created.headers.get('x-ratelimit-limit'));
  check('rate-limit headers present', Number.isInteger(limit) && limit > 0, `limit ${limit}`);

  const code = created.json.code;
  let redirectsOk = 0;
  for (let i = 0; i < 4; i += 1) {
    const res = await fetch(`${baseUrl}/${code}`, { redirect: 'manual' });
    if (res.status === 302 && res.headers.get('location') === 'https://example.com/smoke') redirectsOk += 1;
  }
  check('link redirects (302) to the original URL', redirectsOk === 4, `${redirectsOk}/4`);
  const stats = await (await fetch(`${baseUrl}/${code}/stats`)).json();
  check('clicks counted exactly', stats.clicks === 4, `clicks ${stats.clicks}`);

  // 3. Shared limit is exact across instances, even with forged X-Forwarded-For.
  const burst = await Promise.all(
    Array.from({ length: limit + EXTRA_REQUESTS }, (_, i) =>
      post({ url: `https://example.com/burst/${i}` }, { 'X-Forwarded-For': `203.0.113.${(i % 250) + 1}` })
    )
  );
  accepted += burst.filter((r) => r.status === 201).length;
  const limited = burst.filter((r) => r.status === 429).length;
  const servers = new Set(burst.map((r) => r.headers.get('x-served-by')));
  check(
    `single client admitted exactly ${limit} times in total (forged X-Forwarded-For ignored)`,
    accepted === limit,
    `accepted ${accepted}, rejected ${limited}`
  );
  check('both instances took part in the burst', servers.size >= 2, `served by: ${[...servers].join(', ')}`);

  console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures} check(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
