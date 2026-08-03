# Plan: workspaces and execution environments

Sequence and status. The reasoning lives in [design-workspaces.md](design-workspaces.md) (what a
working tree is, and the git relationship) and [design-execution.md](design-execution.md) (why the
language question is an isolation question). Read those first; this file assumes them.

> **Status: Phases 0-8 DONE.** Workspaces, write-back, `check`, fork detection, `sandbox` records,
> a second backend (bubblewrap), and selection by capability name (`run_javascript`, `run_python`).
> Phase 7 answered the selection question with neither of the two options it was written to choose
> between; see there. Phase 8 (git export) was added after the fact, from a request for git READ
> access: the analysis split it, and the object builder is the half that shipped.

## What this is for

Building a workspace is the first thing that will stress Radia's own model rather than exercise it.
The phases below are ordered to hit that stress EARLY and cheaply, so the ordering is by
model-risk, not by feature value. Each phase answers a question; a phase that ships code and answers
nothing is mis-scoped.

### The stresses, ranked

1. **Unbounded, unerasable bodies.** A manifest is the first realistic large-body consumer. Since
   the erasure boundary is "payloads are out of line so they can be destroyed, bodies are not so
   they cannot" (see [design-data-model.md](design-data-model.md)), a missing size limit was the
   mechanism by which unerasable data entered a space. **Bounded in Phase 0, not closed:** a body
   under the limit is still unerasable, so the pressure moves to keeping payloads out of bodies by
   design rather than by cap.
2. **Taint through the filesystem.** Materialise a tainted file, code reads it, and the output
   inherits nothing unless the workspace files are DATA PARENTS of the call. That is the documented
   "taint launders by omitting the parent edge" made systematic rather than incidental. It is also
   worse than it looks: the taint BOOLEAN already saturates without workspaces (see
   [design-taint.md](design-taint.md)), so propagating it through a filesystem propagates something
   that no longer discriminates. **Decide the label set before Phase 2**, or that phase builds the
   propagation twice.
3. **High-churn registry.** [CLAUDE.md](../CLAUDE.md)'s stopping rule says state that is high-churn
   AND security-critical is a poor fit for record-projection. A workspace is both. This is the first
   thing to TEST that rule rather than obey it.
4. **Attestation with a client-asserted link** (`treeDigest`); the fix is known and lands in Phase 3.
5. **No compare-and-swap**, mitigated by fork detection in Phase 4.
6. **Erasure fans out by content.** Rare today; common once dependency trees are shared.

### Measured up front, because two results changed the plan

| files  | body      | put   |
|--------|-----------|-------|
| 50     | 8 KiB     | 3 ms  |
| 500    | 80 KiB    | 2 ms  |
| 5 000  | 805 KiB   | 14 ms |
| 20 000 | 3 231 KiB | 39 ms |

Manifest-as-record works mechanically at `node_modules` scale, so an earlier guess that bodies get
uncomfortable past ~100 files was wrong. Reading ONE workspace is a `limit 1, dir:desc` query,
exact and cheap, the same shape `lookupProcedure` already uses; the registry stress bites on "list
all workspaces", not "read this one".

Which sharpens the real constraint: 3.2 MiB per attempt, per workspace, forever, in a body nothing
can erase. Performance was never the problem.

## Phases

Each is scoped to answer its question. Do not merge them.

| # | Phase | Question it answers | Stress |
|---|-------------------------------|-----------------------------------------------------|--------|
| 0 | Record size limit **(done)** | Can a body still become an unerasable payload? | 1 |
| 1 | Manifest, no execution **(done)** | Does a churning tree-as-records hold up? | 1, 3 |
| 2 | Materialise, read-only **(done)** | Is checkout safe, and does taint survive a filesystem? | 2 |
| 3 | Write-back + `treeDigest` + `check` **(done)** | Is an attestation worth anything? | 4 |
| 4 | Fork detection (`basedOn`) **(done)** | Is concurrent divergence visible? | 5 |
| 5 | `sandbox` record, ONE backend | Does the record shape describe a real jail? | — |
| 6 | A second backend **(done)** | What breaks when the guarantee stops being uniform? | — |

**Phases 0-5 need no new isolation mechanism.** Every model stress worth finding is reachable with
the Deno sandbox that already exists. Multi-language execution adds a large security surface and NO
additional model stress, which is why it is last however much more interesting it sounds.

### Phase 0: record size limit

`SpaceContext.maxRecordBytes`, enforced where the body is serialised so every write path is covered,
returned as `413`. Small, and everything else compounds on it: building Phase 1 first means shipping
unerasable data by construction. It is also the highest-priority unbuilt resource limit on its own
merits (see [design-data-model.md](design-data-model.md), "Resource limits").

