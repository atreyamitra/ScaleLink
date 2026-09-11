# Local Deployment (no cloud account needed)

This runs the exact same distributed architecture — two app instances behind
a load balancer, sharing one Redis — on your own laptop, then makes it
publicly reachable over HTTPS via Cloudflare Tunnel. No card, no signup,
no cloud quota to fight with.

## Architecture

```
Internet → Cloudflare Tunnel → nginx (load balancer, port 8080)
                                   ├── app1 (Node, shares Redis)
                                   └── app2 (Node, shares Redis)
                                          └── redis (shared state)
```

This is architecturally identical to the Azure version — two stateless app
instances behind a load balancer, one shared Redis for both data and the
atomic rate limiter — just running as local Docker containers instead of
cloud VMs.

## Prerequisites

1. **Docker Desktop** — https://www.docker.com/products/docker-desktop/
   (installs Docker + Docker Compose together). Install it, then open it
   once so the Docker engine is running in the background.
2. **cloudflared** — https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
   Download the installer for your OS. No Cloudflare account or login is
   required for a "quick tunnel" (the mode used here).

## 1. Start the stack

From the project root:

```bash
cd local-deploy
docker compose up --build
```

First run takes a minute or two (building the image, pulling nginx/redis).
Leave this terminal window open and running — it's your live server.

## 2. Confirm it works locally

In a **new** terminal window:

```bash
curl http://localhost:8080/health
```

Run it 4-5 times in a row — you should see `"instance":"app-1"` and
`"instance":"app-2"` alternating, proving the load balancer is actually
splitting traffic across both containers.

## 3. Expose it publicly

In another new terminal window:

```bash
cloudflared tunnel --url http://localhost:8080
```

Within a few seconds this prints a random public URL like:
```
https://random-words-here.trycloudflare.com
```

**This URL is now live on the internet**, tunneled straight to your laptop.
Keep this terminal open too — closing it takes the tunnel down.

## 4. Prove the distributed rate limiter works

From the project root:

```bash
node scripts/verify-distributed-rate-limit.js https://random-words-here.trycloudflare.com
```

(Use your actual tunnel URL.) You should see both `app-1` and `app-2`
answering requests while the shared limit holds exactly — same proof as
the Azure version would have given, just running locally.

## 5. Run the load test

**Important:** free Cloudflare quick tunnels are explicitly not built for
high sustained concurrency (Cloudflare's own docs: *"no uptime
guarantee... not intended for production"*). At the default 1000 req/s
target, this can produce misleading 429/connection-reset noise that has
nothing to do with your app — verified by testing the rate limiter
directly against real Redis (zero false blocks at 44,000 requests to one
key) and by hitting the stack directly, bypassing the tunnel (zero false
blocks there too). Use `PEAK_RPS` to test at a level the tunnel handles
cleanly:

```bash
cd loadtest
k6 run -e BASE_URL=https://random-words-here.trycloudflare.com -e PEAK_RPS=150 k6-script.js
```

At the end, note the summary line — that's your real, live, resume-quotable
number:
```
"handled 145 req/sec at p99 180ms across 2 load-balanced instances"
```

(The exact number will depend on your laptop's CPU/RAM and the tunnel's
condition that day — that's fine and expected; the point is it's a real
measured result from a real deployed system, not an estimate.)

## 6. Shut down

Back in the first terminal (running `docker compose up`), press `Ctrl+C`.
Then:

```bash
docker compose down
```

Close the `cloudflared` terminal too (Ctrl+C). Everything stops; nothing
keeps running or costing anything in the background.

## For the resume

This setup is honestly described as:

> "Deployed behind an Nginx load balancer across two containerized app
> instances sharing a Redis backend, exposed publicly via Cloudflare
> Tunnel; load-tested with k6 to N req/sec at p99 Xms."

This is accurate, verifiable (anyone can ask you to demo it live in an
interview by literally running `docker compose up`), and avoids overstating
it as a "cloud deployment" when it's a local one made publicly reachable.

### Client identity after the security fix

Nginx now replaces forwarded identity headers and the app trusts only the
container proxy network. Load generators cannot invent client IPs. Raise the
limiter threshold explicitly for isolated capacity tests; report created and
rate-limited responses separately. Earlier instructions/results relying on
spoofed X-Forwarded-For do not describe the hardened deployment.
