# Plan: confining the filesystem, per platform

> Status: RESEARCH DONE (2026-08-06), nothing built beyond the honest record. The defect is package
> T in [plan-audit-remediation.md](plan-audit-remediation.md); this is the plan to close it.
> Everything below marked "measured" was run against the real jail on Linux. The macOS row is NOT
> measured and says so. Read [design-execution.md](design-execution.md) first: the language question
> is an isolation question, and this is the isolation half.

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

Deno will not parse a non-`.json` file as JSON however it is asked. So storing this space's own
secrets under a non-module extension puts them out of reach on EVERY platform with no jail at all.
That is the portable half of the macOS answer, and it is worth doing even if every phase below
ships.
What it does NOT do: protect the operator's OTHER json. A developer machine has plenty that
matters (browser `logins.json`, assorted `~/.config/**/*.json`), so this bounds our blast radius
and leaves the general hole to a real confiner.

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

Ordered cheapest first, and 1 and 2 are worth doing whatever happens to the rest.

**1. `--no-config --no-lock` in `jailArgs`.** One line, every platform, closes the config finding
above. No behaviour to trade: nothing legitimate in a jail wants a config file it found in the
tree.

**2. Radia's own secrets stop being `.json`.** The blob KEK (`src/paths.ts` `defaultKekPath`) and the
credentials file. Renaming is not the whole job: both are read by name in more than one place, and
the credentials file is shared with the CLI, the MCP adapter and the Python SDK, so this is a
compatibility question (read the old name, write the new one) rather than a rename.

**3. Filesystem-only bubblewrap on Linux.** A `confine` option on `denoSandbox`, the split above,
and the probe taught to test a JS jail under a non-JS-implying backend. CI will say whether the
runner can use it, which is the question today's backend answers with "no".

**4. `sandbox-exec` on macOS.** `/usr/bin/sandbox-exec -p '<SBPL profile>'`, filesystem-only. It is
built in, needs no dependency, and is what Chrome, Bazel and Nix use. Deprecated by Apple in 10.8
and still present and working since. The profile has to permit everything Deno itself reads (its
binary, the dyld shared cache, `DENO_DIR`, `/dev/urandom`), which is fiddly and version-sensitive.
NOT VERIFIED: the research above was done on Linux, and nobody has run this on a Mac. The probe
machinery would answer it in one run.

**5. Windows stays unconfined, and the record says so.** No equivalent that is worth the dependency.
`importsConfined: false` is the honest answer, and the operator sees it.

## Open questions

1. **Does filesystem-only bwrap actually work on the CI runner?** Measured locally, reasoned about
   for CI. The AppArmor failure was specific to configuring loopback inside a new net namespace, and
   this variant never creates one. CI prints whether bubblewrap coverage is on; phase 3 turns that
   into an answer.
2. **Is `sandbox-exec` workable in practice?** Needs a Mac. If the profile turns out to be
   unmaintainable across macOS releases, the honest fallback is phase 5's posture plus phase 2's
   narrowing.
3. **Should a confined jail be REQUIRED for anything?** Nothing requires it today. The natural first
   customer is the compartment story: a grant could bind `importsConfined: true` for work over
   protected data, which is a policy question for
   [architecture-workspace-agents.md](architecture-workspace-agents.md) rather than for this plan.