The limit is deliberately well below the artifact cap. A body that approaches artifact size is a
payload in the wrong place, and the error should say so rather than merely refuse.

**Done.** 1 MiB default, checked in `buildRecord` where the serialized body first exists so every
write path passes through one chokepoint, `413 record_too_large` at the HTTP boundary, measured on
serialized BYTES rather than character count. Conformance in `suites/records.ts`, both adapters.

Two things learned that the next phases should carry. The artifact path rejects wide metadata
EARLIER and tighter (256 characters per field), so "the size limit did not fire there" is correct
rather than a gap. And the limit bounds the damage without closing the path: a 900 KiB base64 body
is still under it and still unerasable, so this is a mitigation, not the invariant becoming an
enforcement.

### Phase 1: the manifest, no execution at all

`workspace` kind, per-file artifacts, `treeDigest`, `basedOn`. No sandbox involvement.

Deliverable is a contract that ASSERTS answers, not a feature: churn across many successors, with
"read this workspace" exact and bounded, "list all workspaces" complete or honestly incomplete, and
the point where the record body limit bites stated as a number.

**Done** (`extensions/ts/workspace.ts`, contract in `extensions/conformance/`). It began in
`examples/chat/space/` and moved: a workspace is a convention more than one app wants and the
runtime has no business knowing, which is the definition of an extension. The answers:

*Stress 3, churn: the shape holds, and better than the stopping rule suggested.* Reading one
workspace after 40 successors is **2.8 ms**, because it is `limit 1, dir:desc` on an indexed name,
not a projection over history. Every version stays addressable, so nothing is lost. The expensive
direction is LISTING, which pages to exhaustion and reports `complete: false` rather than a
plausible prefix. So high-churn is fine here as long as reads are keyed; the rule's warning is about
reads that treat a page as a population, and this shape does not have one on the hot path.

*Stress 1, bodies: measured, and the limit binds where it should.*

```
  100 files   16 KiB      3 000 files  479 KiB
1 000 files  158 KiB      6 000 files  959 KiB
                         10 000 files  REFUSED (record_too_large)
```

A manifest caps at roughly **6 300 files**, which is the number this phase owed. That settles the
open question below: a vendored dependency tree cannot live inline, so it must be an artifact
beside the manifest. Phase 0's limit is what makes that a wall rather than a preference.

*Storage per session, stated:* 40 attempts on a 2-file tree cost 40 manifests totalling **18.7 KiB**
(478 bytes each) and 80 artifact records over **one** blob for the file that never changed. Churn
costs what changed, not the tree. The manifests are the part that cannot be erased.

*Not in the plan, but it belonged here:* path validation runs at WRITE, so an unsafe path never
enters a manifest and Phase 2's materialise-side check is defence in depth rather than the only
guard. The list is git's checkout history (`..`, absolute, `.git` in any case for CVE-2014-9390,
trailing dot or space), not one rediscovered incident by incident.

*Measured and fixed on the way:* sequential artifact writes cost ~1.8 ms each, so a 6 000-file tree
took eleven seconds in round trips rather than bytes. Bounded concurrency of 16 brought it to 8.7 s;
an unbounded fan-out over a large tree is a self-inflicted load test.

### Phase 2: materialise, read-only

Into a temp directory, run with the existing Deno runner and `--allow-read`. No write-back.

Two things get decided here and neither is optional. Path safety borrows git's checkout list
wholesale (`..` traversal, `.Git` case folding, symlink-then-write) because materialisation is the
TRUSTED worker writing model-influenced paths outside any jail. And taint: if a materialised file is
tainted, the run's output must inherit it, which means workspace files are data parents of the call
or the laundering path stays open.

**Done** (`materialize` in `extensions/ts/workspace.ts`). The answers:

*Is checkout safe?* Two guards, and neither is redundant. `validatePath` is the LEXICAL check and
runs again at materialise even though `writeWorkspace` already refused an unsafe path, because a
manifest can arrive from an older build and this is the last check before a path becomes a
filesystem operation. On top of it, a REALPATH containment check per file: lexical validation cannot
see a symlink, and a symlink is how checkout has historically been escaped (an earlier entry plants
one, a later entry writes through it). The contract exercises that for real — it plants a link to a
directory outside the root, tries to write through it, and asserts both the refusal and that the
file outside is untouched. Files are written in sorted order rather than concurrently, so a failure
reproduces.

