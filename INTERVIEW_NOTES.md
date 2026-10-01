# Interview notes

Short answers, with the tradeoffs. Everything here is something the repository
actually does or measured; where I did not verify something, the answer says so.
Detail lives in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Redis and the rate limiter

**Why Redis?**
The app instances are stateless and several run at once, so rate-limit state,
links and counters have to live somewhere they all see. Redis gives atomic
single-key commands and server-side scripts, per-key TTL (so limiter state
cleans itself up), and sub-millisecond latency. The cost is that it becomes a
shared dependency and single point of failure, which I designed the failure
behaviour around rather than hid.

**Why Lua?**
The limiter's decision is "count the entries in the window; if under the limit,
record this request". Done from Node as separate commands, that is a
check-then-act race: two instances both read 9/10 and both admit, giving 11. A
script runs to completion before Redis executes anything else, so trim → count →
decide → record is one indivisible step across all instances and connections.
`MULTI/EXEC` can't do it because the decision depends on a value read inside the
transaction; `WATCH` can, but turns contention into retries. One script = one
round trip.

**Why not rate-limit in Node memory?**
Each instance would only see its own traffic. With two instances a client gets
up to 2× the limit, with N instances N×, and the effective limit changes
whenever you scale or the load balancer rebalances. State is also lost on
restart. (Per-instance limiting is fine as a cheap first layer; it is not a
shared limit.)

**How does it work across multiple app instances?**
Every instance runs the same script against the same key, `rl:{client-ip}`, in
the same Redis. The test starts two real `node src/server.js` processes, sends
200 concurrent requests from one client alternately to both, and asserts exactly
`limit` succeed, with both instances' `X-Served-By` values present.

**What race does Lua prevent, concretely?**
Check-then-act on the count. And a second, less obvious one I hit: clock skew.
The first version passed `Date.now()` from each app into the script; an instance
whose clock was one window ahead saw everyone else's entries as expired and
together they admitted 2× the limit (reproduced: 10 + 10 with a limit of 10).
Using Redis `TIME` inside the script removes the skew because one clock owns the
data.

**How does a sliding-window log work? Complexity?**
Keep a timestamp per accepted request in a sorted set. On each request drop
entries older than `now − window`, count the rest, admit if under `limit`. The
invariant is exact: any interval of length `window` contains at most `limit`
admitted requests, so there's no burst at a window boundary like a fixed-window
counter has. Cost is O(log N + M) time (N ≤ limit, M = expired entries removed,
each removed once) and O(limit) memory per active client. A counter is O(1) but
approximate; a sliding-window *counter* approximates the log with two buckets.
The log is the exact one and its cost is bounded by `limit`, which is small here.

**How do you prevent sorted-set member collisions?**
Members must be unique or `ZADD` overwrites and the request isn't counted, which
under-counts and over-admits. The member is `<ms>-<k>` where k is the count of
entries already stamped with this exact millisecond. Those can never have been
trimmed (the trim only removes scores ≤ now − window), so k is the next unused
suffix: deterministic, no randomness, no extra key. My first version used
`math.random()`; it worked on the Redis I tested but depends on the PRNG, which I
didn't want to rely on. A test fires 1000 concurrent requests, asserts several
share a millisecond, and asserts `ZCARD` is exactly 1000.

**How do you expire old limiter state?**
Two ways. Each request trims entries older than the window, and `PEXPIRE key
window` runs on every accepted request, so an idle client's key disappears
`window` after its last accepted request. Rejected requests record nothing, so
an attacker hammering a closed window can't grow the set past `limit`.

**What happens at high request volume?**
Per-request cost is O(log limit) and Redis executes the scripts serially on one
thread, so Redis throughput is the ceiling for the whole system (plus network).
In my benchmark the two Node processes were each near a full core at 3,000–4,000
req/s while Redis peaked around 37% of one core, so Redis was not the constraint
*there*. That is one 4-vCPU machine with the load generator on it, so it says
nothing about Redis's own ceiling or a bigger deployment. Beyond a single Redis
you'd shard by client key; the keys already use hash tags.

## Short codes

**Why `SET NX` for short codes?**
Creating a link must be atomic with "this code was free". `SET key url NX` is one
command that either creates the key (value and TTL together) or does nothing and
tells you it existed. There is no gap between checking and writing, so two
requests can't get the same code, a live link can't be overwritten, and no reader
can see a reserved-but-empty mapping. My first version did `EXISTS` then
`SET`; I reproduced 30 concurrent creators all told 201 for one code while only
one URL survived, and an existing link overwritten after retries ran out.

**How do collisions work?**
`NX` returns nil → pick another random code and try again, at most 5 times, then
return `503` without writing. Codes are 7 chars of a 64-symbol alphabet, so
collisions are rare, which is exactly why the tests force them: with
injected generators, and with `CODE_LENGTH=1` (64 possible codes) across two real
processes so collisions are real, not mocked. The invariant tested: no code
issued twice, every stored URL belongs to the caller who was handed that code.

