#!/usr/bin/env bash
# Build the browser playground (agent_docs/plan-browser-space.md): bundle the browser entry,
# stage the console and its vendored asset beside it, and stage PGlite's browser dist out of
# deno's npm cache. Everything this writes is gitignored: it runs on demand locally or as a CI
# step, and only docs/playground/index.html is source.
#
#   deno task bundle-browser
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=docs/playground
mkdir -p "$OUT/vendor/pglite/fs" "$OUT/vendor/pglite/contrib"

# 1. The runtime, minus PGlite: the page's import map resolves `@electric-sql/pglite` to the
#    staged dist below, so PGlite keeps loading its wasm the way its own loader expects.
deno bundle --minify --external @electric-sql/pglite -o "$OUT/radia-space.js" src/browser.ts

# 1b. The extension tier's browser surface: the Web Worker jail and its probe
#     (agent_docs/plan-webworker-sandbox.md). Separate from the runtime bundle because it IS
#     separate: extensions import the SDK and never `src/`, and the page imports both.
deno bundle --minify -o "$OUT/radia-jail.js" extensions/ts/browser.ts

# The tree-shake is load-bearing rather than incidental: this entry pulls the broker's host-side
# rules without the FIFO transport that surrounds them. A `Deno.` reference in a browser bundle is
# a module that would ReferenceError in a tab, so it fails the BUILD instead.
if grep -q "Deno\." "$OUT/radia-jail.js"; then
  echo "build-browser: radia-jail.js contains a Deno reference; a browser bundle must not" >&2
  grep -o "Deno\.[a-zA-Z]*" "$OUT/radia-jail.js" | sort -u >&2
  exit 1
fi

# 2. The console, embedded whole by the playground (blob-URL iframe + fetch shim), and the one
#    asset it loads by <script> at runtime.
cp src/ui/index.html "$OUT/console.html"
cp src/ui/vendor/blitzoom.bundle.js "$OUT/vendor/blitzoom.bundle.js"

# 3. PGlite's browser dist, from the version the import map pins (deno.json / deno.lock). The
#    cache is populated by any type-check or run that resolves the adapter, so `deno cache` first
#    covers a cold CI machine.
deno cache src/browser.ts
NPM_CACHE="$(deno info --json | sed -n 's/^  "npmCache": "\(.*\)",$/\1/p')"
PG_DIR="$(ls -d "$NPM_CACHE"/registry.npmjs.org/@electric-sql/pglite/*/ | sort -V | tail -1)"
if [ -z "$PG_DIR" ]; then
  echo "build-browser: @electric-sql/pglite not found in deno's npm cache" >&2
  exit 1
fi
cp "$PG_DIR"dist/index.js "$PG_DIR"dist/chunk-*.js "$OUT/vendor/pglite/"
cp "$PG_DIR"dist/postgres.wasm "$PG_DIR"dist/postgres.data "$OUT/vendor/pglite/"
for f in "$PG_DIR"dist/fs/*.js; do cp "$f" "$OUT/vendor/pglite/fs/"; done
echo "build-browser: staged pglite $(basename "$PG_DIR") ($(du -sh "$OUT/vendor/pglite" | cut -f1))"

# 4. The smoke: boot the BUILT bundle under Deno (no browser) and run one wire round trip.
deno test --allow-read --allow-write --allow-env --allow-net test/browser-bundle.test.ts

echo "build-browser: done -> $OUT (open $OUT/index.html via any static server)"