*Does taint survive a filesystem?* Only if it travels on the RECORD graph, because the substrate
cannot observe a disk. Naming every file as a parent does not scale (a 5 000-file tree cannot have
5 000 parents), so **the manifest carries the union of its tree's labels** and one parent edge
speaks for the whole tree. `writeWorkspace` takes `taint` and raises it on every artifact AND on the
manifest, so per-file barring and erasure still work while a run needs one edge.

*The hole that remains, stated rather than hidden:* a result that does not name the manifest still
launders. That is the documented "taint launders by omitting the parent edge", unchanged, and not
something materialising can fix. The contract asserts it in both directions so nobody reads the
passing case as a guarantee.

*Wired into the chat*, so it is drivable by hand rather than only by the contract: `save_workspace`
stores a tree, `run_javascript {workspace}` materialises it and runs the program INSIDE it (cwd = the
tree, so relative paths resolve like a checkout), the manifest becomes a parent of the result, and
the directory is discarded. Two things the wiring taught: the program has no way to learn a temp
path, so running in the tree is the only workable answer; and the materialised root must live
OUTSIDE `.radia`, because the sandbox child is denied that directory and in Deno a deny beats an
allow.

*Also moved here:* `exec-sandbox.ts` became `extensions/ts/sandbox.ts`. It imports nothing, the
runtime executes nothing, and a sandbox is meaningless inside one app — so it belongs beside the
workspace convention, which is where Phase 5 will put a `sandbox` RECORD on top of it.

### Phase 3: write-back, `treeDigest`, `check`

Hash before and hash after, store the difference, honour the `ignore` list. The worker that writes
the `check` recomputes `treeDigest` from the artifacts it materialised and refuses a verdict on
disagreement, which is what makes the attestation mean anything.

**Done.** The answer to "is an attestation worth anything" is now yes, and it rests on two checks
that cost nothing because the bytes are already in hand:

*The client-asserted link is closed.* `materialize` hashes every artifact it fetches against the
entry that names it, and recomputes `treeDigest` from the entries rather than believing the
manifest's. An artifact's digest is server-computed and cannot be forged; a manifest ENTRY claiming
that digest for those bytes could be, because a manifest is an ordinary record. Both forgeries are
refused, and `materialize` returns the digest it VERIFIED rather than the one it was told. A `check`
now carries `{workspace, treeDigest}`, so a verdict is an attestation of a reproducible input rather
than a note about an event.

*Write-back is opt-in and captures only the difference.* `run_javascript {workspace, write: true}` grants
the sandbox `--allow-write` on that tree and nothing else; without it a write fails `NotCapable`, so
"read-only" stays enforced rather than promised. After the run, `captureWorkspace` hashes the tree,
reuses the artifact for anything unchanged, stores what changed, and `commitWorkspace` writes a
successor — or nothing at all, so a run that only read does not manufacture a version.

Three capture rules that are safety rather than bookkeeping: symlinks are SKIPPED and never
followed (a program can point one anywhere, and following it would pull a file from outside the tree
into a record); ignored paths are dropped so build output does not become a version; and a file
count and byte budget REFUSE rather than truncate, because a partial capture presented as a tree is
the bounded-read-as-population bug wearing a filesystem.

*Verified end to end through the chat's worker:* a run bumps a counter file, the next run reads the
bumped value, an `expect` on the second run passes, three versions exist, the untouched file is one
blob across all of them, and the check's `treeDigest` matches a real version.

*One bug the test found.* The exec worker held `workspace: query` and not `put`, with a comment
saying it "never authors a tree" — true when written, false the moment write-back landed. The commit
failed silently into stderr and the loop read as working while producing no versions. The grant has
to follow the capability, not the reasoning that preceded it.

### Phase 4: fork detection

A successor manifest names its predecessor. Two successors of one predecessor are a visible fork in
the DAG rather than a silent last-writer-wins. Merge stays unsupported; the overwritten manifest is
still a record, so this is divergence, not loss.

**Done.** Two halves, and the first was missing entirely:

*The DAG did not exist.* `basedOn` was a body field only, so nothing connected one version to the
next in the graph and "a visible fork in the DAG" was aspirational. A successor now takes its
predecessor as a data PARENT as well, so `lineage` walks a project's history and `children` answers
"what superseded this", which is the query detection rests on.

*`forksOf(name)` returns the HEADS* — versions nothing supersedes — and more than one means a fork.
Both writes survive with their history intact, which is a permanent reflog rather than a
force-push: the loser's work is not gone, only elsewhere. `readWorkspace` still answers, and its
answer is a CHOICE among heads rather than the truth, which is now stated where it is defined.

