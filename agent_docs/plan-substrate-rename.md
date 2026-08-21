# Plan: retire "substrate" for the runtime/space split

**Status: DONE 2026-08-18, executed the same day.** The word survives only in `notes/`
(provenance) and in this doc. Analysis 2026-08-18. The word "substrate" left the
project's vocabulary: it is a low-frequency word that does not travel outside domain expertise,
in English or in translation. There is no single replacement. The job splits between two words
the project already owns, both common everywhere: **the RUNTIME is the software** (what you
start, what enforces), **the SPACE is what agents share** (what applications build on and express
features through). Rename per SENSE, not per string.

## Inventory

216 occurrences across 84 files, ALL prose: no code identifiers, no wire vocabulary, no test
names. The public surface barely uses it (7 on the docs site, 3 in `openapi/radia.yaml`
description prose); the weight is internal (CLAUDE.md 21, gotchas.md 12, the research docs ~30,
example READMEs). One filename: `research-substrate-lessons.md` (~6 inbound links). `notes/` is
provenance and stays untouched.

The front door already says both words: "content-routed coordination runtime" (CLAUDE.md line 1,
the site, `llms.txt`), and "the space" is the central user-facing noun (the hero diagram labels
it, the console has a Space tab, the tuple-space heritage names it).

## Why a split rather than a replacement word

"The runtime" already has three established senses, one of them enforced: the TIER (`src/core` +
`src/server` + `src/storage`, the word the layering rules depend on: "the runtime imports
neither a surface nor an extension", `test/layering.test.ts`), the ENVELOPE
(`RuntimeMeta`, "runtime-authoritative metadata", frozen wire vocabulary), and the ambient one
(Deno is "a runtime"). A blind substrate->runtime rename makes "conventions built on the runtime
must never import the runtime" self-contradicting prose (`layering.test.ts:37-41` holds both
halves today, with two words).

The split DISSOLVES that collision instead of managing it: extensions are built ON THE SPACE
(they speak `/v0` to one) and never import THE RUNTIME (the code). Both sentences get more
precise than they are now.

Rejected single replacements: "platform" (vague, vendor-flavored; kept only as the tier word
below), "engine" (implies it does the computing; model calls stay outside by invariant),
"kernel" (reads as in-process), "fabric"/"bus"/"backplane" (worse jargon, and "bus" smuggles in
sender-chosen routing), "infrastructure" (names a category, not the thing).

## The four senses, and the mapping

| # | Sense | Example | Replacement |
|---|-------|---------|-------------|
| 1 | Product noun (~150 sites) | "a coordination substrate" | "runtime" — safe swap, matches the front door |
| 2 | The MEDIUM apps express through | "express features through the substrate, not beside it"; "substrate-provided knowledge"; "letting the substrate route the conversation" | "the space" / "as records" — NEVER "the runtime", which reads as "put it in `src/`", the opposite of the principle |
| 3 | Below-the-app tier INCLUDING extensions | "the substrate half in extensions", "substrate-tier prerequisite", "a substrate gap vs one app's problem" | explicit tier names ("an extension-tier change") or "the platform" — NEVER "runtime": extensions are definitionally not the runtime |
| 4 | Category word in positioning | "the property to look for in any substrate"; "a framework where this is a substrate" (research-positioning.md) | recast on the space framing: "a framework tells agents what to do; a space is where they find each other". Sharper than the substrate contrast, not weaker |

Sense 2 is an improvement, not a concession: "through the space" is concrete, in-world, and
already what every diagram shows.

## The hard rules

After the pass, "the runtime" in any layering context must still mean ONLY `src/`, and "built
on" language attaches to THE SPACE, never to the runtime. Verify by rereading
`layering.test.ts` comments, CLAUDE.md's `extensions/` row, and `extensions/README.md` after the
rename.

Bare "space" is a generic word, so FIRST MENTION anchors it: a page or doc that has not named
the object yet says "a Radia space" or "the shared space", and bare "the space" is fine after
that, the way "the database" is fine in a Postgres doc. The site's hero already models this (the
diagram labels "the space" before prose uses it). A space is the COORDINATION BOUNDARY (one
space, one authorization domain, one event chain); copy that drifts toward "spaces" as a
workspace-like feature has lost that anchor.

## Order

1. Sense-1 sweep (safe swaps to "runtime"), file by file, largest first: CLAUDE.md, gotchas.md,
   the research docs, example READMEs, docs site, openapi descriptions, source comments. Where a
   sense-1 sentence is really about the shared medium, prefer "the space" over "runtime" even
   here; the tell is a verb like route, match, express, discover.
2. Sense-2 recast: CLAUDE.md's design-principle section ("express features through the space,
   not beside it") and its echoes in gotchas.md and the research docs.
3. Sense-3 recast: the extension/plan docs (~10 sites), each sentence rewritten with explicit
   tier names.
4. Sense-4 recast: research-positioning.md (including the Flock and PatchBoard entries),
   docs/why.html, docs/inspection.html, on the space framing.
5. Rename `research-substrate-lessons.md` to `research-app-lessons.md` (the title is "what two
   applications taught" the project, so the file is named by its subject), update the ~6 inbound
   links, retitle in the same move.
6. `deno task test:quick` (docs links, site claims); grep for the word to confirm only `notes/` and
   deliberate quotations remain.
