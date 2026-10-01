# Benchmark

**Objective.** Measure how the *two-instance compose topology* behaves under an
increasing, fixed offered request rate: where latency stays flat, where it
climbs, and whether anything errors. It is a behaviour-under-load check of this
repository's own stack, not a claim about any production system, and not a
comparison with other software.

Every number below was observed in the run described here. Raw k6 summaries,
container CPU samples and the environment record are committed in
[`benchmark-results/official-run/`](benchmark-results/official-run/).

## Result, bounded to this setup

> On one 4-vCPU VM with the load generator on the same machine, k6 observed the
> compose stack (nginx → 2 Node instances → Redis) serve **2,000 `POST /api/shorten`
> per second for 30 s with p99 30 ms and no errors**, and **4,000 redirects per
> second with p99 137 ms and no errors**. Offered **4,000 `POST /api/shorten` per
> second was not sustained** (3,879 achieved, p99 1.6 s). One run per rate.

That is all this benchmark supports. It does not say what the system does on
other hardware, with the load generator elsewhere, with many client IPs, or over
time.

## Setup

| | |
| --- | --- |
| Machine | one cloud VM: Linux 6.18.44-fc-v50, **4 vCPU, 16 GB**; CPU model and neighbours unknown to me |
| Everything co-located | k6, nginx, both app instances and Redis share those 4 vCPUs (k6 itself used ~0.4–1.6 cores) |
| Topology | k6 (container, on the compose network) → nginx (`worker_processes auto`, 4096 connections) → `app-1`, `app-2` (Node 20.20.2, one process each) → Redis **7.4.11** (single, AOF `everysec`, as in `docker-compose.yml`) |
| k6 | v2.3.0, run as a container, hitting `http://nginx:80` (no host port-forwarding in the path) |
| Image | built with the repo `Dockerfile` plus **one sandbox-only layer** that trusts the sandbox proxy's CA (needed only because this sandbox's TLS-intercepting proxy breaks in-container `npm ci`); `UP_FLAGS="--no-build"` |
| Commit | `b50ded4` (`environment.txt` records it; working tree clean). `docker-compose.yml` has since gained a healthcheck on nginx (it only changes when `up --wait` returns; nothing in the request path) and the benchmark was **not** re-run for it |
| App logging | `LOG_LEVEL=warn`. The default (`info`) logs every request; its cost was **not** measured |
| Rate limiter | `RATE_LIMIT_MAX_REQUESTS=1000000000` per 10 s for the throughput runs: the Lua script runs on every `shorten` request but never rejects. All load comes from one client IP, so it is **one hot limiter key** |
| Load model | `constant-arrival-rate`: a fixed number of requests per second is *offered* regardless of response time, so saturation shows up as latency and achieved < offered. 5 s warm-up (unmeasured) + **30 s measured** per rate |
| `shorten` | `POST /api/shorten`, a unique URL per request, so every request does a real `SET NX` |
| `redirect` | `GET /<code>` over 50 pre-created codes, `redirects: 0` (the 302 itself is the response) |

Command (what was run; `REDIS_HOST_PORT` only because 6379 was taken on this
machine, `--no-build` only because of the image note above):

```bash
REDIS_HOST_PORT=6380 UP_FLAGS="--no-build" RATES="500 1000 2000 3000 4000" DURATION_S=30 \
  OUT=benchmark-results/official-run bash scripts/bench.sh
```

On any machine with Docker: `bash scripts/bench.sh` (builds the image, defaults
to rates 200–2000, 20 s). It needs `docker compose`; k6 is pulled as an image.

## Observed

Latencies in ms, measured phase only. "unexpected" = any status other than the
scenario's expected one (201 / 302), including connection failures. Nothing was
dropped by k6 in any run (`dropped_iterations` = 0).

| scenario | offered/s | achieved/s | requests | unexpected | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| shorten | 500 | 500 | 15,000 | 0 | 1.5 | 2.6 | 6.1 | 103 |
| shorten | 1,000 | 1,000 | 30,001 | 0 | 1.6 | 4.7 | 12.3 | 44 |
| shorten | 2,000 | 2,000 | 60,001 | 0 | 2.8 | 13.0 | 30.0 | 497 |
| shorten | 3,000 | 3,000 | 90,001 | 0 | 8.3 | 66.2 | 140.1 | 633 |
| shorten | 4,000 | **3,879** | 116,377 | 0 | 38.5 | 385.3 | **1,606.9** | 2,289 |
| redirect | 500 | 500 | 15,001 | 0 | 1.1 | 1.6 | 3.1 | 15 |
| redirect | 1,000 | 1,000 | 30,000 | 0 | 1.0 | 2.0 | 5.2 | 47 |
| redirect | 2,000 | 2,000 | 60,001 | 0 | 1.3 | 6.7 | 18.1 | 91 |
| redirect | 3,000 | 3,000 | 90,000 | 0 | 2.2 | 15.4 | 37.9 | 144 |
| redirect | 4,000 | 4,000 | 120,000 | 0 | 6.0 | 64.5 | 137.1 | 483 |

