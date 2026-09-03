#!/usr/bin/env bash
#
# radia installer.  curl -fsSL https://radia.sh/install.sh | bash
#
# Downloads one compiled binary from the GitHub release, checks it against the release's own
# SHA256SUMS, and puts it in ~/.local/bin. No compiler, no Deno, no root.
#
#   RADIA_VERSION=v2026.9.1     install that release instead of the latest
#   RADIA_INSTALL_DIR=/opt/bin  install somewhere else
#   RADIA_BASE_URL=https://...  fetch the assets from a mirror rather than the GitHub release
#
# Uninstall is `rm` on the one file it wrote; nothing else is touched.
#
# Piping this to a shell trusts whoever serves radia.sh, over TLS, for the length of the run. The
# checksum below catches a truncated download and an asset that is not the one the release
# published. It cannot catch a compromised radia.sh, since the expected hashes arrive over the same
# connection. Read the script first if that matters (it is one screen), or skip it and build from a
# checkout with `deno task compile`.
#
# EVERYTHING IS INSIDE main(), called on the last line. A `curl | bash` that loses its connection
# half way then runs nothing at all, rather than the first half of an install.

set -euo pipefail

REPO="wistrand/radia"

# The scratch directory, and the trap that removes it. GLOBAL rather than local to main, because an
# EXIT trap runs after main has returned: reaching for a local there is an unbound variable under
# `set -u`, which turns a successful install into a failed one on the very last line.
TMP=""
cleanup() {
  [ -n "$TMP" ] && rm -rf -- "$TMP"
  return 0 # never let cleanup decide the exit status
}
trap cleanup EXIT

main() {
  local version="${RADIA_VERSION:-latest}"
  local dest_dir="${RADIA_INSTALL_DIR:-$HOME/.local/bin}"

  need curl
  need uname
  need gzip
  local sha_cmd
  sha_cmd="$(sha_tool)"

  local target
  target="$(detect_target)"

  # A mirror (or the smoke test, which serves a built release over loopback) replaces the whole
  # base. The asset NAMES stay the contract either way.
  local base="${RADIA_BASE_URL:-}"
  if [ -n "$base" ]; then
    :
  elif [ "$version" = "latest" ]; then
    # The /latest/download/ redirect resolves without api.github.com, so this needs no token and
    # cannot hit the 60-per-hour unauthenticated API rate limit that bites shared networks first.
    base="https://github.com/$REPO/releases/latest/download"
  else
    base="https://github.com/$REPO/releases/download/$version"
  fi

  local asset="radia-$target.gz"
  TMP="$(mktemp -d)"
  local tmp="$TMP"

  say "downloading $asset ($version)"
  fetch "$base/$asset" "$tmp/$asset"
  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS"

  # Verify before unpacking, and fail if the sums file does not mention this asset: a missing line
  # means nothing was verified.
  local want got
  want="$(awk -v a="$asset" '{ n = $2; sub(/^\*/, "", n); sub(/^\.\//, "", n); if (n == a) print $1 }' "$tmp/SHA256SUMS" | head -1)"
  [ -n "$want" ] || die "SHA256SUMS from the release does not list $asset; refusing to install"
  got="$($sha_cmd "$tmp/$asset" | awk '{print $1}')"
  [ "$want" = "$got" ] || die "checksum mismatch for $asset
  expected $want
  got      $got
This is either a corrupted download or an asset that is not the one the release published."
  say "checksum ok"

  gzip -dc "$tmp/$asset" > "$tmp/radia"
  chmod +x "$tmp/radia"

  # Run it BEFORE installing. A binary for the wrong libc or the wrong architecture fails here, in a
  # temp directory, rather than becoming the `radia` on someone's PATH that exits 126 forever.
  local reported
  reported="$("$tmp/radia" version 2>/dev/null)" || die "the downloaded binary does not run on this machine ($target).
If this is Alpine or another musl system, see the note below about glibc."

  mkdir -p "$dest_dir"
  # mv over a running binary is fine on Unix (the open file keeps its inode), and it is atomic
  # within one filesystem, so nobody sees a half-written radia.
  mv "$tmp/radia" "$dest_dir/radia"

  say "installed $reported"
  say "  -> $dest_dir/radia"
  case ":$PATH:" in
    *":$dest_dir:"*) say "run: radia dev" ;;
    *)
      say ""
      say "$dest_dir is not on your PATH. Add it:"
      say "  echo 'export PATH=\"$dest_dir:\$PATH\"' >> ~/.profile && . ~/.profile"
      say "then run: radia dev"
      ;;
  esac
}

detect_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  # The binaries are built against GLIBC (`x86_64-unknown-linux-gnu`), so on musl they install
  # cleanly and die at exec. Saying so here beats "not found" from a dynamic loader.
  if [ "$os" = "Linux" ] && ldd --version 2>&1 | grep -qi musl; then
    die "this looks like a musl system (Alpine and similar), and the released binaries are built for glibc.
Build from a checkout instead: git clone https://github.com/$REPO && cd radia && deno task compile"
  fi
  case "$os/$arch" in
    Linux/x86_64) echo "x86_64-unknown-linux-gnu" ;;
    Linux/aarch64 | Linux/arm64) echo "aarch64-unknown-linux-gnu" ;;
    Darwin/x86_64) echo "x86_64-apple-darwin" ;;
    Darwin/arm64) echo "aarch64-apple-darwin" ;;
    *) die "no released binary for $os/$arch.
Native Windows is unsupported: run this installer inside WSL2 instead.
Anything else: build from a checkout with \`deno task compile\`." ;;
  esac
}

# `--fail` so an HTML error page never lands on disk as a binary, and `-L` to follow the release
# redirect, which is what lets this work without the GitHub API.
fetch() {
  curl -fsSL --retry 3 --retry-delay 1 "$1" -o "$2" ||
    die "download failed: $1
If the release exists, this is usually a network or proxy problem; if it does not, check https://github.com/$REPO/releases"
}

sha_tool() {
  if command -v sha256sum >/dev/null 2>&1; then
    echo "sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    echo "shasum -a 256"
  else
    die "need sha256sum or shasum to verify the download; refusing to install unverified"
  fi
}

need() { command -v "$1" >/dev/null 2>&1 || die "need $1"; }
say() { printf '%s\n' "$*"; }
die() {
  printf 'radia install: %s\n' "$*" >&2
  exit 1
}

main "$@"
