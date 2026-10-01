#!/usr/bin/env bash
# Reproducible benchmark of the compose topology (nginx -> 2 app containers -> Redis).
# See BENCHMARK.md for what this does and does NOT measure.
#
#   bash scripts/bench.sh                       # default rates
#   RATES="500 1000" DURATION_S=30 bash scripts/bench.sh
#
# Environment:
#   RATES        offered request rates (per second) for shorten/redirect   [200 500 1000 2000]
#   DURATION_S   measured seconds per run (after a 5s warm-up)             [20]
#   OUT          results directory                                         [benchmark-results/<utc timestamp>]
#   K6_IMAGE     k6 image                                                  [grafana/k6:latest]
#   UP_FLAGS     extra flags for `docker compose up`                       [--build]
#   REDIS_HOST_PORT  host port for Redis, if 6379 is taken                 [6379]
set -euo pipefail
cd "$(dirname "$0")/.."

RATES=${RATES:-"200 500 1000 2000"}
DURATION_S=${DURATION_S:-20}
K6_IMAGE=${K6_IMAGE:-grafana/k6:latest}
UP_FLAGS=${UP_FLAGS:---build}
OUT=${OUT:-benchmark-results/$(date -u +%Y%m%dT%H%M%SZ)}
NETWORK="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')_default"
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd) # absolute, so it can be bind-mounted into the k6 container

{
  echo "date_utc:      $(date -u +%FT%TZ)"
  echo "git_commit:    $(git rev-parse HEAD) ($(git diff --quiet && echo clean || echo 'DIRTY working tree'))"
  echo "kernel:        $(uname -sr)"
  echo "cpus:          $(nproc)"
  echo "memory_mb:     $(free -m | awk '/^Mem:/ {print $2}')"
  echo "docker:        $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
  echo "k6:            $(docker run --rm "$K6_IMAGE" version 2>/dev/null | head -1)"
  echo "rates:         $RATES"
  echo "duration_s:    $DURATION_S (+5s warm-up for shorten/redirect)"
} | tee "$OUT/environment.txt"

stack_up() { # $1 = RATE_LIMIT_MAX_REQUESTS, $2 = RATE_LIMIT_WINDOW_SECONDS
  RATE_LIMIT_MAX_REQUESTS="$1" RATE_LIMIT_WINDOW_SECONDS="$2" LOG_LEVEL=warn \
    docker compose up -d --wait --force-recreate $UP_FLAGS >/dev/null
  docker compose exec -T redis redis-cli flushall >/dev/null
  { echo "--- stack for limit=$1 window=${2}s"; docker compose exec -T redis redis-cli info server | grep -E 'redis_version'; } >>"$OUT/environment.txt"
}

run_k6() { # $1 scenario, $2 rate, extra -e flags follow
  local scenario=$1 rate=$2; shift 2
  local tag="$scenario-$rate"
  echo; echo ">>> $tag"
  # Sample container CPU/memory every 2s while the test runs, to see what saturates.
  ( while true; do docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' >>"$OUT/$tag.stats.csv" 2>/dev/null || true; sleep 2; done ) &
  local sampler=$!
  docker run --rm --user "$(id -u):$(id -g)" --network "$NETWORK" \
    -v "$PWD/loadtest:/scripts:ro" -v "$OUT:/results" \
    -e BASE_URL=http://nginx:80 -e RESULTS_DIR=/results \
    -e SCENARIO="$scenario" -e RATE="$rate" -e DURATION_S="$DURATION_S" "$@" \
    "$K6_IMAGE" run /scripts/k6-script.js 2>&1 | tee "$OUT/$tag.txt" | grep -E '===|requests:|status:|latency|threshold|✗|ERRO' || true
  kill "$sampler" 2>/dev/null || true; wait "$sampler" 2>/dev/null || true
}

# 1. Throughput of the limiter+write path and of the redirect path: limit set so high
#    that the single load-generator IP is never throttled.
stack_up 1000000000 10
for rate in $RATES; do run_k6 shorten "$rate"; done
for rate in $RATES; do run_k6 redirect "$rate"; done

# 2. The limiter under load: limit 100 per 10s for the one client IP, hammered at 500/s.
stack_up 100 10
run_k6 limited 500 -e LIMIT=100 -e WINDOW_S=10

docker compose down -v >/dev/null
echo; echo "Results in $OUT"
