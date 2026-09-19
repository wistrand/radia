#!/usr/bin/env bash
# N `radia serve` instances over ONE throwaway Postgres, then bench/authprobe.ts against all of them.
#
#   scripts/authprobe-cluster.sh            # 3 instances, the probe's defaults
#   scripts/authprobe-cluster.sh 4 --rounds 200 --window-ms 500
#
# RADIA_PG_URL set: uses that database instead of a container (it must be a throwaway: the probe
# writes grants and runs it cannot delete). Everything else, instances included, is torn down on exit.
set -euo pipefail
cd "$(dirname "$0")/.."

N="${1:-3}"
shift || true
BASE_PORT="${AUTHPROBE_BASE_PORT:-7950}"
WORK="$(mktemp -d)"
PIDS=()
NAME=""

cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  [[ -n "$NAME" ]] && docker stop "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

if [[ -z "${RADIA_PG_URL:-}" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "No RADIA_PG_URL set and docker not found." >&2
    exit 1
  fi
  NAME="radia-authprobe-$$"
  echo "Starting throwaway Postgres container ($NAME)…"
  docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=radia -e POSTGRES_DB=radia -p 127.0.0.1::5432 postgres:16 >/dev/null
  PORT="$(docker port "$NAME" 5432/tcp | head -1 | sed 's/.*://')"
  for _ in $(seq 1 30); do
    if docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    sleep 1
  done
  RADIA_PG_URL="postgres://postgres:radia@localhost:$PORT/radia"
fi

# The first instance creates the schema alone: concurrent `create … if not exists` DDL from several
# processes can collide in the catalog, and a deployment rolls instances the same way.
URLS=()
TOKENS=()
for i in $(seq 0 $((N - 1))); do
  port=$((BASE_PORT + i))
  tokfile="$WORK/op$i"
  deno run -A src/main.ts serve --storage postgres --db "$RADIA_PG_URL" --port "$port" \
    --blobs "$WORK/blobs" --artifact-port 0 --operator-token-file "$tokfile" --log-level warn >"$WORK/serve$i.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 60); do
    [[ -s "$tokfile" ]] && curl -sf "http://127.0.0.1:$port/v0/health" >/dev/null && break
    sleep 0.5
  done
  if [[ ! -s "$tokfile" ]]; then
    echo "instance $i did not start; its log:" >&2
    cat "$WORK/serve$i.log" >&2
    exit 1
  fi
  URLS+=("http://127.0.0.1:$port")
  TOKENS+=("$(tr -d '\n' <"$tokfile")")
done

join() { local IFS=,; echo "$*"; }
echo "$N instances over one Postgres; probing…"
deno run -A bench/authprobe.ts --url "$(join "${URLS[@]}")" --token "$(join "${TOKENS[@]}")" "$@"
