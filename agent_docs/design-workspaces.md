# Workspaces for code generation (design)

How a multi-file working tree lives in a space, and the relationship to git. Nothing here is built.
The two prerequisites are: attempts link (`attempt` / `retryOf` on `tool_call`), and a run can be
judged against a stated expectation (`check` records). Both shipped; see
[../examples/chat/README.md](../examples/chat/README.md).

> **Status: the manifest half is BUILT** (`extensions/ts/workspace.ts`, Phase 1 of
> [plan-workspaces.md](plan-workspaces.md)): the `workspace` kind, per-file artifacts, `treeDigest`,
> `basedOn`, write-time path validation, content-keyed writes, and safe MATERIALISATION (Phase 2:
> lexical revalidation plus a realpath containment check per file, with the tree's taint labels
> carried on the manifest so one parent edge speaks for the whole tree). Measured, a manifest caps at
> ~6 300 files against the 1 MiB record limit, which SETTLES the dependency question below in favour
> of an artifact beside the manifest. Write-back, fork detection and GIT EXPORT are built too
> (`captureWorkspace`/`commitWorkspace`, `forksOf`, `exportWorkspaceGit`); import is refused rather
> than pending, for the reason under "Git" below.
>
> Recorded in
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
- Settled by the arguments above
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
- The git SHA-1 is **recomputed at export, never stored**. It was going to be a "secondary,
  non-authoritative index" on each tree entry; that is a field which can silently disagree with the
  authoritative content, and a convenient field eventually gets trusted. The export path already
  writes the objects, so it can hash them in the same pass.
- Export to a real git repository is **one-way**. There is no import.

## Shape: manifest plus per-file artifacts

A `workspace` record is a manifest: `{name, conversationId, owner, treeDigest, basedOn, ignore,
files: [{path, mode, digest, artifactId}]}`, projected latest-wins like `procedure`. Each file's
bytes are an ordinary artifact.

This works because blobs already dedupe by digest (`blobs.has(digest)` before write), so a
one-character change stores one file rather than a tree. Note the asymmetry: each `putArtifact`
still writes a new RECORD even for identical bytes, so a workspace writer must content-key its
writes or the record count grows per attempt. That is the registry stopping rule
([CLAUDE.md](../CLAUDE.md)) applying to a new consumer.

`treeDigest` is sha256 over the sorted `path → digest` list. It exists so a `check` can be attached
to a TREE rather than to a call id, which is what turns a verdict into an attestation of a specific
reproducible input.

**BUILT: the worker recomputes, and refuses on disagreement.** What follows is why.

**Who computes `treeDigest` decides whether any of that is worth anything.** An artifact's `digest`
is server-computed and is a RESERVED field a client cannot set (`ARTIFACT_RESERVED_FIELDS`,
`src/core/kinds.ts`), so the bytes and their address cannot disagree. A manifest is an ordinary
record, so its `treeDigest` and its `path → digest` list are whatever the writer says. A lying
writer could bind a verdict to a tree that does not match the files, and the attestation would
inherit that lie through a middle link nobody checked.

Two places could close it, and the cheap one is right. The RUNTIME could verify at put time, and
kind-aware body validation is an established pattern here (`validateKindDef`, `validateGrantDef`,
`validateArtifactFields`) — but verifying a tree means fetching every referenced artifact on every
manifest write, which is new, unbounded and on the hot path. Instead **the worker that writes the
`check` recomputes `treeDigest` from the artifacts it materialised**, and refuses to render a
verdict if it disagrees. That needs no new mechanism, costs a hash over bytes already in hand, and
puts the recomputation exactly where the claim is made. It belongs in v1, not later: a `treeDigest`
nobody recomputes is decoration.

**A vendored dependency set belongs BESIDE the manifest, not inside it.** Measured, a body holds
20 000 entries at 3.2 MiB and 39 ms, so inlining a `node_modules` tree works mechanically. It should
still not be done, for the reason performance does not show: that body is written per attempt,
grows without bound, and is a BODY, so nothing can erase it. Making the dependency set its own
content-addressed artifact, referenced by digest, keeps the manifest small and bounded, dedupes it
across every workspace that shares it, and makes it erasable like any other payload. The source
tree, which is human-scale and the thing a person reads, stays inline.

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

