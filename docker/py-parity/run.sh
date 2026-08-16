#!/usr/bin/env bash
# Runs the SDK content-key parity suite against pinned Python versions, one container each.
# Usage: docker/py-parity/run.sh [py-version ...]     defaults: 3.9 3.13
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ $# -gt 0 ]; then versions=("$@"); else versions=(3.9 3.13); fi

for v in "${versions[@]}"; do
  echo "== python $v"
  docker build -q --build-arg "PY_VERSION=$v" -t "radia-py-parity:$v" docker/py-parity
  docker run --rm -v "$PWD":/repo:ro "radia-py-parity:$v"
done
