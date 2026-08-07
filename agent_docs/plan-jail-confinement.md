# Plan: confining the filesystem, per platform

> Status: phases 1, 3 and 4 BUILT (2026-08-06); 2 REJECTED; 5 is a posture. Phase 4's macOS run
> EXECUTED later the same day on a real Mac (macOS 26.4.1, Deno 2.9.5, arm64): the full
> `deno task extensions` suite passed, darwin-gated case included, with the machine's own Deno
> cache verified untouched afterwards. Still never run in this repo's CI. The defect is package
> T in [plan-audit-remediation.md](plan-audit-remediation.md); this is the plan to close it.
> Everything below marked "measured" was run against the real jail on Linux, except phase 4:
> `sandbox-exec` was verified on a real Mac 2026-08-06 (macOS 26.4.1, Deno 2.9.5, arm64). Read
> [design-execution.md](design-execution.md) first: the language question is an isolation question,
> and this is the isolation half.

## Contents
- The one hole, and why that simplifies the fix
- What was measured
- A second finding: the jail obeys its prisoner's config
- The shape: a confiner is not a runtime
- Phases
- Open questions

## The one hole, and why that simplifies the fix

The Deno jail already denies net, env, run, ffi and write. MODULE LOADING is the only channel its
read permission does not cover, so the missing piece is filesystem confinement and nothing else.
That is what makes this compositional: keep the permission jail exactly as it is, and add a
filesystem boundary underneath it, chosen per platform. The alternative reading, "replace the Deno
jail with bubblewrap", is both bigger and wrong, because it throws away a permission model that is
safe by ABSENCE and replaces it with one that is safe by presence.

## What was measured

**Filesystem-only bubblewrap is sufficient, and cheaper than the jail we ship.**

