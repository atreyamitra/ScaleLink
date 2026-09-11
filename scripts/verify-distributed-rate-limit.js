/**
 * Run this against your live Azure deployment to PROVE the rate limiter is
 * genuinely distributed: it fires requests from one simulated client IP and
 * shows (a) which backend instance answered each one (via X-Served-By,
 * confirming the load balancer is actually alternating between the two app
 * VMs) and (b) that the shared Redis-backed limit is enforced consistently
 * regardless of which instance handles a given request - the exact
 * property a naive per-instance in-memory rate limiter would NOT have.
 *
 * Usage: node scripts/verify-distributed-rate-limit.js http://<load_balancer_public_ip>
 */
const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error('Usage: node verify-distributed-rate-limit.js <base_url>');
  process.exit(1);
}

const EXPECTED_LIMIT = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 20);

async function main() {
  console.log(`Firing 25 requests from this source IP against ${baseUrl}\n`);

  const results = [];
  for (let i = 0; i < 25; i++) {
    const res = await fetch(`${baseUrl}/api/shorten`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: `https://example.com/verify/${i}` }),
    });
    const servedBy = res.headers.get('x-served-by');
    const remaining = res.headers.get('x-ratelimit-remaining');
    results.push({ i, status: res.status, servedBy, remaining });
    console.log(
      `req ${String(i).padStart(2)}: status=${res.status}  served_by=${servedBy}  remaining=${remaining}`
    );
  }

  const instancesSeen = new Set(results.map((r) => r.servedBy));
  const allowed = results.filter((r) => r.status === 201).length;
  const blocked = results.filter((r) => r.status === 429).length;

  console.log('\n=== Summary ===');
  console.log(`Distinct backend instances that answered: ${[...instancesSeen].join(', ')}`);
  console.log(`Allowed: ${allowed}, Blocked (429): ${blocked}`);
  const valid = !instancesSeen.has(null) && instancesSeen.size > 1 &&
    allowed === EXPECTED_LIMIT && blocked === 25 - EXPECTED_LIMIT;
  if (!valid) throw new Error('Distributed verification failed: require two instances and the exact configured limit (fresh window, limit < 25)');
  console.log('PASS: two instances shared the exact configured limit.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