*The flag answered the wrong question at first.* `forked` initially meant "the manifest I superseded
already had a successor", which detects CREATING a fork and misses being ON one — and being on one
is the case that matters, because the writer that lost the race then keeps working, unaware, on a
head nobody else can see. It now means "this workspace has more than one head", asked after the
write, one indexed query. The chat surfaces it from `save_workspace` and from write-back, with a
tool description telling the model to say so rather than continue silently.

Merge is still unsupported and stays that way; this is the detection half of git's answer, which is
not compare-and-swap either.

### Phase 5: `sandbox` as a record, Deno only

Lands in `extensions/`, beside the workspace convention, for the same reason it did.

The record describes a jail that already exists, and the boot probe verifies it. Proves the shape
with nothing new to get wrong.

### Phase 6: a second backend

Where fail-open becomes real. Read [design-execution.md](design-execution.md) again before starting.

**Done.** A bubblewrap backend (`runBwrap`, `bwrapSandbox`) running python beside the Deno jail,
with the probe made backend-aware so it tests each in the language that jail actually runs.

*The answer to "what breaks":* the guarantee stops being uniform, and the record is what keeps that
visible. Both jails claim `network: false` and they differ on the axes a latency table hides —
`readonlyPaths` is empty for Deno and includes `/usr` for bwrap (an interpreter has to come from
somewhere), and `processes` is false for Deno and TRUE for bwrap, because a namespace jail does not
stop fork/exec the way a permission model does. "Which of these can reach a filesystem" is a query
now, not tribal knowledge.

*The probe earned itself twice, immediately.*

It caught a lie in my own spec on the first run: `bwrapSandbox` claimed `writablePaths: []`, and
bwrap's root is a tmpfs, so a program CAN write. Nothing escapes and nothing persists, but the claim
was false, and it is now declared (`["/", "/tmp"]`) rather than hidden. A record is only worth
something if it says what the jail GOT.

And it catches the fail-open case directly, which is the reason this phase was flagged as different.
Verified outside the code first: a bwrap jail with `--unshare-all` refuses a socket, and the same
jail without it connects. So the probe builds a deliberately weakened jail, serves it under a spec
still claiming `network: false`, and reports `["network"]` with what actually happened. Under Deno
that class of bug cannot exist, because "no network" is the ABSENCE of a flag; under bubblewrap it is
the PRESENCE of one, and a structured claim nobody tested is more convincing than prose and no more
true.

### Phase 7: selection, by capability name

**Done.** `run_code` became `run_javascript`, and `run_python` joined it as a `capability` like any
other, served by the same worker.

*The open question answered itself once a real second language was in the chat, and it answered
NEITHER option.* Both candidates assumed the caller picks a SANDBOX: a router that reads requirements
and picks one, or an agent naming one directly. Both are wrong, and for the same reason. A sandbox is
a deployment detail (which jail, which backend, which host had `bwrap` installed), and a caller that
names one is binding to something it cannot know. What a caller knows is the LANGUAGE, because it
wrote the program.

So the tool name carries it, and three things follow that neither candidate gave:

- an unavailable language is UNDISCOVERABLE rather than a runtime error, since `run_python` is
  published only where the bwrap probe passed. A `requires: {language}` argument is expressible
  everywhere and fails at execution, after the model committed a turn to it.
- nothing falls back, because there is no request to satisfy. A router that cannot honour
  `network: false` must fail or substitute, and substituting means running somewhere weaker than
  asked.
- discovery is the path that already exists. The capability list answers "what can this space run";
  `space_query {kind: sandbox}` answers "under what guarantees".

*The `llm_call` tier precedent does not transfer,* which is the part worth keeping. A tier is a
JUDGEMENT about a turn, so it is worth delegating to a worker that can read the turn. A language is
a fact the caller already holds. A router still earns its place for a caller stating REQUIREMENTS
rather than a name (subsumption is not expressible as a pattern, so a worker must match); nobody
does yet.

*The registry was missing its default entry, and only a cross-check found it.* The Deno jail was
verified at boot and never DECLARED, so `check` records naming `sandbox: "deno"` pointed at nothing
and "which of my sandboxes has a filesystem" silently omitted the one every space has. The probe
could not catch this: it tests whether a declaration is true, not whether one exists. What caught it
was asserting both jails are declared AND that they disagree, which is the assertion worth writing,
since a registry with one entry looks healthy.

*Naming the language in the tool is only half the mechanism; the other half is the DESCRIPTIONS,
and it was missed.* With both runners advertised, asked for "python code finding the first 10
primes", the model called `run_javascript` with a Python program twice and then tried
`os.system('python3 …')`. `run_python` named its sibling and `run_javascript` did not, which is the
exact asymmetry that made `run_javascript` beat `save_content` a milestone earlier: an
unconditional claim beats a conditional one, and a one-way cross-reference is not a boundary. The
cross-reference has to be built per boot, too, since naming a tool this host does not serve is
unreachable advice.