| variant | import blocked | time |
|-------------------------------------------|-----|-------|
| `--unshare-all` (today's `bwrapArgs`)      | yes | 65ms  |
| mount namespace only, net left alone       | yes | 34ms  |
| plus `--unshare-pid/ipc/uts/cgroup`        | yes | 32ms  |

Dropping `--unshare-net` matters beyond the 30ms: that is the flag that fails on hosted CI
(`bwrap: loopback: Failed RTM_NEWADDR`, gotchas.md), so the confining variant is likely to run
where today's bubblewrap backend cannot. Net stays denied by Deno's own flags, which is the
safe-by-absence direction rather than the safe-by-presence one.

**The vector is decided by EXTENSION, not by content.**

| file    | content         | `import(…, { with: { type: "json" } })` |
|---------|-----------------|------------------------------------------|
| `a.json`| JSON            | REACHED                                   |
| `b.key` | identical JSON  | refused: "Expected a Json module"         |
| `c.txt` | base64 text     | refused                                   |
| `e.bin` | raw bytes       | refused                                   |

Deno will not parse a non-`.json` file as JSON however it is asked. This BOUNDS the vector, which
is why it is recorded: the hole reaches JSON and code, not arbitrary bytes, so a non-module secret
is unreadable through it today.

It is NOT a mitigation, and was rejected as one (phase 2 below). The bound is a property of Deno's
file-type resolution rather than of the jail, so it holds until an upstream release decides
otherwise, and nothing would tell us when that happened.

## A second finding: the jail obeys its prisoner's config

The jail's cwd is the model-written tree, and Deno discovers `deno.json` from cwd. A workspace that
ships one gets its import map honoured:

```
as shipped         MAP HONOURED {"kek":"KEY"}
with --no-config   map not used: Import "sneaky" not a dependency
```

A sandbox must never take configuration from the code it is sandboxing. This is independent of
module loading, cheaper to fix than any of it, and closed by one flag on every platform.

## The shape: a confiner is not a runtime

`SandboxSpec.isolation` currently conflates two questions: which permission model runs the code, and
what bounds its filesystem. They are independent, and the fix needs them apart:

```ts
isolation: "deno-permissions"                       // what RUNS the code, unchanged
confiner: "none" | "bubblewrap" | "sandbox-exec"    // what BOUNDS the filesystem
importsConfined                                     // derived from the confiner, still probed
```

Selection follows the rule this codebase already uses: a runner publishes only what PROBES clean,
and the record names which jail a result was reached in. So a machine with a confiner serves the
confined sandbox, a machine without it serves the unconfined one and says so, and a policy can bind
`importsConfined: true` when it cares. That is the fallback posture rather than refusing to run
JavaScript at all, because refusing breaks macOS and CI today for a hole that has existed all along.

One trap for whoever builds it: `probeSandbox` picks its probe LANGUAGE from `isolation`
(bubblewrap implies Python), which is the backend/language conflation design-execution.md warns
about. A bubblewrap-confined DENO jail is the first spec where the two differ, so the probe has to
learn the difference before it can verify one.

## Phases

Ordered cheapest first. Phase 1 is worth doing whatever happens to the rest; phase 2 is kept as a
REJECTED option, because it reads like an obvious cheap win and is not.

**1. BUILT (2026-08-06): the jail stops reading its prisoner's configuration.** `--no-config`,
`--no-lock` and `--no-npm` in `jailArgs`, so every Deno spawn gets them (`runCode`, `runEntry`, the
broker). Guarded by "the jail does not read configuration written by its prisoner" in
`extensions/conformance/workspace.test.ts`, which drives a real tree-local `deno.json` and also
asserts the flag list, since a refactor is how one of these goes missing. Plant: removing the flags
restores `MAP HONOURED`.
`--no-npm` was not in the original phase and earned its way in: `npm:` was already unreachable, but
ACCIDENTALLY, failing on an env permission (`TF_BUILD`) before it ever tried to resolve. That is a
block that disappears the day Deno stops reading that variable, and the runner's tool description
has always promised "no npm". `jsr:` was already covered by `--no-remote`.
The cost, such as it is: an import map inside a workspace stops working, loudly ("Import X not a
dependency"). Nothing in the jail can fetch anything, so a map there had no legitimate use.

**2. REJECTED (2026-08-06): renaming Radia's own secrets off `.json`.** Proposed when macOS had no
confiner and this looked like the only portable protection. Two reasons it is not worth doing now
that phases 3 and 4 are both real:

- **It is not a guarantee, it is an upstream behaviour.** The protection is Deno declining to parse
  a non-`.json` file as JSON. That is a file-type heuristic, not a boundary: a release that adds
  content sniffing, or a second runtime with a different table, removes the protection silently and
  no probe here would notice. A security property nothing can verify is one nobody should rely on.
- **The cost is permanent and the benefit was temporary.** The KEK and the credentials file are read
  by name from the CLI, the MCP adapter and the Python SDK, so this is a compatibility shim (read
  the old name, write the new one) that outlives the problem it was working around.

It also never protected the operator's OTHER json (browser `logins.json`, assorted
`~/.config/**/*.json`), so it narrowed our blast radius without closing the hole. A confiner closes
it for every file at once, which is the thing to build.

**The residual, stated rather than discovered later:** on Windows (phase 5) there is no confiner, so
this space's own secrets stay reachable there. Renaming would have hidden ours and left every other
JSON on that machine readable, which is a better-looking report rather than a safer jail. The honest
Windows answer is the record saying `importsConfined: false`, and not running untrusted code on a
host where that matters.

**3. BUILT (2026-08-06): filesystem-only bubblewrap on Linux.** `RunOptions.confine` wraps the
unchanged permission jail in a mount namespace (`sandbox.ts`), `SandboxSpec.confiner` records which
one bounds it, and the chat PREFERS the confined jail, falling back with the record naming what
actually ran. The broker takes it through `BrokerOptions.run.confine`, so a workspace agent's
entrypoint is confined on the same terms.
The probe trap is cleared: language now follows `spec.language`, spawn follows the backend, and an
unnamed language still defaults to the backend's runtime so existing bubblewrap specs keep their
Python probes. An existing guard caught the first attempt at that rule, which had turned
`language: "unknown"` into a JavaScript probe fed to a Python interpreter.
Three cases in `extensions/conformance/workspace.test.ts` (the confiner holds while net stays denied
by Deno's flags; a confined jail is probed in JavaScript and every claim holds; the records differ
and say which confiner), plus two in `smoke-runners.ts` asserting the chat serves the confined jail
and that the fallback does not pretend to be one.

**What building it taught, and it is the third time this session:** a component that needs a
temporary file cannot assume the system temp directory. The import probe writes a canary, the chat's
exec worker holds `--allow-write=<workspace root>` and nothing else, so the probe could not write,
correctly reported the claim UNVERIFIED, and confinement silently never happened. The failure was
right and the cause was invisible; `probeSandbox` takes a `scratchDir` now. The same shape produced
`bootRoot` in the broker and the empty-`--workspace-root` bug in `openTree`.

**4. BUILT (2026-08-06), and NOT executed by its author.** `sandboxExecProfile` builds the profile,
`RunOptions.confine: "sandbox-exec"` runs the jail under it, and `defaultConfiner()` picks by
platform so the chat reaches for Seatbelt on macOS and bubblewrap on Linux. Everything below was
verified by hand on a Mac first; the code is that verification transcribed.
**The implementer was on Linux and could not run it.** So the tests split deliberately: the profile
BUILDER is a pure function checked on every platform (the dyld import is present, paths are
resolved through a real symlink, a path that could close an SBPL string is REFUSED rather than
escaped), while the case that actually runs a confined jail is gated on `Deno.build.os === "darwin"`
and skips elsewhere. The builder is where a regression would land; the run is where the guarantee
is, and only a Mac can report it. Three plants proved the pure cases (drop the dyld import, drop the
realpath, accept an injecting path).

**A Mac has now reported it (2026-08-06, same day).** `deno task extensions` on macOS 26.4.1: 109
passed, 0 failed, the darwin-gated case included ("the Seatbelt profile actually closes the import
hole", 28ms). The `HOME: "/tmp"` in `spawnDeno` also held up: jailed runs put Deno's own cache
churn under `/tmp/Library/Caches/deno` and the machine's real `~/Library/Caches/deno` was verified
untouched, which matters because the by-hand verification had corrupted it (see the trap below).

VERIFIED on a real Mac (macOS 26.4.1, Deno 2.9.5, arm64): the
module-loading hole reproduces there, and a filesystem-only SBPL profile closes it while
workspace-relative imports keep working. Overhead is ~6ms (bare jail 10.3ms median, confined
16.0ms). The "fiddly and version-sensitive" part has an Apple-maintained answer: a naive
deny-by-default-reads profile SIGABRTs every binary, because dyld's bootstrap (libignition) needs
`file-read*` on the literal `/` and `file-map-executable` on the cryptex graft points, and
`(import "dyld-support.sb")` supplies exactly that, revved by Apple with the OS. The working shape:

```scheme
(version 1)
(allow default)                     ; net/env/run/write stay denied by Deno's flags
(deny file-read*)
(import "dyld-support.sb")          ; dyld/libignition bootstrap, Apple-maintained
(allow file-read-metadata)
(allow file-read*
  (subpath "/usr/lib") (subpath "/usr/share") (subpath "/System")
  (subpath "<deno binary dir>")
  (subpath "<workspace, realpath'd>")
  (subpath "/dev"))
```

Traps for the implementer, all hit during verification:
- Profile paths must be RESOLVED paths: the sandbox matches on vnodes, `/tmp` is a symlink to
  `/private/tmp`, so an un-realpath'd workspace path silently misses.
- `dyld-support.sb` is labeled Apple System Private Interface; importing it by name is still the
  right call, since the hardcoded-cryptex-paths alternative already broke during this test.
- The global `(allow file-read-metadata)` leaks file EXISTENCE everywhere. Acceptable, but weaker
  than bwrap's mount namespace, which hides everything; the sandbox record must say so.
- SBPL `(trace ...)` is dead on modern macOS; iterate via the crash reports in
  `~/Library/Logs/DiagnosticReports` instead.
- `DENO_DIR` is not needed under `--no-remote`; only the binary's own directory is.
- A confined child MUST get a cwd inside the profile's roots. It inherits the spawner's cwd
  otherwise, and Deno dies at startup on getcwd before any code runs; every probe then reports
  unverified and the worker silently falls back to the unconfined jail, which is how the first
  real exec-worker boot on a Mac ran unconfined while the conformance case (which passes a cwd)
  stayed green. `spawnDeno` now defaults the cwd to the Deno binary's directory.
- A cwd is NOT optional under `sandbox-exec`, unlike the other two backends. Guarded by "a confined
  jail with NO cwd still starts", macOS-gated, so it reports on a Mac rather than in CI: the failure
  is a jail that never starts, every probe claim then reads UNVERIFIED, and the worker falls back
  silently.
- `materialize` must write to the root it was GIVEN, never the resolved one: a caller's
  `--allow-write=<root>` names the literal path, and on macOS every temp dir sits behind a symlink.
  This broke every workspace run there, confined or not. Guarded by "materialising writes to the
  root it was GIVEN", which runs a real subprocess under that grant and FAILS ON LINUX TOO, because
  Deno checks the literal path on both platforms. A macOS-discovered bug with a cross-platform
  guard, which is the shape to aim for.
- The profile above bounds READS ONLY, so a jailed Deno still WRITES its global caches
  (`~/Library/Caches/deno/*_cache_v2`, written regardless of `--no-remote`), and
  writable-but-unreadable SQLite corrupts them for the whole machine (`SQLITE_IOERR_SHORT_READ`
  522 on every later `deno` invocation; Deno's own recovery deletes the main db but not the
  `-wal`/`-shm` siblings, so it never heals). Happened during the by-hand verification, which
  inherited the real `$HOME`; recovery is deleting the full db triples. The built code avoids it
  by construction (`clearEnv` + `HOME: "/tmp"` in `spawnDeno` moves the churn to
  `/tmp/Library/Caches/deno`), so this trap now binds anyone running the profile by hand or
  changing that env line, not the shipped path.
  FIXED in the implementation: `RunOptions.cacheDir` gives a confined jail a directory it can BOTH
  read and write (the chat puts it under its workspace root), the Seatbelt profile read-allows it,
  and the bubblewrap jail points `DENO_DIR` inside its own tmpfs. With no writable directory
  available the cache is disabled rather than pointed at the host's, which is slower and safe.
  Guarded by "a confined jail's cache is READABLE as well as writable, or it corrupts".

**PYTHON IS LINUX-ONLY, and stays that way (decided 2026-08-06).** `run_python` is served only where
`bwrapSandbox` verifies, and bubblewrap is a Linux tool, so a Mac publishes no `run_python` at all:
the language is ABSENT rather than broken, which is what the capability-name design is for.

Phase 4 does not carry over, and the reason is the whole point of the confiner/runtime split. The
Deno profile is `(allow default)` plus `(deny file-read*)`, and that is safe ONLY because Deno's
flags already deny net, env, run, ffi and write: the profile had one job, closing the single channel
the permission model missed. Python has no permission model, so the same profile around `python3` is
an interpreter with `(allow default)` — full network, full spawn, full write. A macOS Python jail
would need `(deny default)` with an explicit allowlist across reads, writes, network, process-exec,
mach lookups and sysctls: a different kind of profile, in exactly the territory where one reads
correctly and is not. On Linux bwrap covers every axis with one flag set, which is the asymmetry.

Two things that would make it tractable IF it is ever wanted, recorded so the next person does not
re-derive them: `probeSandbox` already tests those axes in Python (network, processes, env,
filesystem, writable), so a candidate profile would be verified rather than trusted and a wrong one
would refuse to serve; and the spec split already accommodates it, as a new spec with
`confiner: "sandbox-exec"` and its own probed claims. There is also a second gate before any of that
matters: stock macOS ships no usable `python3` (since 12.3 `/usr/bin/python3` is a stub that prompts
for Command Line Tools), so it would depend on CLT or Homebrew as well as on the profile. NOT
verified here; a `python3 -c 'print(1)'` on a clean Mac settles it.

**5. Windows stays unconfined, and the record says so.** No equivalent that is worth the dependency.
`importsConfined: false` is the honest answer, and the operator sees it.

## Open questions

1. **Does filesystem-only bwrap actually work on the CI runner?** STILL OPEN, and now answerable:
   phase 3 is built and its cases skip where bubblewrap is unusable, so the next CI run reports it.
   The reasoning is unchanged (the AppArmor failure was specific to configuring loopback inside a
   new net namespace, and this variant never creates one), but reasoning is not a measurement.
2. **ANSWERED (2026-08-06): `sandbox-exec` works.** Verified on macOS 26.4.1; see phase 4 for the
   profile, the measurement and the traps. The maintainability worry is largely retired by
   `(import "dyld-support.sb")`, which moves the version-sensitive part onto Apple.
3. **Should a confined jail be REQUIRED for anything?** Nothing requires it today. The natural first
   customer is the compartment story: a grant could bind `importsConfined: true` for work over
   protected data, which is a policy question for
   [architecture-workspace-agents.md](architecture-workspace-agents.md) rather than for this plan.