Peak CPU per container (`docker stats` sampled every ~2 s; 100% = one core):

| run | app-1 | app-2 | nginx | redis | k6 |
| --- | ---: | ---: | ---: | ---: | ---: |
| shorten 1,000/s | 54% | 54% | 20% | 25% | 75% |
| shorten 2,000/s | 75% | 84% | 31% | 27% | 83% |
| shorten 3,000/s | 102% | 88% | 41% | 36% | 113% |
| shorten 4,000/s | 94% | 90% | 42% | 37% | 127% |
| redirect 4,000/s | 79% | 85% | 45% | 20% | 112% |

**Limiter under load** (`limited` scenario: limit 100 per 10 s, one client IP,
500 requests/s offered for 30 s). Any 10 s window admits at most 100, so a 30 s
run can admit at most ⌈30/10⌉·100 = **300**. Observed: 15,001 requests, **300
admitted**, 14,701 rejected with 429, 0 unexpected. The limit was reached and
never exceeded, through nginx and two app instances.

## Reading it

* Up to 2,000/s of writes the stack is comfortable: p99 ≤ 30 ms. At 3,000/s the
  tail starts to grow (p99 140 ms); at 4,000/s the writes saturate (achieved
  below offered, p99 1.6 s).
* In this setup the **Node processes were the first thing to saturate**: each sat
  near one full core at 3,000–4,000/s (Node runs JS on one thread), while Redis
  peaked around 37% of a core. That says Redis was not the constraint *here*;
  it says nothing about Redis's own ceiling, and the load generator was taking
  1.1–1.6 cores on the same 4-vCPU machine, so the machine as a whole was close
  to full. Moving k6 elsewhere would change the numbers.
* Redirects are cheaper than creates (no body parse, no limiter, one script call)
  and were not saturated at the highest rate tested.
* **Run-to-run variance is real and was not controlled for.** There was one run
  per rate. An earlier run of the same rates at commit `be8db57`
  ([`earlier-run-be8db57/`](benchmark-results/earlier-run-be8db57/)), differing
  only by the nginx/Node keep-alive timeouts below, gave shorten-4,000 achieved
  3,775/s with p99 3.6 s (vs 3,879/s, 1.6 s), redirect-4,000 p99 171 ms (vs 137),
  but near-identical results at ≤ 2,000/s (e.g. shorten-2,000 p99 29.4 vs 30.0 ms).
  Treat the numbers at and beyond saturation as indicative, not precise.

## What benchmarking found (and what I changed)

This is the most useful part of the exercise. Two real defects in my own
configuration surfaced under load.

1. **nginx dropped connections at its default limit.** With the original
   `events {}` (1 worker, 512 connections), an exploratory 4,000/s run
   ([`exploratory-before-nginx-fix/`](benchmark-results/exploratory-before-nginx-fix/))
   had 22% failures. A diagnostic repeat gave 8,132 of 39,833 requests with *no
   response* (status 0), zero 502/503/504, an empty app log, and nginx's own error
   log repeating `512 worker_connections are not enough`, while the apps and Redis
   were at roughly 70% / 25% CPU. Fix: `worker_processes auto; worker_connections
   4096`. The same 4,000/s run then had 0 failures.
2. **Rare 502s from a keep-alive race.** In the earlier run, 5 of 90,000 requests
   at shorten-3,000 and 1 of 15,001 in the `limited` run were 502s (6 of 638,255
   measured requests); a repeat produced 1 more in about 270,000. The app logs were
   empty and nginx logged `recv() failed (104: Connection reset by peer) while
   reading response header from upstream`. That is the classic race where Node
   closes an idle keep-alive connection (default 5 s) at the instant nginx reuses it.
   Fix: make the proxy close first: nginx upstream `keepalive_timeout 55s`, Node
   `keepAliveTimeout 65s` / `headersTimeout 66s`. The final run has **0**
   unexpected responses in 641,383 measured requests. Caveat: the base rate is
   about 1 in 100,000, so zero in the final run is consistent with the fix (the
   chance of seeing none at the earlier rate would be under 1%) but I did not build
   a deterministic reproduction, so I describe the cause as the well-known race
   that matches nginx's error message, not as proven.

## Limitations (what this does not show)

* **One machine, load generator co-located**, shared CPUs, unknown host
  neighbours. No network between tiers beyond a Docker bridge.
* **One run per rate**; no confidence intervals. Variance at saturation is large.
* **One client IP**, so the limiter's single hot key; real traffic spreads over
  many keys. Per-request limiter cost depends on `limit` (here effectively
  unbounded for throughput runs, 100 in the `limited` run).
* 30 s measured windows: no soak test, no memory-growth or long-term behaviour.
* Request logging was off (`warn`); AOF was on; TLS was not used.
* No failure injection during the load (failure behaviour is covered by the test
  suite, not by this benchmark).
* Not run through any tunnel or cloud load balancer. A free quick tunnel would
  dominate and distort the result; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
* Nothing here is a statement about the Azure/Terraform path, which was never run.
