# Plan: workspaces and execution environments

Sequence and status. The reasoning lives in [design-workspaces.md](design-workspaces.md) (what a
working tree is, and the git relationship) and [design-execution.md](design-execution.md) (why the
language question is an isolation question). Read those first; this file assumes them.

> **Status: Phases 0-10 DONE**, including 10.6 (what first real use found). Workspaces, write-back, `check`, fork detection, `sandbox` records,
> a second backend (bubblewrap), and selection by capability name (`run_javascript`, `run_python`).
> Phase 7 answered the selection question with neither of the two options it was written to choose
> between; see there. Phases 8 and 9 were added after the fact, both from live use rather than from
> this plan: git export (from a request for git READ access, split so the object builder shipped
> first) and the read side of a workspace (from watching a model fabricate a file's contents because
> nothing could read one).

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
| 7 | Selection by capability name **(done)** | Who decides which language runs? | — |
| 8 | Git export **(done)** | Is the git correspondence real, or only shaped like it? | — |
| 9 | The read side **(done)** | What does an agent do when it cannot read? | — |
| 10 | Editing in place | Does the immutable version model survive fine-grained change? | 3, 5 |

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

### Phase 9: the read side

**Done.** `radia workspaces`, the chat's `list_workspaces` and `read_workspace`, and
`summarizeWorkspaces` in `extensions/ts/workspace.ts` behind all three.

*Every phase before this one built the WRITE side, and the gap only showed up in a live session.*
Trees could be saved, materialised, run and exported, and nothing could list them or read a file out
of one. What that cost is specific and worse than an inconvenience: asked to show a file, the model
tried `read_file` (sandbox paths only, denied), reconstructed the contents from earlier in the
conversation, stored the reconstruction with `save_content`, and answered with it. It said it was a
reconstruction, which no user reads as "this is not the file". **Fabrication is what fills a missing
read path**, so the absence of a reader was a correctness problem, not a convenience one.

*The listing had the same defect one question earlier.* "What files are in X" was also answered from
memory, because `list_workspaces` reported a file COUNT. It reports the paths now. Once a model is
answering questions about a tree from memory, answering the next one the same way is a short step.

*`query workspace` is not a listing,* which is the substrate-shaped half of the lesson. Every
version is a record, so three saves of one tree return three rows, and counting them is wrong twice
over. Anything registry-shaped needs the latest-wins-minus-retired projection, and it belongs in ONE
place: `summarizeWorkspaces` is shared by the CLI verb and the chat tool precisely so the two cannot
disagree about what exists.

*A tool scoped more tightly than the GRANT contradicts the tools that are not.* `list_workspaces`
first filtered to the current conversation while `space_count` was owner-scoped by the grant: one
answered 8, the other none, both correctly, and the model spent eight tool rounds failing to
reconcile them. The narrowing was doing no security work either, since the query is bounded by the
grant regardless. Where relevance genuinely differs from permission, MARK the rows
(`thisConversation: true`) rather than hiding them.

*And erasure had to become legible here too.* A shredded file made `materialize` throw, which
`agentLoop` nacked, which re-claimed the call until the CLIENT's deadline — a two-minute hang with
no reason given. A permanent failure is a RESULT, never a throw. Both the runner and the reader now
say the payload was erased, that it is permanent, and that the fix is a successor tree without that
path.

### Phase 10: editing in place

**The question:** does a version-per-write model survive changes an order of magnitude smaller than
a version? Every phase so far wrote a whole tree at a time, so "a version" and "a unit of work" were
the same thing. An edit breaks that, and the interesting failures are all downstream of it: version
inflation, fork frequency, and the classification a derived byte carries.

*Ordered by model risk, like every phase here, which puts the security prerequisite first and the
ergonomics second even though the ergonomics are what was asked for.*

#### 10.0 Prerequisite: settle the carrier, which turned out to be smaller than it looked — **DONE**

**Decided 2026-08-03.** Two rules, and they fit together rather than competing:

- **The UNION of the tree is the semantics.** A changed file inherits the whole tree's labels, not
  its own file's. This is forced rather than chosen: a jailed run is opaque, so it can read
  `secret.txt` and write those bytes into `out.txt` with nothing in the substrate able to see it.
  Per-file precision would be more useful and would be a lie. Labels are therefore sticky within a
  tree, cleared only by declassify — which is what monotone means and is accepted.
- **The MANIFEST is the carrier.** File artifacts stay bare — the REVERSIBLE choice rather than the
  permanently right one, and held up by additivity (labelling artifacts later is monotone and needs
  no migration) plus recovery by query (`artifact.workspace` → `readWorkspace`), NOT by the
  lineage-walk density rule, whose precondition fails here. `design-workspaces.md`, "The trigger
  that reopens this", records what revisits it: a barrier wanted at file granularity, which
  `share_artifact` will surface first.