*One bug, and it is the shape to expect from a rename.* The dispatch tested `b.tool !==
"run_javascript"` to decide "this is a saved procedure", so every Python call went down the
procedure path and came back as "no procedure named run_python". A `BUILTIN_RUNNERS` set replaces
the single-name comparison. Any check written against ONE member of a set breaks the moment the set
grows, and a rename is exactly when it grows.

### Phase 8: git export

**Done.** `extensions/ts/git.ts`, run with `deno task workspace-git --name <ws> --dir <out>`, then
`git clone <out>`.

*Read-only git access was the ask; the object builder was the half worth doing first.* Measured
before deciding: `git clone` over plain HTTP needs only the DUMB protocol (git 2.55 probes smart,
falls back, and clones from a static file server — three route shapes, no pkt-line, no packfile, no
negotiation), so a server is separable from the objects rather than a prerequisite for them. What
the server buys beyond a local export is a familiar URL and incremental `pull`; what it costs is a
credential question this project has not answered (a run token lives ~15 minutes and git persists it
into `.git/config`) and a bet on a protocol git has repeatedly proposed removing. The objects are
where the value is, and they need neither.

*The mapping was already there,* which is why the file is small: blob → artifact, tree → the
manifest's sorted digest list, commit → one manifest version, ref → a head of the `basedOn` chain.
The sha1 is recomputed at export and thrown away, so SHA-1 never enters the attestation chain.

*Three things the tests caught that reading would not have.*

- **A per-fetch check is not a per-entry check.** Blobs are cached by artifact id across versions, so
  a later manifest naming the same artifact with a DIFFERENT claimed digest hit the cache and skipped
  verification entirely. The cache now holds the digest that was verified, and every entry is checked
  against it. A manifest is ordinary record content; only the artifact's own digest is server-computed.
- **`created_by` is the author, never the body's `owner`.** Provenance is not authority, and an
  export taking its author line from the body would let a record name whoever it liked as its writer.
  The owner claim still travels, as a trailer, where it reads as the claim it is.
- **A name can be a file in one place and a directory in another,** and only one direction was
  caught. `a` then `a/b` produced a tree with two entries named `a`: an object that builds, hashes
  and writes fine, and that `git fsck` rejects. Nothing but real git finds that.

*Erasure propagates, loudly.* A shredded payload makes its commit unreconstructable, and the export
fails naming the path. The alternative, a placeholder blob, keeps the export working by making it
LIE: the tree would hash to something the manifest never described, and `git log` would present
invented bytes as the audited ones.

*`--partial` was added after the first real shred, and the distinction it turns on is worth
keeping.* "Refuse or fabricate" was a false pair. OMITTING the entry is neither: a tree that does
not contain `secret.txt` makes no claim about `secret.txt`, so the only dishonesty left is silence
about the difference. That is what the option pays for — the subject line carries `[N erased]`
(`git log --oneline` is what a reader scans), the commit that lost an entry carries
`Radia-Partial` and `Radia-Erased` trailers, and the repository's `description` carries the list,
which is the one channel that survives the directory being handed to somebody who never saw the
console. `Radia-Tree-Digest` still names the MANIFEST, so recomputing it from what git holds
disagrees on purpose, and the `Radia-Partial` beside it is what says that is expected.

It skips ERASURE ONLY, discriminated on 410 rather than on the error reading like one. A 404 is a
manifest pointing at something that never existed, and a forged digest is content disagreeing with
its claim; both stay fatal with `partial: true` set. Widening this to "skip anything unreadable"
is how a broken tree becomes an export nobody questions, and both cases carry a test that fails if
someone tries.

*A fork is two branches, not a dropped head.* Picking a winner here would be this layer inventing
the merge policy the design deliberately does not have.

## Open, and better decided with Phase 1 evidence

- **SETTLED by Phase 1: the dependency set lives BESIDE the manifest.** Not a preference any more:
  the record limit refuses a manifest past ~6 300 entries, so a vendored tree cannot be inline even
  if someone wanted it to. As its own content-addressed artifact it keeps the body bounded, dedupes
  across every workspace sharing it, and can be erased.
- **Conversation-scoped or owner-scoped?** Same question as the chat's session grants, and it should
  get the same answer. Whichever is chosen, exercise BOTH postures from day one: testing one half of
  a documented either/or is how two bugs shipped in the chat (see [gotchas.md](gotchas.md)).
