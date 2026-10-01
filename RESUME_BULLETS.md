# Resume and LinkedIn claims

Every claim below is tied to something in this repository that you can run or
read. Numbers appear only where they were observed. If you change a claim, change
its evidence column too.

## One-line project description

> **ScaleLink**: a Node/Express URL shortener with an atomic Redis-Lua
> sliding-window rate limiter shared across instances behind nginx, and race-free
> short-code allocation proven by concurrency tests against a real Redis.

## Resume bullets

1. **Implemented an atomic Redis Lua sliding-window rate limiter shared by two
   Node instances behind nginx**, using Redis server time so a skewed app clock
   can't widen the limit; verified that exactly the configured limit (10 of 200
   concurrent requests) is admitted across independent connections and across two
   real OS processes.
2. **Made short-code allocation race-free** by reserving each code with a single
   `SET NX` (bounded retries, `503` instead of overwrite) and resolving + counting
   clicks in one Lua step; reproduced the original bug first (30 concurrent
   creators were all handed one code, only one URL survived), then proved the fix
   with forced and real key collisions across two processes.
3. **Built a 98-test, real-Redis (no mocks) concurrency and failure suite and
   proved it can fail**: TCP fault injection for Redis down/stalled/lost-reply,
   16 deliberate source mutations all caught, 20/20 consecutive green runs, and CI
   on Node 20/22 plus a Docker Compose nginx + 2-instance smoke test.

## LinkedIn bullets

1. **Failure behaviour as a design decision:** Redis outage returns a fast `503`
   (bounded command timeouts), the limiter fails closed, a write whose reply was
   lost is never silently re-sent, readiness is separate from liveness, and the
   instance reconnects by itself, each of these covered by a test that injects a
   real network fault.
2. **Closed a rate-limit bypass:** the original `trust proxy: true` let a client
   pick its own rate-limit bucket via `X-Forwarded-For` (50 of 50 requests admitted
   at a limit of 5). The default is now "trust nobody", hop-count/CIDR trust is
   explicit, `TRUST_PROXY=true` is refused, and nginx overwrites the header.
3. **Honest load testing:** k6 open-model runs against the nginx + 2-instance
   stack on one 4-vCPU machine (load generator co-located) observed 2,000
   `POST /api/shorten`/s at p99 30 ms with no errors and saturation near 4,000/s.
   The benchmark also exposed two real config defects in my own setup (nginx's
   default 512-connection limit, a Node/nginx keep-alive 502 race), which I fixed
   and documented with the raw results.

## 30-second interview pitch

"ScaleLink is a URL shortener, but the point is the part underneath: several
stateless Node instances behind nginx sharing one Redis. I built the rate limiter
as a single Lua script on Redis, so the 'count, decide, record' step can't be
interleaved across instances, and it uses Redis's clock because I reproduced two
instances with skewed clocks jointly admitting double the limit. Short codes are
reserved with one `SET NX`, because the original check-then-set handed the same
code to 30 concurrent users. I tested all of that against a real Redis, including
two actual processes racing and injected network faults, and checked the tests
could fail by breaking the code on purpose sixteen ways. The benchmark is
deliberately modest and bounded to the machine I ran it on. It also found two bugs
in my own nginx setup, which I fixed."

## Evidence for each claim

| Claim | Where to see it |
| --- | --- |
| exactly `limit` of 200 concurrent admitted, across connections | `tests/limiter.test.js` ("admits EXACTLY …") |
| …across two real OS processes | `tests/multiInstance.test.js` ("admits EXACTLY …") |
| Redis time, skewed clock can't widen the window | `tests/limiter.test.js` ("uses Redis time…"); mutation M6 |
| original double-admission under clock skew (10 + 10 at limit 10) | reproduced on the old code; described in `docs/ARCHITECTURE.md` |
| `SET NX` reservation; 30 creators → one winner | `tests/links.test.js`; mutations M1, M15 |
| original bug: 30 told 201 for one code, one URL survived | reproduced on the old code before the fix (commit message `6e94a28`) |
| real collisions across two processes (`CODE_LENGTH=1`) | `tests/multiInstance.test.js` |
| 98 tests, real Redis, no mocks | `npm test`; `TESTING.md` |
| 16/16 mutations caught; one initially missed and fixed | `TESTING.md`; `scripts/mutation-check.py`; commit `1df0b28` |
| 20/20 consecutive green runs | `TESTING.md` |
| CI Node 20/22 + compose smoke | `.github/workflows/ci.yml`; Actions runs |
| fault injection, fail closed, no blind resend | `tests/failure.test.js`; mutations M8, M9 |
| `X-Forwarded-For` bypass (50/50 at limit 5) and fix | reproduced on the old code; `tests/trustProxy.test.js`; mutation M5 |
| benchmark numbers and the two defects | `BENCHMARK.md`; `benchmark-results/` |

## Do NOT use these (from the old README / docs / package metadata)

| Old claim | Why it must go |
| --- | --- |
| "load-tested on Azure", "provisioned entirely with Terraform", "Azure Load Balancer" | The Terraform was never applied or validated in anything verifiable here; there is no Azure result. |
| "ramps to 1,000 req/sec against the live load balancer … a measured result from the actual deployed infrastructure" | No such run exists in the repository; the old k6 script also simulated clients by forging `X-Forwarded-For`, i.e. exploiting the limiter bypass. |
| "handled 1850 req/sec at p99 210ms", "145 req/sec at p99 180ms" (DEPLOY.md, local-deploy README, k6 script) | Illustrative placeholder numbers in the old docs, not observed results. |
| "zero false blocks at 44,000 requests to one key" | Not reproducible from anything in the repository. |
| "30 truly concurrent requests against ioredis-mock … hold the limit exactly" as proof of atomicity | A JS mock cannot show a Redis script is atomic; that evidence is now real-Redis only. |
| "9 tests" | Stale; there are 98. |
| "proves this live against a real deployment" (`verify-distributed-rate-limit.js`) | Script removed; replaced by `scripts/smoke.js`, which was run against the local compose stack and in CI. |
| "genuinely atomic distributed rate limiter" for the *old* code | Its decision was atomic, but it trusted each app's clock (2× over-admission) and forged headers (bypass). |
| anything like "zero race conditions", "highly scalable", "production-ready", "enterprise-grade" | Not claimed anywhere and not supportable: Redis is a single point of failure, nothing was run in production, and one benchmark on one machine says nothing about scale. |
