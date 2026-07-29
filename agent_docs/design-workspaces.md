# Workspaces for code generation (design)

How a multi-file working tree lives in a space, and the relationship to git. Nothing here is built.
The two prerequisites are: attempts link (`attempt` / `retryOf` on `tool_call`), and a run can be
judged against a stated expectation (`check` records). Both shipped; see
[../examples/chat/README.md](../examples/chat/README.md).

> **Status: design, unscheduled.** Recorded in
> [plan-milestones.md](plan-milestones.md) as a later goal. The decisions below are made, so the
> open work is implementation and the four questions at the end.
>
> A workspace and a second LANGUAGE are the same project: a multi-file tree needs an entrypoint
> declaration, and that is per-language. Read [design-execution.md](design-execution.md) with this.

## Contents
- Why a workspace at all
- The decision
- Shape: manifest plus per-file artifacts
- Git: what to borrow, what to emit, what to refuse
- The three hard parts
- What this buys that git does not
- Open questions

## Why a workspace at all

The chat's sandbox is a single-file JS evaluator: program on stdin, `--no-remote`, no writes, no
npm. Real code generation iterates on a PROJECT, and the loop is write, run, read the error, fix,
rerun across several files. That is a sandbox capability gap, not a substrate one: measured locally,
a coordination round trip is ~30ms and a sandbox spawn ~27ms against a model round of 1-10 SECONDS,
so routing this loop through records costs about 1% of an iteration (see
[gotchas.md](gotchas.md)). The medium is not the constraint. The missing thing is somewhere for a
program to live.

## The decision

**Store Radia-native, shape git-compatible, export git-real.**

- **sha256 stays authoritative.** Every attestation rests on it.
- The tree structure follows git's (mode, name, sorted entries) so it is mechanically convertible.
- A tree entry MAY carry the git SHA-1 as a **secondary, non-authoritative index**: cheap to
  compute, useful for `git clone`, never the thing a verdict or a signature rests on.
- Export to a real git repository is **one-way**. There is no import.

## Shape: manifest plus per-file artifacts

A `workspace` record is a manifest: `{name, conversationId, owner, treeDigest, files: [{path,
mode, digest, artifactId, gitSha1?}]}`, projected latest-wins like `procedure`. Each file's bytes
are an ordinary artifact.

This works because blobs already dedupe by digest (`blobs.has(digest)` before write), so a
one-character change stores one file rather than a tree. Note the asymmetry: each `putArtifact`
still writes a new RECORD even for identical bytes, so a workspace writer must content-key its
writes or the record count grows per attempt. That is the registry stopping rule
([CLAUDE.md](../CLAUDE.md)) applying to a new consumer.

`treeDigest` is sha256 over the sorted `path → digest` list. It exists so a `check` can be attached
to a TREE rather than to a call id, which is what turns a verdict into an attestation of a specific
reproducible input.

**Rejected alternatives, and why.** One record per file avoids large bodies but makes reading the
workspace a registry read that must page to exhaustion, putting the loop's correctness on the
single most repeated bug in this codebase. A single archive artifact per snapshot is simple and
throws away everything the substrate offers: no per-file dedup, no "which attempts touched this
file", opaque to lineage, and it collides with the 32 MiB artifact cap. It also destroys erasure
granularity (see below), which is the strongest argument against it.

## Git: what to borrow, what to emit, what to refuse

The correspondence is close, and one row of it is already implemented:

| git | Radia |
|-----------|--------------------------------------------------------|
| blob      | artifact (content-addressed, deduped by digest)         |
| tree      | the manifest's sorted `path → digest` list             |
| commit    | the attempt record: `treeDigest` + `retryOf` + `created_by` + rationale |
| ref       | a latest-wins registry projection (`activeByKey`)       |

A git ref is a mutable pointer over immutable objects, which is exactly the shape `activeByKey`
already has. The project implements git's ref model; it does not call it that. And a commit maps 1:1
onto an attempt, so `retryOf` chains ARE parent chains.

**Emitting real git objects needs no dependency.** Verified: `crypto.subtle` does SHA-1,
`CompressionStream("deflate")` produces a proper zlib stream, and the resulting object hash matches
`git hash-object` exactly. Loose blob/tree/commit writing is on the order of 60 lines, with no `git`
binary and no `--allow-run`. Packfile READING is where git's real complexity lives (delta chains,
negotiation) and is not needed for export.

