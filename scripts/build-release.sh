#!/usr/bin/env bash
# Build per-OS `radia` binaries and stage the SDK packages (Phase 7).
#
# Distribution shape (decided 2026-08-30, SDK channel 2026-09-02): the BINARY installs only via
# `curl | sh` (`docs/install.sh`, downloading the release assets `.github/workflows/release.yml`
# publishes). The SDK packages staged below publish as assets on the SAME release, installed by
# pinned URL (release.yml packs dist/npm with `npm pack` and dist/pypi with
# scripts/build-wheel.py); nothing goes to npm or PyPI for now (deferred, not forsworn:
# design-storage.md "Distribution"), and no package carries a launcher or binary. Native Windows
# is unsupported; WSL2 runs the Linux binary.
#
#   ./scripts/build-release.sh              # every target
#   ./scripts/build-release.sh host         # only this machine's target (fast local check)
#
# Output: dist/bin/<target>/radia, dist/npm/**, dist/pypi/**.
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="$(deno eval 'console.log(JSON.parse(Deno.readTextFileSync("deno.json")).version)')"
OUT="dist"

# deno compile targets. `test/docs.test.ts` parses this list and checks `docs/install.sh` offers
# exactly targets built here, so the two cannot drift apart silently.
TARGETS=(
  "x86_64-unknown-linux-gnu"
  "aarch64-unknown-linux-gnu"
  "x86_64-apple-darwin"
  "aarch64-apple-darwin"
)

# `--include` must list every runtime asset: the console is read from disk at startup, and the
# vendored bundle on first request. Missing one produces a binary that boots and then 404s.
# `--allow-run` is what lets `radia host` spawn a JAIL at all. Without it the shipped binary could
# run no model-written code in any mode, and the first symptom was the broker's `mkfifo` refusal
# hiding the larger one: the jail also has to spawn a Deno runtime, which a compiled build resolves
# from PATH rather than from its own executable (extensions/ts/sandbox.ts, `denoRuntime`).
COMPILE_FLAGS=(
  --allow-net --allow-read --allow-write --allow-env --allow-run
  --include src/ui/index.html
  --include src/ui/vendor/blitzoom.bundle.js
)

build_one() {
  local target="$1"
  echo "==> $target"
  mkdir -p "$OUT/bin/$target"
  deno compile "${COMPILE_FLAGS[@]}" --target "$target" --output "$OUT/bin/$target/radia" src/main.ts
}

if [[ "${1:-all}" == "host" ]]; then
  echo "==> host target only"
  mkdir -p "$OUT/bin/host"
  deno compile "${COMPILE_FLAGS[@]}" --output "$OUT/bin/host/radia" src/main.ts
else
  for target in "${TARGETS[@]}"; do
    build_one "$target"
  done
fi

# ---------------------------------------------------------------------------
# npm: the TypeScript SDK + extensions, as source. No binary, no launcher.
# ---------------------------------------------------------------------------

# The SDK and the EXTENSIONS ship as SOURCE, not a build artifact, because the whole distribution
# promise is that nothing compiles at install time.
#
# Note the versioning asymmetry, which is deliberate: `sdk/` mirrors the FROZEN /v0 contract, while
# `extensions/` are conventions that evolve. Anything normative inside an extension (the tree digest)
# carries its own version tag so a change is detectable rather than silent. See extensions/README.md.
#
# The exports map names EVERY module a consumer needs, not only the client. It listed `.` alone, so
# `agentLoop` (the worker loop, the thing every example is built on) was unreachable from the
# published package while the docs and the SDK README both advertised it. `test/docs.test.ts`
# resolves the site's import lines against this map.
mkdir -p "$OUT/npm/radia/sdk" "$OUT/npm/radia/extensions"
# Named in `files` and in `license-files` below, so it has to be here rather than assumed.
cp LICENSE "$OUT/npm/radia/LICENSE"
cp sdk/ts/*.ts "$OUT/npm/radia/sdk/"
cp -r extensions/ts/*.ts "$OUT/npm/radia/extensions/"
cp extensions/README.md "$OUT/npm/radia/extensions/"
# The SDK import inside an extension is `../../sdk/ts/client.ts` in the repo and `../sdk/` once
# staged, so rewrite it rather than shipping a path that resolves to nothing.
sed -i.bak 's|\.\./\.\./sdk/ts/|../sdk/|g' "$OUT/npm/radia/extensions/"*.ts && rm -f "$OUT/npm/radia/extensions/"*.bak

cat > "$OUT/npm/radia/package.json" <<JSON
{
  "name": "radia",
  "version": "$VERSION",
  "description": "Content-routed coordination runtime for LLM agents: TypeScript SDK and extensions",
  "license": "Apache-2.0",
  "files": ["sdk", "extensions", "LICENSE"],
  "exports": {
    ".": "./sdk/mod.ts",
    "./loop": "./sdk/loop.ts",
    "./wire": "./sdk/wire.ts",
    "./registry": "./sdk/registry.ts",
    "./await": "./sdk/await.ts",
    "./client": "./sdk/client.ts",
    "./extensions/*": "./extensions/*.ts"
  }
}
JSON

# ---------------------------------------------------------------------------
# pip: the Python SDK, pure Python. No binary, no launcher. The DISTRIBUTION is `radia-space`
# (the bare PyPI name is an unrelated physics package; research-positioning.md "Naming actions"),
# the IMPORT name stays `radia`.
# ---------------------------------------------------------------------------
mkdir -p "$OUT/pypi/radia"
cp LICENSE "$OUT/pypi/LICENSE"
cp sdk/py/radia.py "$OUT/pypi/radia/client.py"
cp sdk/py/radia_ext.py "$OUT/pypi/radia/ext.py"

cat > "$OUT/pypi/pyproject.toml" <<TOML
[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[project]
name = "radia-space"
version = "$VERSION"
description = "Content-routed coordination runtime for LLM agents: Python SDK"
license = "Apache-2.0"
license-files = ["LICENSE"]
requires-python = ">=3.9"
dependencies = []

[tool.setuptools]
packages = ["radia"]
TOML

cat > "$OUT/pypi/radia/__init__.py" <<'PY'
"""Radia: coordination space client SDK."""
from .client import RadiaClient, RadiaError, agent_loop  # noqa: F401
from .ext import RadiaExt, RadiaExtError  # noqa: F401
PY

echo
echo "staged:"
echo "  $OUT/bin/     compiled binaries (gzipped into release assets by .github/workflows/release.yml)"
echo "  $OUT/npm/     radia: TS SDK + extensions, no binary (release.yml: npm pack -> release asset)"
echo "  $OUT/pypi/    radia-space (imports as radia): Python SDK, no binary (release.yml: scripts/build-wheel.py -> release asset)"