*And with those two, the mechanism is already complete.* This section began as "close the laundering
hole" and the hole is not there:

```
commitWorkspace   parentIds: [manifest.id]        the successor manifest inherits the union
exec.ts (result)  parentIds: [..., wsParent]      the run's RESULT inherits it too
```

`Space.computeTaint` unions data parents, so a labelled tree propagates through write-back and
through every result that names the manifest, with no explicit taint anywhere. The claim that write-
back launders was wrong, and was corrected twice on the way down: from "carries no labels at all" to
"artifacts only" to "correct by design". Recorded because a defect that shrinks under checking is
worth the same write-up as one that grows.

What is actually wrong is smaller and is about legibility, not leakage:

1. **A dead parameter that implies the wrong mechanism.** `examples/chat/workers/exec.ts` passes
   `{ taint: b.owner ? undefined : undefined }` — a ternary whose branches are identical, so it
   reads as a decision and is a no-op. Under the rules above, `captureWorkspace` should not take a
   `taint` option at all: artifacts are bare by decision. `commitWorkspace` keeps one, narrowed to
   what it is for — a monotone RAISE by a caller who knows something the graph does not (the run
   reached the network), never inheritance, which the parent edge does.
2. **A guard named for a round trip that tests one leg.** "A classified tree does not launder its
   labels through the filesystem" passes today and covers `materialize` only. The return trip —
   materialise a labelled tree, change it through a real run, assert the successor and the result
   still carry the label — is the assertion the name promises.
