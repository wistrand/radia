#!/usr/bin/env bash
# Build per-OS `radia` binaries and stage the npm + pip shim packages (Phase 7).
#
# The distribution shape is the esbuild/uv pattern: one thin wrapper package per ecosystem that
# resolves and execs a real binary. No install-time compilation, no Deno on the user's machine —
# `npx radia dev` and `pipx run radia dev` just run.
#
#   ./scripts/build-release.sh              # every target
#   ./scripts/build-release.sh host         # only this machine's target (fast local check)
#
# Output: dist/bin/<target>/radia[.exe], dist/npm/**, dist/pypi/**.
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="$(deno eval 'console.log(JSON.parse(Deno.readTextFileSync("deno.json")).version)')"
OUT="dist"

# deno compile targets -> npm platform/arch triples.
TARGETS=(
  "x86_64-unknown-linux-gnu    linux  x64   radia"
  "aarch64-unknown-linux-gnu   linux  arm64 radia"
  "x86_64-apple-darwin         darwin x64   radia"
  "aarch64-apple-darwin        darwin arm64 radia"
  "x86_64-pc-windows-msvc      win32  x64   radia.exe"
)

# `--include` must list every runtime asset: the console is read from disk at startup, and the
# vendored bundle on first request. Missing one produces a binary that boots and then 404s.
COMPILE_FLAGS=(
  --allow-net --allow-read --allow-write --allow-env
  --include src/ui/index.html
  --include src/ui/vendor/blitzoom.bundle.js
)

build_one() {
  local target="$1" bin="$2"
  echo "==> $target"
  mkdir -p "$OUT/bin/$target"
  deno compile "${COMPILE_FLAGS[@]}" --target "$target" --output "$OUT/bin/$target/${bin%.exe}" src/main.ts
}

if [[ "${1:-all}" == "host" ]]; then
  echo "==> host target only"
  mkdir -p "$OUT/bin/host"
  deno compile "${COMPILE_FLAGS[@]}" --output "$OUT/bin/host/radia" src/main.ts
else
  for row in "${TARGETS[@]}"; do
    read -r target _os _arch bin <<<"$row"
    build_one "$target" "$bin"
  done
fi

# ---------------------------------------------------------------------------
# npm: one package per platform (optionalDependencies pick the right one), plus the launcher.
# ---------------------------------------------------------------------------
mkdir -p "$OUT/npm/radia/bin"

OPTIONAL_DEPS=""
for row in "${TARGETS[@]}"; do
  read -r target os arch bin <<<"$row"
  pkg="$OUT/npm/radia-$os-$arch"
  mkdir -p "$pkg/bin"
  [[ -f "$OUT/bin/$target/${bin%.exe}" ]] && cp "$OUT/bin/$target/${bin%.exe}" "$pkg/bin/$bin" || true
  cat > "$pkg/package.json" <<JSON
{
  "name": "@radia/radia-$os-$arch",
  "version": "$VERSION",
  "description": "radia binary for $os/$arch",
  "os": ["$os"],
  "cpu": ["$arch"],
  "files": ["bin"]
}
JSON
  OPTIONAL_DEPS="$OPTIONAL_DEPS\n    \"@radia/radia-$os-$arch\": \"$VERSION\","
done

cat > "$OUT/npm/radia/package.json" <<JSON
{
  "name": "radia",
  "version": "$VERSION",
  "description": "Content-routed coordination runtime for LLM agents",
  "bin": { "radia": "bin/radia.js" },
  "files": ["bin"],
  "optionalDependencies": {$(printf "%b" "$OPTIONAL_DEPS" | sed '$ s/,$//')
  }
}
JSON

cat > "$OUT/npm/radia/bin/radia.js" <<'JS'
#!/usr/bin/env node
// Launcher: resolve the platform-specific binary installed as an optional dependency and exec
// it, forwarding argv, stdio, and the exit code. Nothing is compiled or downloaded at install.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const pkg = `@radia/radia-${process.platform}-${process.arch}`;
const exe = process.platform === "win32" ? "radia.exe" : "radia";

let binary;
try {
  binary = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "bin", exe);
} catch {
  console.error(
    `radia: no prebuilt binary for ${process.platform}/${process.arch}.\n` +
    `Install ${pkg}, or run from source with Deno: deno run -A jsr:@radia/radia dev`,
  );
  process.exit(1);
}

// stdio: "inherit" matters — `radia mcp` speaks JSON-RPC on stdin/stdout and must not be buffered.
const r = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (r.error) {
  console.error(`radia: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 0);
JS
chmod +x "$OUT/npm/radia/bin/radia.js"

# ---------------------------------------------------------------------------
# pip: one wheel-shaped package with the same launcher idea, plus the Python SDK.
# ---------------------------------------------------------------------------
mkdir -p "$OUT/pypi/radia/_bin"
cp sdk/py/radia.py "$OUT/pypi/radia/client.py"

cat > "$OUT/pypi/pyproject.toml" <<TOML
[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[project]
name = "radia"
version = "$VERSION"
description = "Content-routed coordination runtime for LLM agents"
requires-python = ">=3.9"
dependencies = []

[project.scripts]
radia = "radia.__main__:main"

[tool.setuptools]
packages = ["radia"]

[tool.setuptools.package-data]
radia = ["_bin/*"]
TOML

cat > "$OUT/pypi/radia/__init__.py" <<'PY'
"""Radia: coordination runtime client + bundled server binary."""
from .client import RadiaClient, RadiaError, agent_loop  # noqa: F401
PY

cat > "$OUT/pypi/radia/__main__.py" <<'PY'
"""Launcher: exec the bundled `radia` binary, forwarding argv and the exit code."""
import os
import sys
from pathlib import Path


def binary_path() -> Path:
    exe = "radia.exe" if sys.platform == "win32" else "radia"
    return Path(__file__).parent / "_bin" / exe


def main() -> int:
    binary = binary_path()
    if not binary.exists():
        sys.stderr.write(
            f"radia: no bundled binary at {binary}.\n"
            "This wheel was built without one — install a platform wheel, or run from source.\n"
        )
        return 1
    args = [str(binary), *sys.argv[1:]]
    if sys.platform == "win32":
        import subprocess

        return subprocess.call(args)
    # exec so stdin/stdout stay a direct pipe — `radia mcp` speaks JSON-RPC over them.
    os.execv(str(binary), args)


if __name__ == "__main__":
    raise SystemExit(main())
PY

echo
echo "staged:"
echo "  $OUT/bin/     compiled binaries"
echo "  $OUT/npm/     radia + per-platform packages (npm publish each)"
echo "  $OUT/pypi/    wheel source; copy a binary into radia/_bin/ before building"