**Do you retry writes on a Redis error?**
No. After a timeout the `SET` may have been applied; retrying could create a
second mapping. The caller gets `503` and decides. The client library is also
configured not to re-send in-flight commands after a reconnect (a test drops the
reply to a write after Redis executed it and asserts exactly one effect). Worst
case is one unreferenced mapping.

## Failure and operations

**What happens if Redis goes down?**
Every command has a timeout, there is no offline queue, so requests fail fast
with `503` + `Retry-After` instead of hanging or piling up. Redirects return
`503` (never a false `404`). The limiter **fails closed**. `/health` stays up
(liveness), `/ready` goes `503` (readiness). The client reconnects by itself. All
of this is tested by injecting real TCP faults between the app and Redis.
Redis stays a single point of failure; I did not build replication.

**Why fail closed for the limiter? Isn't failing open the norm?**
Failing open is the norm when the limiter's store is separate from the
protected resource. Here the protected handler needs the same Redis, so failing
open buys nothing (the request fails right after) and removes protection exactly
as Redis recovers. It also hides bugs. If the limiter lived in a different store
I'd reconsider.

**How do you stop clients forging `X-Forwarded-For`?**
`trust proxy` defaults to nobody, so identity is the TCP peer. Behind nginx the
app is configured with `TRUST_PROXY=1` and nginx *overwrites* the header with
`$remote_addr`; hop-count mode also takes the rightmost entry. `TRUST_PROXY=true`
is refused at startup. The original code had `trust proxy: true` and its own load
test relied on forging the header to look like many clients; I reproduced 50/50
requests admitted at a limit of 5. Assumption to state out loud: with trust
enabled, the app must not be reachable except via the proxy.

## Scale and the benchmark

**How would you scale Redis?**
Vertically first (it's single-threaded; a script call is tiny). Then
replicate for availability (accepting async-replication loss on failover and
that the limiter would then read the new primary's clock), and shard by key for
throughput; the keys already carry hash tags so a link's two keys and a client's
limiter key each land on one slot. I have not run any of that.

**What would change for millions of users?**
Redis HA (sentinel/cluster), memory sizing for the limiter log (I measured
about 30 B per entry up to 128 entries, then about 130 B once Redis switches the
sorted set to a skiplist, so `limit` is not free) or a cheaper algorithm
(sliding-window counter / GCRA) if `limit` were large, an eviction/TTL policy for
links, auth and ownership,
abuse handling for the unlimited read path, metrics/tracing, and a CDN for
redirects. The limiter's per-client cost is the first thing I would revisit.

**What would you change for production?**
A password/TLS on Redis, HA Redis with a tested failover, metrics and alerting,
structured request IDs, a real secret/config story, rate limiting on reads and
`stats`, link ownership/auth, a `maxmemory` policy, and load testing from a
separate machine.

## What the benchmark does and does not show

**What does the benchmark prove?**
Under one documented setup (one 4-vCPU VM, k6 on the same machine, nginx → 2 Node
instances → Redis 7.4, logging at `warn`), k6 observed 2,000 `POST /api/shorten`
per second for 30 s with p99 30 ms and no errors, 4,000 redirects per second with
p99 137 ms and no errors, and the write path failing to sustain 4,000/s (3,879
achieved, p99 1.6 s). It also showed the limiter holding under load through
nginx and two instances: at a limit of 100 per 10 s it admitted 300 of 15,001
requests over 30 s, which is exactly the maximum the invariant allows.

**What does it NOT prove?**
Anything about other hardware, a separate load generator, many client IPs (all
load came from one IP, so one hot limiter key), TLS, a cloud deployment, long
soak, Redis failover, or run-to-run precision (one run per rate; at saturation
two runs differed by 2× in p99). It is not a comparison with any other system and
I would not quote a requests-per-second number outside that bounded sentence.

**Did benchmarking find anything?**
Yes, two real defects in my own config. nginx's default 512 worker connections
dropped 22% of requests at 4,000/s while the app and Redis were mostly idle
(nginx's error log said so; fixed with `worker_connections 4096`). And a rare 502
(6 in ~638k requests) from the Node/nginx keep-alive race, where Node closes an
idle connection at the instant nginx reuses it; fixed by making the proxy close
first (nginx 55 s, Node 65 s). The final run had zero in ~641k. I did not build a
deterministic reproduction, so the cause is "the standard race that matches
nginx's error text", not proven.

**How did you make sure the tests can actually fail?**
I injected 16 deliberate bugs one at a time (remove `NX`, make the limiter
non-atomic, trust forwarded headers, fail open, re-enable client auto-resend,
...), ran the full suite for each and reverted. All 16 are caught. One was *not*
caught at first: the "don't blindly retry writes" test passed even with auto-resend
enabled, because it let the request time out before restoring the connection. I
rewrote it and it now fails under that mutation.

