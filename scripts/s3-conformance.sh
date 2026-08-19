#!/usr/bin/env bash
# Run the blob-port conformance suite against a real object store (the S3 adapter).
#
# The suite auto-includes the `s3` and `s3+enc` columns when RADIA_S3_URL is set (each test gets
# its own key prefix under one bucket, which the run creates once). Two ways to use this:
#
#   1. Point at your own bucket or endpoint:
#        RADIA_S3_URL=s3://my-bucket/radia-conformance \
#        RADIA_S3_ACCESS_KEY_ID=… RADIA_S3_SECRET_ACCESS_KEY=… scripts/s3-conformance.sh
#
#   2. No URL set + docker available: this starts the endpoint in docker/s3/ (the same recipe a
#      local space uses), runs the suite, and stops it.
#
# A real implementation rather than a fake: a hand-written stub would agree with whatever this
# store does, which is the one thing a conformance run must not do.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "${RADIA_S3_URL:-}" ]]; then
  echo "Using RADIA_S3_URL=$RADIA_S3_URL"
  exec deno task conformance-s3
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "No RADIA_S3_URL set and docker not found." >&2
  echo "Set RADIA_S3_URL=s3://bucket/prefix plus RADIA_S3_ACCESS_KEY_ID/RADIA_S3_SECRET_ACCESS_KEY, or install docker." >&2
  exit 1
fi

COMPOSE=(docker compose -f docker/s3/compose.yaml -p radia-s3-conformance)
echo "Starting the S3 endpoint (docker/s3/compose.yaml on :9000)…"
# --wait blocks on the compose healthcheck, so the first signed request cannot race a gateway that
# is listening but not serving yet.
"${COMPOSE[@]}" up -d --wait
# -v as well as down: a conformance run must not inherit objects from the last one, and this
# project name is not the one a dev space uses.
cleanup() { "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

export RADIA_S3_URL="s3://radia-conformance?endpoint=http://127.0.0.1:9000"
export RADIA_S3_ACCESS_KEY_ID=radialocal
export RADIA_S3_SECRET_ACCESS_KEY=radialocal
echo "Running blob conformance against $RADIA_S3_URL"
deno task conformance-s3
