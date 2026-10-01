# Deployment

What is verified, what is not, and the assumptions each option makes.

| Path | Status |
| --- | --- |
| `docker compose` (nginx → 2 apps → Redis) | **Verified**: built and smoke-tested locally and in CI on every push. |
| Single process (`npm start`) against any Redis | **Verified** by the test suite (it runs `src/server.js` as real child processes). |
| Cloudflare quick tunnel in front of compose | Works as a public demo; **do not benchmark through it** (below). |
| `terraform/` (Azure VMs + load balancer) | **Not verified.** Kept as a reference; see below. |

## Docker Compose (the reference topology)

```bash
docker compose up --build --wait   # redis -> app1, app2 -> nginx, each gated on health
node scripts/smoke.js http://localhost:8080
docker compose down -v
```

* Only nginx (`8080`) is published, plus Redis on `127.0.0.1` for local tooling
  (`REDIS_HOST_PORT=6380 docker compose up …` if a local Redis already holds 6379).
* Startup ordering is by health, not timing: apps wait for Redis to answer
  `PING`, nginx waits for both apps' `/ready`.
* Redis runs with AOF (`appendonly yes`, default `everysec` fsync) on a named
  volume. That is configuration; a crash-recovery test has not been run.
* Default limit is 20 accepted `POST /api/shorten` per client IP per 10 s;
  override with `RATE_LIMIT_MAX_REQUESTS` / `RATE_LIMIT_WINDOW_SECONDS`.

## Client identity (read this before putting anything in front of the app)

The limiter keys on `req.ip`. See [ARCHITECTURE.md](ARCHITECTURE.md#client-identity-and-trust-proxy).

* With `TRUST_PROXY` unset the app trusts nobody and uses the TCP peer address.
  Use this when clients connect to the app directly.
* Behind exactly one reverse proxy, set `TRUST_PROXY=1` **and** make the proxy
  overwrite `X-Forwarded-For` (the bundled `nginx/nginx.conf` does).
* If you set any trust value, **the app must not be reachable except through the
  proxy**: anyone who can reach it directly can claim any IP and get unlimited
  buckets. Compose does not publish the app ports for this reason.
* `TRUST_PROXY=true` is refused at startup.
* Behind a CDN or cloud load balancer, trust the correct number of hops or its
  address ranges; a wrong hop count either trusts a forgeable entry or rate
  limits the proxy's own IP as if it were one client.

## Environment variables

See [`.env.example`](../.env.example) for every variable and its default. Invalid
values fail at startup instead of silently falling back.

There are no secrets in this project's configuration. Note that the compose
Redis has no password and relies on not being published beyond loopback; do not
expose it.

## Public demo via Cloudflare quick tunnel

```bash
docker compose up --build --wait
cloudflared tunnel --url http://localhost:8080     # prints a https://<random>.trycloudflare.com URL
node scripts/smoke.js https://<random>.trycloudflare.com
```

Quick tunnels are explicitly not intended for sustained load, add their own
latency and connection handling, and make every request appear to come from the
tunnel's edge. Set `BASE_URL` to the tunnel URL if you want `shortUrl` to point
at it. Nothing in this repository's performance numbers was measured through a
tunnel.

## Azure / Terraform (reference only, not verified)

`terraform/` describes two app VMs behind an Azure Standard Load Balancer and one
Redis VM. It was not applied or validated as part of the work documented here:
**no Azure deployment, availability or benchmark claim is made.** If you use it:

* The load balancer is layer 4 and there is no nginx, so the app sees whatever
  source address the load balancer presents. The default (`TRUST_PROXY` unset)
  is right only if the client's real address is what arrives; verify that before
  relying on per-client limits.
* The Redis VM disables protected mode, binds `0.0.0.0` and sets no password;
  access is restricted only by the network security group to the app subnet.
  SSH is open to `*`. Tighten both before using it for anything real.
* The load-balancer probe uses `/health` (liveness). `/ready` would also catch
  an app that has lost Redis.
