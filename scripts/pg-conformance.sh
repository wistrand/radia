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
docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=radia -e POSTGRES_DB=radia -p 55432:5432 postgres:16 >/dev/null
cleanup() { docker stop "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "Waiting for Postgres to accept connections…"
for _ in $(seq 1 30); do
  if docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done

export RADIA_PG_URL="postgres://postgres:radia@localhost:55432/radia"
echo "Running conformance against $RADIA_PG_URL"
deno task conformance