**BUILT**, as described: `extensions/ts/git.ts` (`exportWorkspaceGit`), run with
`radia workspace-git`. An erased payload fails the export by default and is OMITTED under
`--partial`, never replaced: the commit that lost an entry names it in its own trailers and the
repository's description carries the list, so the gap travels with the artifact rather than living
in a console line. One commit per manifest version, `basedOn` as the parent chain, every
head a branch, the sha1 recomputed and discarded. Trailers (`Radia-Workspace`, `Radia-Tree-Digest`,
`Radia-Based-On`) lead each commit back to the record it came from. A BARE repository, so `git
clone` does the checkout: a working copy needs a valid `.git/index`, and emitting one wrong produces
a repository where `git status` lies.

So git is a PROJECTION: emit a loose-object repository on demand, one commit per attempt, the chain
as history, and a person can `git log`, `git diff` and `git bisect` an agent's debugging session
with tooling they already have. Nothing downstream may depend on it being current or complete.
Export only, because import means accepting trees whose history git can rewrite, which reopens the
mutability problem from the outside.

**The export is a bisect target, not a pull request.** One commit per attempt is auto-commit-on-save
granularity, so the log reads like a fixup-spam branch and the urge to squash it will be strong.
Resist: the faithful history IS the audit product, and noisy linear history is exactly what
`git bisect` wants. Anyone wanting a readable summary should get it from a synthesis over the
records, not from rewriting the export.

## The three hard parts

**Materialisation and write-back are BUILT** (`materialize`, `captureWorkspace`,
`commitWorkspace`). What follows is the reasoning behind them; the quota, the ignore list and the
symlink rule all landed as described.

**Write-back is a capability increase.** The sandbox has no write permission today. A workspace
means `--allow-write=<tmpdir>`, one fresh directory per attempt, deleted after. Contained but real:
model-written code can create files. Needed before it ships: a size and count quota (a program that
fills the disk is a trivial denial of service), symlink escape out of the temp directory, and a rule
for which files come back.

For that last one the honest answer is a tree diff, hash before and hash after, store the
difference. "Everything in the directory" captures build output and caches; "what the program says
it changed" trusts the program. It is the same operation `git status` performs — and the same
comparison supplies the missing third option the first draft of this section did not have:
**an ignore list**, `.gitignore` by another name, as an `ignore` field on the manifest. Thirty years
of tooling say a working tree needs one, and vendored dependencies make it mandatory rather than
convenient.

**MATERIALISATION is the more dangerous direction, and it is the one that looks safe.** Execution
runs untrusted code inside a jail. Materialisation runs the TRUSTED worker over model-influenced
paths, outside any jail, writing files. A manifest entry naming `../../etc/…`, an absolute path, a
path colliding with `.git` in an exported repo, or a name whose case folds onto one on a
case-insensitive filesystem is a write the sandbox never sees.

This is `git checkout`, and git has already paid for every one of these: path traversal via `..` in
tree entries, the `.Git`/NTFS case-folding family (CVE-2014-9390), symlink-then-write-through-it
during checkout, and a long tail of tree-entry names nothing expected. **Borrow git's validation
list wholesale rather than rediscovering it one incident at a time.** Path normalisation and
rejection rules on manifest entries belong here, beside the quota, and so does deciding what `mode`
admits (regular and executable, presumably; not setuid, not device nodes).

**Dependencies are the fork in the road**, not an implementation detail:

- Keep `--no-remote`: dependency-free code. Limits what "project" means, preserves the invariant.
- Vendored dependencies as artifacts: expensive to move, and genuinely a FEATURE, because the
  dependency set becomes part of the audited content. "What exactly was in scope when this ran" is
  a question nothing in the npm world can answer.
- An allowlisted registry proxy: gives the sandbox network. This breaks the property that makes the
  sandbox defensible. Do not.

The vendored option is the only one consistent with the thesis in
[research-applications.md](research-applications.md) §5, and it is understated above: dependency
trees are near-identical across workspaces, and blobs dedupe by digest, so the storage cost amortises
to almost nothing after the first workspace. That is the opposite of vendoring in git, where every
version bump writes a full new copy into history forever.

**Choosing it pulls the materialisation cache into v1.** A vendored `node_modules` is thousands of
files, which is squarely the "dominant at 10,000" regime in the cost note below. So the
content-addressed hardlink cache stops being a later optimisation and becomes a prerequisite of the
fork this design takes. One property it must have, learned from git's alternates machinery: the
cache is **read-only**, enforced by permission bits. A cached object mutated in place poisons every
workspace hardlinked to it.

