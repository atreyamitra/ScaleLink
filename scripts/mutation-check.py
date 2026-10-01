#!/usr/bin/env python3
"""Mutation check: prove the test suite can actually fail.

Applies ONE deliberate bug at a time to the source, runs the full suite, records
which tests fail, and reverts the file with `git checkout`. A mutation that no
test catches would mean a gap in the tests.

    python3 scripts/mutation-check.py            # all mutations (~15s each)
    python3 scripts/mutation-check.py M1 M5      # selected ones

Needs a real Redis (same as `npm test`) and a CLEAN working tree under src/
(so that `git checkout` restores exactly what was there). Not part of CI: it is
a manual audit tool. The last recorded results are in TESTING.md.
"""
import json, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(tempfile.gettempdir(), 'scalelink-mutation.json')

dirty = subprocess.run(['git', 'status', '--porcelain', 'src'], cwd=ROOT, capture_output=True, text=True).stdout.strip()
if dirty:
    sys.exit('Refusing to run: src/ has uncommitted changes (they would be lost on revert):\n' + dirty)

M = []
def mut(id_, desc, path, old, new):
    M.append(dict(id=id_, desc=desc, path=path, old=old, new=new))

LIM = 'src/limiter/slidingWindowLimiter.js'
STORE = 'src/links/linkStore.js'

mut('M1', 'remove NX from short-code reservation', STORE,
    "const args = [linkKey(code), url, 'NX'];", "const args = [linkKey(code), url];")

mut('M2', 'make the rate-limit decision non-atomic (JS read-then-write instead of Lua)', LIM,
    """    const [allowed, remaining, retryAfterMs] = await this.redis.slidingWindowCheck(
      limiterKey(identity),
      this.windowMs,
      this.limit
    );
    return { allowed: allowed === 1, remaining, retryAfterMs, limit: this.limit };""",
    """    const key = limiterKey(identity);
    const [sec, micro] = await this.redis.time();
    const now = Number(sec) * 1000 + Math.floor(Number(micro) / 1000);
    await this.redis.zremrangebyscore(key, '-inf', now - this.windowMs);
    const count = await this.redis.zcard(key);
    if (count >= this.limit) return { allowed: false, remaining: 0, retryAfterMs: 1, limit: this.limit };
    await this.redis.zadd(key, now, `${now}-${Math.random()}`);
    await this.redis.pexpire(key, this.windowMs);
    return { allowed: true, remaining: this.limit - count - 1, retryAfterMs: 0, limit: this.limit };""")

mut('M3', 'remove unique request member (member = timestamp only)', LIM,
    "string.format('%d-%d', now, same_ms)", "string.format('%d', now)")

mut('M4', 'disable cleanup of expired entries (no ZREMRANGEBYSCORE)', LIM,
    "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window_ms)", "-- cleanup removed")

mut('M5', 'trust arbitrary forwarded IP headers (trust proxy: true)', 'src/app.js',
    "app.set('trust proxy', config.trustProxy);", "app.set('trust proxy', true);")

mut('M6', "use the app instance's clock (Date.now) instead of Redis TIME", LIM,
    "local t = redis.call('TIME')\nlocal now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)",
    "local now = tonumber(ARGV[3])")
M[-1]['extra'] = (LIM, "      this.windowMs,\n      this.limit\n    );", "      this.windowMs,\n      this.limit,\n      Date.now()\n    );")

mut('M7', 'drop PEXPIRE on accept (no TTL on limiter keys)', LIM,
    "redis.call('PEXPIRE', KEYS[1], window_ms)\n", "")

mut('M8', 'let ioredis auto-resend in-flight commands after reconnect', 'src/config/redis.js',
    "autoResendUnfulfilledCommands: false,", "autoResendUnfulfilledCommands: true,")

mut('M9', 'limiter fails OPEN on backend error', 'src/middleware/distributedRateLimiter.js',
    "return next(new StorageUnavailableError(err));", "return next();")

mut('M10', 'INCR the click counter before checking the link exists (orphan counters)', STORE,
    "local url = redis.call('GET', KEYS[1])\nif not url then return false end\nredis.call('INCR', KEYS[2])",
    "local url = redis.call('GET', KEYS[1])\nredis.call('INCR', KEYS[2])\nif not url then return false end")

mut('M11', 'count HEAD requests as clicks', 'src/controllers/linkController.js',
    "{ countClick: req.method !== 'HEAD' }", "{ countClick: true }")

mut('M12', 'run body parser BEFORE the rate limiter', 'src/routes/linkRoutes.js',
    "apiRouter.post('/shorten', rateLimiter, express.json({ limit: bodyLimit }), controller.shorten);",
    "apiRouter.post('/shorten', express.json({ limit: bodyLimit }), rateLimiter, controller.shorten);")

mut('M13', "click counter does not inherit the link's TTL", STORE,
    "if ttl_ms > 0 then redis.call('PEXPIRE', KEYS[2], ttl_ms) end\n", "")

mut('M14', 'off-by-one at the limit (count > limit instead of >=)', LIM,
    "if count >= limit then", "if count > limit then")

mut('M15', 'collision loop never gives up and overwrites on the last attempt (SET without NX when exhausted)', STORE,
    "      if (reply === 'OK') return code;\n    }",
    "      if (reply === 'OK') return code;\n      if (attempt === this.maxCodeAttempts) { await this.redis.set(linkKey(code), url); return code; }\n    }")

mut('M16', 'redirect 404s become 500s on missing link (resolve throws)', 'src/controllers/linkController.js',
    "    if (!url) return notFound(res);\n\n    // 302", "    if (!url) throw new Error('boom');\n\n    // 302")

only = sys.argv[1:]
results = []
not_caught = []
for m in M:
    if only and m['id'] not in only:
        continue
    targets = [(m['path'], m['old'], m['new'])] + ([m['extra']] if 'extra' in m else [])
    touched = []
    try:
        for p, old, new in targets:
            full = os.path.join(ROOT, p)
            text = open(full).read()
            if text.count(old) != 1:
                sys.exit(f"{m['id']}: pattern not found exactly once in {p} (count={text.count(old)}); the source changed, update this mutation")
            touched.append(p)
            open(full, 'w').write(text.replace(old, new))
        subprocess.run(['npx', 'jest', '--json', f'--outputFile={OUT}'], cwd=ROOT, capture_output=True, text=True, timeout=300)
        data = json.load(open(OUT))
        failed = [a['fullName'] for t in data['testResults'] for a in t['assertionResults'] if a['status'] == 'failed']
        suite_errors = [t['name'].split('/')[-1] for t in data['testResults'] if t['status'] == 'failed' and not t['assertionResults']]
    finally:
        for p in touched:
            subprocess.run(['git', 'checkout', '--', p], cwd=ROOT, check=True)
    left = subprocess.run(['git', 'status', '--porcelain', 'src'], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    assert not left, f'src/ not restored after {m["id"]}: {left}'
    caught = bool(failed or suite_errors)
    if not caught:
        not_caught.append(m['id'])
    print(f"{m['id']:4} {'CAUGHT' if caught else '*** NOT CAUGHT ***':18} ({len(failed)} failing tests) {m['desc']}")
    for name in failed[:4]:
        print(f"        - {name}")
    if len(failed) > 4:
        print(f"        ... and {len(failed) - 4} more")
    results.append(dict(id=m['id'], desc=m['desc'], caught=caught, failing_tests=len(failed)))

print()
print(f"{len(results) - len(not_caught)}/{len(results)} mutations caught" + (f"; NOT caught: {', '.join(not_caught)}" if not_caught else ''))
sys.exit(1 if not_caught else 0)
