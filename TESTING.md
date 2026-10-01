# Testing

98 tests. Everything that makes a claim about Redis behaviour (atomicity,
concurrency, expiry, failure) runs against a **real Redis server**; there is no
Redis mock anywhere. A mock written in JS cannot demonstrate that a Redis-side
script is atomic. The only stubs are in three pure unit files that test decision
mapping and parsing.

## Running

```bash
docker run -d -p 6379:6379 redis:7-alpine     # or any Redis >= 5
npm ci
npm test                                       # everything, serially
npm run test:unit                              # the 33 pure unit tests only; no Redis needed
```

* **Redis is required and its absence fails the run**, with a message saying so.
  Nothing skips silently.
* The suite `FLUSHDB`s **database 15** (`TEST_REDIS_URL`, default
  `redis://127.0.0.1:6379/15`). It refuses to start against database 0, so it
  cannot wipe a development Redis by accident.
* Test files run serially (`maxWorkers: 1`) because they share that database.

## What is covered

| File | Tests | Real Redis? | Covers |
| --- | ---: | :---: | --- |
| `tests/limiter.test.js` | 11 | yes | exactly `limit` of 200 concurrent over 8 connections; boundary and `remaining`; independent clients; rejected requests record nothing; 1000 concurrent same-millisecond members stay unique; window membership/cleanup via state seeded from Redis `TIME`; `retryAfterMs`; real re-admission and key expiry; a skewed app clock cannot widen the window |
| `tests/links.test.js` | 15 | yes | create/redirect/stats; 200 concurrent redirects = 200 clicks; HEAD not counted; no orphan counter; collision retry; exhausted retries never overwrite; 30 concurrent creators of one code → one winner; two instances racing; contended small code pool; TTL and counter-TTL inheritance; real expiry |
| `tests/multiInstance.test.js` | 5 | yes | **two real `node src/server.js` processes**: exactly `limit` of 200 split across both; one shared budget; forged `X-Forwarded-For` ignored; cross-instance redirects and click aggregation; real collisions with `CODE_LENGTH=1` |
| `tests/failure.test.js` | 8 | yes + TCP fault proxy | Redis refused / stalled → fast 503, never 404 for redirects, liveness vs readiness, limiter fails closed, self-recovery; a write whose reply was lost (and the connection then dropped) is **not** re-sent: no second mapping, no double click |
| `tests/trustProxy.test.js` | 8 | yes | default ignores forwarded headers; trusted proxy honoured; forged left-hand entries ignored (list and hop-count modes); untrusted peer cannot use the header; `TRUST_PROXY=true` refuses to boot |
| `tests/http.test.js` | 18 | yes | 400/413/415 mapping, malformed JSON, rate-limit headers and `Retry-After`, malformed requests are metered, redirects are not limited, probes |
| `tests/unit/config.test.js` | 13 | no | strict env parsing; `TRUST_PROXY` rules |
| `tests/unit/validate.test.js` | 15 | no | URL/body/TTL validation |
| `tests/unit/rateLimitMiddleware.test.js` | 5 | no (stub limiter) | 429 mapping, `Retry-After` rounding, **fail-closed decision**, IP normalisation |

## Timing policy

Real elapsed time is unavoidable in only a few places, because the limiter and
TTLs run on **Redis's** clock, which a test cannot fake:

* Window membership is tested **without sleeping**, by seeding the sorted set
  with scores computed from Redis `TIME` (clearly inside or outside the window).
* Re-admission after the window and key expiry (`limiter.test.js`), link expiry
  (`links.test.js`) and the lost-reply tests (`failure.test.js`) do wait; each
  states its tolerance next to the assertion (for example "TTL 1 s + 400 ms
  slack"; "still rejected 400 ms before the reported retry time").
* Concurrency tests assert **invariants that hold for every interleaving**
  (exactly `limit` admitted; every 201 owns a distinct code that stores its own
  URL), not counts that depend on scheduling.
* The exact-millisecond window boundary is not asserted (not controllable).

Fault injection (`tests/helpers/faultProxy.js`) is a small TCP proxy between the
app and the real Redis that can refuse connections, black-hole traffic, or
forward requests while swallowing the replies. No `redis-server` binary is needed
by the tests.

## Flakiness check

<!--FLAKE-->

## Mutation audit: can the tests fail?

Passing tests prove little if they would also pass with the bug. So the source
was mutated one deliberate bug at a time, the **full** suite run each time, and
the file reverted with `git checkout`. Reproduce with
`python3 scripts/mutation-check.py` (needs a clean `src/`; manual, not in CI).

| # | Injected bug | Result |
| --- | --- | --- |
| M1 | remove `NX` from short-code reservation | caught (6 tests) |
| M2 | rate-limit decision made non-atomic (JS read-then-write instead of Lua) | caught (4) |
| M3 | remove unique request member (member = timestamp only) | caught (9) |
| M4 | disable cleanup of expired entries | caught (1) |
| M5 | trust arbitrary forwarded IP headers (`trust proxy: true`) | caught (6) |
| M6 | use the app instance's `Date.now()` instead of Redis `TIME` | caught (1) |
| M7 | no `PEXPIRE` on accept (limiter keys never expire) | caught (1) |
| M8 | let ioredis auto-resend in-flight commands after reconnect | caught (2) |
| M9 | limiter fails **open** on backend error | caught (1) |
| M10 | `INCR` the click counter before checking the link exists | caught (2) |
| M11 | count `HEAD` as a click | caught (1) |
| M12 | body parser before the rate limiter | caught (1) |
| M13 | click counter does not inherit the link's TTL | caught (2) |
| M14 | off-by-one at the limit (`>` instead of `>=`) | caught (21) |
| M15 | exhausted retries overwrite on the last attempt | caught (5) |
| M16 | redirect of a missing link throws instead of 404 | caught (2) |

**16/16 caught** on the final code. One of them was *not* caught at first: M8
survived the first version of the "no blind retry" test, because that test let the
request time out before restoring the connection, so a re-sent command could not
affect the outcome. The test was rewritten so the connection returns while the
command is still pending (a re-send then creates a second mapping or a second
click), and M8 is now caught. Only these 16 mutations were tried; others may
exist that no test catches.

## CI

`.github/workflows/ci.yml`, on every push and on pull requests to `main`:

* `test` on Node 20 and 22 against a `redis:7-alpine` service container:
  `npm ci` (no `--legacy-peer-deps`), prints the Redis version, `npm test`.
* `compose-smoke`: builds the repo's own Dockerfile, starts nginx + two app
  containers + Redis from `docker-compose.yml`, waits for health checks, runs
  `scripts/smoke.js` through nginx, dumps logs on failure.

CI does not run the benchmark or the mutation audit.