**Concurrency: detection, not merge, and the loss is not what it sounds like.** Two agents on one
workspace both read the same manifest and write successors, and latest-wins picks one. There is no
compare-and-swap primitive (idempotency keys are not one).

Two corrections to the obvious reading, both of which make this better than "unsupported":

- **Nothing is lost.** The overwritten manifest is still a record. In git terms this is a
  force-pushed branch on a repository whose reflog is permanent and never expires: the other tip is
  reachable, addressable and auditable forever. What is missing is not durability, it is *merge*.
- **Detection is nearly free, and git's answer is not CAS either** — it is fork detection plus
  explicit reconciliation. BUILT: a successor names its predecessor in `basedOn` AND takes it as a
  data parent, so the version chain is a graph; `forksOf` returns the heads, and more than one is a
  fork. One caveat learned in the building: the useful signal is "this workspace HAS more than one
  head", not "I just created a second one" — the latter misses the writer who lost the race and
  keeps working on a head nobody else can see.

So: **fork detection in v1, merge unsupported.** Saying multi-agent editing is unsupported does not
stop two agents from doing it, and silent divergence is the one outcome worse than either supporting
it or refusing it. The serial case needs none of this, because one agent iterating within a turn is
exactly the attempt chain.

**Cost note.** Materialisation is N file writes per attempt: fine at 50 files, dominant at 10,000. A
content-addressed cache directory keyed by digest, hardlinked in, is the standard fix and is easier
to design for than to retrofit.

## Where a tree's classification lives

**The manifest is the carrier; the union is the semantics.** Decided 2026-08-03, and both halves are
forced rather than chosen.

The union, because a jailed run is OPAQUE: it can read one file and write those bytes into another,
and nothing in the substrate sees it. So a changed file inherits the whole tree's labels, not its
own file's. Per-file inheritance would be more useful and would be a lie. Labels are therefore sticky
within a tree and come down only by declassify, which is what monotone means.

The manifest, because one edge already answers the question. `commitWorkspace` writes
`parentIds: [manifest.id]` and the exec worker's result names the manifest too, so `computeTaint`
unions the predecessor's labels into both with nothing explicit anywhere. Individual file artifacts
stay BARE on purpose: a label exists only where a lineage walk is too slow
([design-taint.md](design-taint.md)), and labelling every file as well is a denormalised copy of a
graph fact that can drift from it.

The cost is that the carrier is only as good as the edges. Any derived record that fails to name the
manifest loses the classification silently — the documented parent-edge hole, landing in a specific
place. That is the thing to test, not the propagation, which the runtime does.

### The trigger that reopens this

Manifest-only is the REVERSIBLE choice, not the permanently right one, and it is worth being exact
about which argument holds it up — because the obvious one does not.

*The argument that does not apply.* "A label exists only where a lineage walk is too slow"
([design-taint.md](design-taint.md)) presupposes that a walk exists. From a file artifact there is
none: the manifest references it as a BODY field, not a parent edge, so neither `lineage` nor
`children` connects the two. The rule was cited for this decision and does not reach it.

*The arguments that do.* Recovery exists by QUERY rather than by walk — an artifact's body carries
`workspace: <name>`, indexed, so `artifact → readWorkspace(name) → labels` answers an auditor, which
is the audience the taint design says should walk the log. And adding labels to file artifacts later
is purely additive and monotone: no migration, nothing invalidated. Removing them would not be. With
no barrier in use yet, the sparse option costs nothing and keeps the dense one available.

**Revisit the moment anyone wants a barrier at FILE granularity rather than tree granularity.**
`share_artifact` is where it will surface first: a capability URL for one file of a classified tree
serves bytes from a record carrying no label, and the recovery query fails there twice over — it
resolves the workspace NAME to the current head, whose labels may differ from the version that
artifact belonged to, and it is a per-candidate query on a path measured at ~125x the claim itself.
At that point label the file artifacts too. Until then, do not.

One related asymmetry to keep in view. The union rule is FORCED for a run (the jail is opaque, so
bytes can move between files unseen) and merely CHOSEN for an edit, where the substrate performs the
change and knows which artifact the bytes came from. They were unified so that one record type has
one propagation rule. If tree-scope saturation ever becomes the problem the boolean was — every
workspace carrying every label, and an allowlist grant able to claim none of them — the edit path is
where to split first, because it is the one where per-file inheritance is sound.

## Editing in place