3. **The carrier is only as good as the edges.** Every derived record must name the manifest or its
   successor; `exec.ts` does, and a future path that forgets loses the labels silently. That is the
   documented hole in [design-taint.md](design-taint.md) ("a caller that omits a parent edge omits
   its labels") landing in a specific place, so it wants a specific test rather than a note.

**Done.** `captureWorkspace` lost its `taint` option, the dead ternary in `exec.ts` is gone, and a
return-trip conformance case asserts the successor manifest and a result naming it both inherit the
label with nothing passed explicitly.

*The decision needed one more distinction than the question captured, and it is the useful part.*
Taken literally, "the manifest is the carrier, file artifacts stay bare" would have deleted a tested,
deliberate feature: `writeWorkspace({taint})` labels every file artifact, and the existing case
asserts it with a comment explaining that this is what makes per-file barring possible. The coherent
reading separates two things that look alike:

  an explicit RAISE — a caller asserting what the graph does not know ("this tree came off a
    filesystem") — applies wherever the caller says, artifacts included, because raising is monotone
    and needs no trust.
  INHERITANCE — a derived tree carrying what its predecessor carried — travels on the record graph
    and nowhere else.

`writeWorkspace` does the first and keeps its behaviour; a write-back and an edit are purely the
second and now pass nothing. Two mechanisms, not one applied inconsistently. Worth noticing that the
question as asked ("should artifacts carry labels at all") admitted no answer that was right for both.

**This did not block 10.1.** Nothing labels a workspace today — the chat's `save_workspace` passes
no `taint`, which is right, since the bytes are the model's own and provenance rides the message
chain. So there is no live leak to race. Do 1 and 2, then start the edit tool, which inherits a
mechanism that works.

*What an EDIT carries, decided by the same two rules.* The union of the tree, on the successor
manifest, through `basedOn` — identical to write-back. Per-file would be sound for an edit (unlike a
run, the substrate performs the change and knows which artifact the bytes came from), and it is
still not worth having: two propagation rules for one kind of record is how the two disagree later.

#### 10.1 `editWorkspace` in `extensions/` — **DONE**

`editWorkspace(client, {name, conversationId?, edits, add?, remove?})`, beside `writeWorkspace`.
An edit is `{path, oldString, newString, replaceAll?, expectDigest?}`.

**Decided 2026-08-03.** Seven choices; each is recorded with the alternative it beats, because every
one of them has a plausible other answer and the reasoning is the part that will not be obvious in
six months.

*The atomic unit is ONE LOGICAL CHANGE, not one string replacement.* So the call takes edits, file
ADDS and file REMOVES together and writes a single version. Real code changes routinely span them
("add a module and wire it into main"), and the alternatives both fail on the same case: an
edit-only tool leaves "add one file to a twenty-file tree" costing a whole-tree rewrite, which is the
token problem this phase exists to fix; a separate merge-in tool turns one logical change into two
versions the model has to sequence. The cost accepted is that `edit` is no longer purely a string
replacement and the surface carries three verbs.

*TWO ADDRESSING FORMS, one invariant.* Never a regex (a search predicate that is CODE, the wrong
direction for a project whose routing language is deliberately data) and never a diff (a grammar
between the model and the file, failing partially). But content and POSITION both, because the rule
that matters is not string-versus-line, it is that **every edit carries a precondition**:

  `oldString` IS its own precondition — the content addresses the edit and verifies it, so it needs
    nothing else.
  a line range has none — line 12 is whatever line 12 currently is — so `expectDigest` is REQUIRED
    there, and with one it is exactly as safe.

An earlier draft of this plan dismissed ranges as "breaking under any concurrent change". True of
UNPROTECTED ranges, and the protection was already specified two paragraphs later without the two
being connected. The correction came from the observation that models edit by line number readily
once a read gives them numbered output, which is worth taking seriously rather than designing
against.

Both exist because each is cheap where the other is not. Replacing a forty-line function by content
means emitting those forty lines verbatim as `oldString`: string matching costs O(size of the
region), which is the very cost this phase exists to remove, and it removes it only for small
changes. A range costs O(1) plus a digest. A one-word change is the reverse — a range would need a
fresh numbered read where a match needs nothing.

Two rules the position form needs and the content form does not: ranges apply DESCENDING, so an
earlier one never moves a line a later one refers to, and overlapping ranges in one batch are
refused rather than resolved, because there is no correct answer and picking one silently is the
same mistake as a first-match replacement. Ranges are validated against the text the caller READ,
not against the text a preceding content edit produced.

*The cost accepted: numbered reads bring back the oldest failure in this family.* `read_workspace`
must number its output for ranges to be usable, and a caller will paste the `NNN\t` prefix into
`oldString`. Not preventable, so it is DIAGNOSED: a not-found match retries with the prefixes
stripped and, if that matches, says so, because "not found" alone sends the caller hunting through
whitespace.

*A non-unique `oldString` is an ERROR, not a first-match.* The safety property of the whole tool:
silently editing the wrong occurrence is what would make it worse than a rewrite. `replaceAll` is
the explicit opt-in, and the refusal says how many were found.

*Validate everything, then write once.* Every `oldString`, every add's path, every remove's presence
is checked against the current bytes BEFORE any artifact is written. All-or-nothing then falls out
of the ordering rather than needing a mechanism, and there is no partial version to explain.

*Report ALL failures, not the first.* A model that gets one failure per round trip fixes them one
per round trip. This costs nothing and is the difference between one retry and five.

*`expectDigest` is OPTIONAL, and the reason is that `oldString` is already a precondition.* If
another writer changed the region being edited, the match fails on its own — the specific staleness
that matters, caught for free. `expectDigest` adds only the case where someone changed a DIFFERENT
part of the same file, which is real but narrower, so it is available and not mandatory. It requires
`read_workspace` to start returning the file's digest, which is a coupled change to make in the same
step or the field is unusable.

*A fork is REPORTED, never refusing the write.* Consistent with `save_workspace` and
`commitWorkspace`, and with the design's stance throughout: detection, not prevention, because
nothing is lost and both heads survive. The argument for refusing was real and was declined — an
edit implicitly inherits every file it does not mention, so a stale base carries the other head's
state in a way an explicit whole-tree save does not — but a second propagation rule for one record
type is the cost, and the project has one rule everywhere else. Revisit only if a real session shows
an edit built on a superseded head doing damage the report did not prevent.

Concurrency needs no new machinery beyond that: read the head, apply, write with `basedOn: head.id`,
and the existing detection reports divergence. What DOES change is frequency — edits make forks
common rather than rare, which promotes the `forked` report from a safety net to a load-bearing path.
Batching is most of the mitigation.

Labels follow §10.0 unchanged: the successor manifest inherits the tree's union through `basedOn`,
file artifacts stay bare, nothing explicit anywhere.

NOT normative, unlike `treeDigestOf` and `validatePath`: nothing attests to an edit and no second
implementation has to agree byte for byte. It gets a contract test, not a spec.

**Done** (`editWorkspace` in `extensions/ts/workspace.ts`, six cases in the contract suite). Two
things surfaced while building that the decisions did not anticipate:

*Two edits to one file had to compose, not race.* Each edited file is fetched ONCE and the edits
apply in sequence to the accumulating text. Applying each against the original bytes would make the
second silently lose the first, which is the same class of bug as a first-match replacement and just
as quiet.

*An edit that restores the original writes nothing.* After applying, each file is re-hashed and
dropped from the write set if it matches what the manifest already had — so an edit-and-revert pair
does not manufacture a version, matching `commitWorkspace`'s existing "unchanged writes nothing".

Measured on the concurrency question the decision left open: two writers editing DIFFERENT regions of
one file from the same base both succeed, both heads survive with the same `basedOn`, and `forked`
comes back true from both. Nothing is lost and the divergence is visible, which is the behaviour the
"report, never refuse" choice was made for.

#### 10.2 `edit_workspace` in the chat, and rewriting `save_workspace`'s description — **DONE**

The tool is a thin wrapper. The DESCRIPTION work is the part that will decide whether it is used, and
this example has hit the overlapping-description trap three times (`save_content`/`run_javascript`,
then `save_workspace` arriving as a third, then `run_javascript`/`run_python`). The incumbent
currently *instructs* the behaviour the new tool exists to replace:

> "Saving the same name again replaces the tree… so iterating means saving the whole tree again with
> your fix, not patching in place."

That sentence is correct today and becomes the bug tomorrow. Both descriptions have to name the other
and state the condition that selects it: a NEW tree or a wholesale rewrite goes to `save_workspace`,
a change to a file that already exists goes to `edit_workspace`. Guard it in `smoke-save.ts` the way
the other three boundaries are guarded — read back from the published `capability` records, not from
imports.

**Done.** `edit_workspace` with both addressing forms, `read_workspace` numbering its output and
returning the file digest, and fifteen assertions in `smoke-save.ts` read back from the running
fleet.

*Snake_case on the wire, camelCase inside.* `old_string`/`new_string`/`replace_all`/`start_line`/
`end_line` are the names a model has been trained on, and those two string fields carry long
verbatim text copied out of a read — exactly where a habit does the work and a novel name makes the
model improvise. The extension stays camelCase because every field in that file is; the mapping is
three lines in the wrapper. One convention per layer.

*The edit returns the new per-file digests.* Without them the cheap addressing form costs a full
re-read per iteration and stops being cheap, which would have been discovered in use rather than in
design.

*Numbering the read broke two existing assertions, and the interesting part is which.* They asserted
`content === "print(2)\n"` — raw bytes — under the name "reads back byte for byte". The intent was
"this is the stored file and not a fabrication", and that intent survives numbering; the assertion
did not. Both now strip the numbering and assert through it, with the numbering itself asserted
separately. A test whose NAME states an intent and whose body states a representation will break on
a presentation change and look like a regression.

*First live use found two things, and neither was the edit mechanics.* Asked to change a page title,
the model edited without reading, guessed `old_string`, and got `oldString not found` — accurate and
useless. It concluded the failure was a permissions problem, asked for an artifact grant, and the
human chose the conservative-looking `[own]`, which RETIRED the wider `artifact: read_one` the
session had been reading workspace files with. Three steps from a bad error message to strictly less
access than it started with. Fixed on both sides: the message names the likely cause, says to read
the file, and states what it is not; the tool description says READ THE FILE FIRST; and the grant
prompt now warns which access `[own]` would remove BEFORE the choice and stops recommending it when
it would take something away. See [gotchas.md](gotchas.md).

*And numbering has a cost paid by a different reader.* A model relaying a file to a person will show
the numbers unless told they are not the file, so `read_workspace`'s description says so explicitly
and a guard holds it there. Cheaper to say than to discover once, which is how the fabrication bug in
Phase 9 arrived.

#### 10.3 What this is NOT, and the bound it puts on the work — **MEASURED**

`run_python {workspace, write: true}` can already edit a file today. So this is ERGONOMICS, not new
capability, and it has to beat "write a Python script that does a string replace and round-trip it
through a jail" — which it easily does for a small change, and which is the reason not to build a
patch format, a merge strategy, or a diff grammar to go with it.

**Measured** (`bench/edit-cost.ts`), on a six-file, 473-line project — the size an agent actually
builds. Emitted characters are exact; tokens are estimated at four characters each, and the ratios
do not depend on the estimate.

| change | whole tree | edit (string) | edit (line range) |
|--------------------------------|-----------:|--------------:|------------------:|
| a one-line fix                 | ~5 669 tok |    ~33 tok (**173x**) | — |
| replace a 40-line block        | ~5 669 tok |   ~549 tok (**10x**)  | ~56 tok (**102x**) |
| add a module and wire it in    | ~5 669 tok |    ~64 tok (**89x**)  | — |

*The middle row is the argument for having two addressing forms, and it is starker than the
reasoning predicted.* String matching gives 10x on a 40-line replacement because it has to carry
those forty lines verbatim as `old_string`; the range gives 102x for the same change. An edit-only-
by-content tool would have solved the cheap case and left the expensive one costing an order of
magnitude more than it needs to.

*And the claim that the storage saving is zero was WRONG.* Blobs dedupe by content, so no bytes are
duplicated either way — that much held. Artifact RECORDS do not: `writeWorkspace` calls `putArtifact`
once per file regardless of how little changed, so the same one-line fix writes

```
save_workspace   6 artifact records   1 manifest
edit_workspace   1 artifact record    1 manifest
```

one record per file, per save, forever. On a churning tree that is the registry-growth shape this
project already has a rule about, arrived at from the opposite direction. The saving is real and was
asserted to be zero from the blob layer's behaviour without checking the record layer's — the same
mistake as citing a rule whose precondition does not hold.

#### 10.4 Verification

- uniqueness: two occurrences and no `replaceAll` is a refusal that says how many it found
- a failed edit in a batch leaves the tree untouched, with no partial version written, and reports
  EVERY failure rather than the first
- one batch mixing an edit, an add and a remove produces exactly ONE version
- an add whose path already exists, and a remove whose path does not, are refusals rather than
  silent no-ops
- `expectDigest` mismatch errors and names the file, rather than merging; and an edit WITHOUT one
  still fails on a changed region, because `oldString` is itself a precondition
- labels survive an edit (10.0's answer, applied here): the successor carries the tree's union
- a concurrent edit forks visibly, reports it, and loses neither side
- the descriptions name each other, read back from the running fleet
- `read_workspace` returns the file digest `expectDigest` needs (the coupled change, tested together
  or the field is decorative)

#### 10.5 The hazard this closes, which is not the one that was asked about

`writeWorkspace` builds the manifest from EXACTLY what it is passed — there is no merge with the
previous version — so a partial save does not patch a tree, it truncates it, and the head silently
loses every file the model did not retype. The old version survives, so nothing is destroyed, but the
current tree is wrong and nothing says so.

The request was about token cost. The reason to do it is that the current instruction fights the
model's economics: told to retype 500 lines to change three, a model under context pressure will
eventually send only the file it changed. An edit tool removes the incentive rather than restating
the rule, which is the same lesson as every other description fix in this example.

#### 10.6 What first real use found — **DONE**

Two gaps, both from one session, and neither was in the edit mechanics.

*A range's precondition was the wrong one.* A model aimed at lines 7-15 believing they were a
`<style>` block. `expectDigest` matched — correctly, nothing had changed — and the edit removed
`</head>`, `<body>`, a `<canvas>` and the opening of a `<script>` as well. **The digest proves the
file has not moved; it cannot prove the range points where the caller meant**, and that gap is
inherent to O(1) addressing rather than a bug in it.

Closed with `expectFirstLine` / `expectLastLine`: the caller quotes the boundary lines as it read
them. `expectLastLine` is the one that catches this and is required whenever the range spans more
than one line — a caller knows what it is STARTING at; where the region ends is what it miscounts.
Two lines of output against the forty the content form would have carried, so the cheap addressing
stays cheap. The invariant from 10.1 now actually holds for both forms: every edit carries a
precondition, and the positional one is no longer weaker than the content one.

*The result carried no evidence of what it did.* Returning `changed` plus a digest and no content
was one step too frugal: the model announced "lines 8-14 are now ZZZZZ", describing the outcome from
what it MEANT, and found the real damage only on a later read. `preview` is now a numbered window
over what actually changed, located by a common-prefix/suffix walk against the original — no
bookkeeping, correct however the ranges were ordered — bounded by context rather than echoing the
file.

*Both were found by using it, not by reading it,* which is the argument for 10.3's measurement being
the last step rather than the finish. The version model is what made the session recoverable: the
model restored from verbatim tool output and PROVED it, with the tree digest returning to its exact
pre-damage value. "Nothing is lost" stopped being a design slogan for one turn.

## Open, and better decided with Phase 1 evidence

- **SETTLED by Phase 1: the dependency set lives BESIDE the manifest.** Not a preference any more:
  the record limit refuses a manifest past ~6 300 entries, so a vendored tree cannot be inline even
  if someone wanted it to. As its own content-addressed artifact it keeps the body bounded, dedupes
  across every workspace sharing it, and can be erased.
- **Conversation-scoped or owner-scoped?** Same question as the chat's session grants, and it should
  get the same answer. Whichever is chosen, exercise BOTH postures from day one: testing one half of
  a documented either/or is how two bugs shipped in the chat (see [gotchas.md](gotchas.md)).
