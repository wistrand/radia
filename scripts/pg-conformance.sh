#!/usr/bin/env bash
# Run the storage conformance suite against a real Postgres (the standalone adapter).
#
# The suite auto-includes the `postgres` adapter when RADIA_PG_URL is set (each test gets an
# ephemeral schema, dropped on close). Two ways to use this:
#
#   1. Point at your own server:
#        RADIA_PG_URL=postgres://user:pass@localhost:5432/radia scripts/pg-conformance.sh
#
#   2. No URL set + docker available: this starts a throwaway Postgres, runs the suite,
#      and removes the container.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "${RADIA_PG_URL:-}" ]]; then
  echo "Using RADIA_PG_URL=$RADIA_PG_URL"
  exec deno task conformance
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "No RADIA_PG_URL set and docker not found." >&2
  echo "Set RADIA_PG_URL=postgres://user:pass@host:5432/db and re-run, or install docker." >&2
  exit 1
fi

NAME="radia-pg-conformance-$$"
echo "Starting throwaway Postgres container ($NAME)…"
# Let DOCKER choose the host port rather than hardcoding one. A fixed port here used to be 55432,
# which sits inside Linux's default ephemeral range (see /proc/sys/net/ipv4/ip_local_port_range,
# typically 32768-60999) — so an unrelated outbound connection could hold it, even just in
# TIME_WAIT, and this script would die with a docker "address already in use" that looks like a
# stale container but is not one. Port 0 asks the kernel for a free port; we read back which.
docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=radia -e POSTGRES_DB=radia -p 127.0.0.1::5432 postgres:16 >/dev/null
cleanup() { docker stop "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PORT="$(docker port "$NAME" 5432/tcp | head -1 | sed 's/.*://')"
if [ -z "$PORT" ]; then
  echo "Could not determine the container's published port." >&2
  exit 1
fi

echo "Waiting for Postgres to accept connections…"
for _ in $(seq 1 30); do
  if docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done

export RADIA_PG_URL="postgres://postgres:radia@localhost:$PORT/radia"
echo "Running conformance against $RADIA_PG_URL"
deno task conformance