Planned, not built: [plan-workspaces.md](plan-workspaces.md) §10. The shape is settled — an exact
`oldString` → `newString` match, never a regex (a search predicate that is code), a diff (a grammar
between the model and the file) or a line range (breaks under the concurrent writers this design
assumes); a non-unique match is an error rather than a first-match; a BATCH of edits is one version,
because a version-per-edit turns `versions` from "how many attempts" into "how many keystrokes"; and
an optional `expectDigest` makes the lost update an error instead of a merge.

Two things worth knowing before that lands. It is ERGONOMICS rather than capability — a run with
`write: true` can already edit a file — so it does not justify a patch format or a merge strategy.
And the hazard it closes is not the token cost that motivates it: `writeWorkspace` builds the
manifest from exactly what it is passed, so a partial save truncates the tree rather than patching
it, and the current instruction ("save the whole tree again with your fix") fights the model's
economics until something removes the incentive.

## What this buys that git does not

**Lead with per-file erasure.** Anyone who has run `git filter-repo` or BFG to purge a leaked
credential knows the blast radius: every downstream SHA changes, every fork force-pushes, every
clone is invalidated, signed tags die. Erasing one file from one attempt while the tree digest still
verifies and the history still reads is the single worst operational chore in git, gone.

It works because each file is an artifact, so `shredArtifact` destroys one payload while the manifest
still records that a file with that path and digest existed (see
[design-data-model.md](design-data-model.md), "Erasure"). The single-archive shape loses this
completely, which is the strongest reason to reject it.

**And that surviving record is the caveat this section has to carry, because it sits right under the
headline claim.** The manifest keeps the path AND the plaintext sha256 of the erased file, in a body
that has no erasure path of its own — so `credentials/prod-db.txt` outlives its own payload, and
anyone with a candidate secret and read access to the manifest can hash it and confirm that exact
content was in that tree. A workspace is the WORST case for this in the whole system: the artifact
record alone leaks the digest, and the manifest adds the filename next to it, which is often the
more telling half.

So the operational chore is genuinely gone and the guarantee is narrower than "the leaked credential
is erased". A shredded build output, dataset or document is gone in every practical sense. A shredded
credential is unreadable and still confirmable, and its PATH is plaintext forever. If the tree ever
held something that cannot survive being confirmed, the remedy is not a better shred: it is that the
value should not have been committed to a space, exactly as with git. What this design removes is the
blast radius, not the disclosure.

Then: every file version content-addressed and attributable to a RUN; the dependency set inside the
record, which a lockfile only claims (postinstall scripts, registry drift and yanked versions all
mean a lockfile does not prove what bytes ran); grants scoping which workspace an agent may touch,
which is what branch protection keeps approximating badly, since a git hook dies to `--no-verify`
and a pre-receive hook is one repository's shell script; and taint tracking whether a file descends
from untrusted input.

What this does NOT buy: incremental build caching, LSP feedback, merge, blame. Git does the storage
model better and has thirty years of tooling. The honest framing is that this is not a better git.
It is a working tree whose every state is a record the runtime can authorize, attest and erase.

## Settled by the arguments above

Two of these were listed as open and are not; leaving them open contradicts the sections that
motivate them.

- **A `check` attaches to a `treeDigest`.** `treeDigest` exists FOR that, so it is load-bearing and
  in v1, along with the worker-side recomputation that makes it mean anything.
- **Failed attempts keep their trees.** The stated purpose is capturing the debugging session, and
  per-file dedup means a failed attempt costs only its changed files. Discarding them deletes
  exactly the history this design exists to preserve; retention and per-file erasure are the
  pressure valve, not truncation.

## Open questions

1. **Vendored dependencies, or dependency-free?** Open in COST, not in direction: vendored is the
   only thesis-consistent option, so what is actually open is the cache design it forces (see "The
   three hard parts").
2. **Conversation-scoped or owner-scoped?** The genuinely open one. It decides the grant pattern,
   and identity scope is the chat's default. Whichever is chosen, the suite must exercise BOTH
   postures from day one: `{owner}` and `{conversationId}` hide different failures, and testing one
   of a documented either/or is how two bugs shipped in the chat (see [gotchas.md](gotchas.md)).
3. **Does the runner enforce the ignore list, or the worker?** A program that writes into an
   ignored path has done nothing wrong; a worker that stores it has. Worker-side is the answer, but
   it interacts with the quota (ignored output still fills a disk).
