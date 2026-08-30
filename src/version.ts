// What this build calls itself.
//
// ONE source of truth for a string that already had two homes: `deno.json`, which
// `scripts/build-release.sh` stamps onto every published artifact, and a literal in the health
// response. A binary that reports a different version from the package it shipped in is worse than
// one that reports nothing, so `test/tasks.test.ts` asserts the two agree.
//
// A constant rather than a read of `deno.json`, because the compiled binary has no `deno.json`
// beside it: `deno compile` embeds only what `--include` names, and a version that resolves at
// runtime would answer differently from a checkout than from the artifact people install.

/** The release this build is. Mirrored by `deno.json`'s `version` (guarded).
 *  CalVer as semver: `YYYY.M.COUNTER`, the month unpadded (semver refuses a leading zero) and the
 *  counter restarting at 0 each month. The number is a release stamp, not a compatibility claim;
 *  compatibility lives in `API_VERSION` below. */
export const VERSION = "2026.8.3";

/** The frozen wire contract's version: the `/v0` path prefix and the `api` field of `/v0/health`.
 *  Distinct from `VERSION` on purpose, and it moves far more slowly: the implementation may ship
 *  any number of releases against one contract, which is the whole point of freezing it. */
export const API_VERSION = "v0";