**Never make git objects the storage of record.** Two structural reasons:

- **Hashing.** Git is SHA-1 over `blob <len>\0<content>`; the invariant here is sha256 over
  plaintext. Adopting git's hash puts SHA-1 into the attestation chain, and chosen-prefix SHA-1
  collisions have been practical since 2017: a collision on a tree object is precisely the attack an
  audit story must withstand. Git's SHA-256 mode exists and almost nothing interoperates with it,
  which forfeits the only reason to use the format.
- **Mutability.** `gc` deletes unreachable objects, rebase rewrites history, refs move. Records are
  immutable after commit and the one erasure path is deliberate, recorded and operator-only. A store
  whose history can be rewritten cannot back that.

So git is a PROJECTION: emit a loose-object repository on demand, one commit per attempt, the chain
as history, and a person can `git log`, `git diff` and `git bisect` an agent's debugging session
with tooling they already have. Nothing downstream may depend on it being current or complete.
Export only, because import means accepting trees whose history git can rewrite, which reopens the
mutability problem from the outside.

## The three hard parts

**Write-back is a capability increase.** The sandbox has no write permission today. A workspace
means `--allow-write=<tmpdir>`, one fresh directory per attempt, deleted after. Contained but real:
model-written code can create files. Three things need answering before it ships: a size and count
quota (a program that fills the disk is a trivial denial of service), symlink escape out of the temp
directory, and which files come back. The honest answer to the last is a tree diff, hash before and
hash after, store the difference. "Everything in the directory" captures junk;
"what the program says it changed" trusts the program. This is the same operation `git status`
performs, which is a further argument for borrowing the model.

**Dependencies are the fork in the road**, not an implementation detail:

- Keep `--no-remote`: dependency-free code. Limits what "project" means, preserves the invariant.
- Vendored dependencies as artifacts: expensive to move, and genuinely a FEATURE, because the
  dependency set becomes part of the audited content. "What exactly was in scope when this ran" is
  a question nothing in the npm world can answer.
- An allowlisted registry proxy: gives the sandbox network. This breaks the property that makes the
  sandbox defensible. Do not.

The vendored option is the only one consistent with the thesis in
[research-applications.md](research-applications.md) §5.

**Concurrency has no answer.** Two agents on one workspace both read the same manifest and write
successors; last writer wins silently. Latest-wins is right for a registry and wrong for a working
tree, and there is no compare-and-swap primitive (idempotency keys are not one). The serial case is
covered, because one agent iterating within a turn is exactly the attempt chain. Multi-agent editing
is a different problem and should be stated as unsupported rather than discovered.

**Cost note.** Materialisation is N file writes per attempt: fine at 50 files, dominant at 10,000. A
content-addressed cache directory keyed by digest, hardlinked in, is the standard fix and is easier
to design for than to retrofit.

## What this buys that git does not

Every file version content-addressed and attributable to a RUN; the dependency set inside the
record; grants scoping which workspace an agent may touch; taint tracking whether a file descends
from untrusted input; verdicts bound to a tree digest; and per-file erasure.

That last one deserves stating. Because each file is an artifact, `shredArtifact` erases one file
from one attempt while the manifest still records that a file with that path and digest existed, the
tree digest still verifies, and the history still reads (see
[design-data-model.md](design-data-model.md), "Erasure"). Git has no equivalent: erasing a blob from
history means rewriting every commit that followed. The single-archive shape loses this completely,
which is the strongest reason to reject it.

What this does NOT buy: incremental build caching, LSP feedback, merge, blame. Git does the storage
model better and has thirty years of tooling. The honest framing is that this is not a better git.
It is a working tree whose every state is a record the runtime can authorize, attest and erase.

## Open questions

1. **Vendored dependencies, or dependency-free?** The fork above. Everything else follows.
2. **Does a `check` attach to a `treeDigest`?** If yes it is load-bearing and belongs in v1.
3. **Conversation-scoped or owner-scoped?** Decides the grant pattern; identity scope is the chat's
   default.
4. **Do failed attempts keep their trees?** Keeping them makes "what did it try" complete and grows
   storage per attempt. Discarding them loses exactly the history this design exists to capture.
