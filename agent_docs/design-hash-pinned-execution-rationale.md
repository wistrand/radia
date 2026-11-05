# Hash-Pinned Code Execution: rationale and Radia mapping (design)

**Status: PLANNED. Companion to [design-hash-pinned-execution.md](design-hash-pinned-execution.md), which holds the rules; this doc holds why, what was rejected, and where Radia stands against each section.**

The spec is written to be implemented outside Radia, so it names nothing here. This doc is the
opposite: every entry is the reason for one rule, and the last two sections map the spec onto the
code that exists today. Section numbers (§) refer to the spec.

## Why each rule

**§3.5 A tree hash covers the files and nothing else.** Equal files must hash equal wherever and
whenever they were made, or deduplication, the "unchanged step adds nothing" rule (§8.2) and reuse
(§9.4) all break. Anything describing a tree (its entrypoint, parent, name, origin) therefore lives
beside it, in a version (§4) or a run spec (§6).

**§3.4 The byte encoding is fixed and versioned.** A tree hash crosses a trust boundary: a test result
attached to one is only worth something if a second implementation computes the same string. The
`t1:` tag makes an algorithm change visible instead of producing a different 64-character hex that
looks comparable; `grantKey`'s `g2` prefix is the precedent (`extensions/ts/workspace.ts`,
`TREE_DIGEST_VERSION`).

**§3.4 Lines sort in UTF-16 order.** That is what `treeDigestOf` has always done (JavaScript's default
sort), so specifying it keeps every stored workspace hash valid. JCS sorts object keys the same way,
so the spec has one comparison rule throughout. Vector A.4 exists because UTF-8 byte order is the
natural choice in most other languages and gives a different hash.

**§3.3 Path rules are refusals, not rewrites.** The list is git's, from `git checkout`'s CVE history
(`validatePath`). Rewriting a path (stripping a trailing dot, folding case) would make two manifest
entries one file on disk while the hash still says two.

**§3.2 Two modes, no symlinks, no directories.** A symlink in a tree is how checkout has historically
been escaped at materialisation, and a mode beyond the executable bit is not something model-written
code should be able to request.

**§3.5 Whoever relies on a hash recomputes it.** A manifest is the writer's claim. `materialize()`
already re-hashes every blob and the tree before anything runs.

**§4 Tree, version and ref are three objects.** Git's split (tree, commit, ref). A version carries
origin and parent, so it cannot be content-addressed without making equal outputs of two runs
differ; it gets an id instead. A ref update is compare-and-set and a fork is visible, which is the
workspace rule today (`basedOn`, design-workspaces.md).

**§5 A profile is named by its hash.** The run record must say what the run was allowed to do, and a
profile name can be redefined after the run. Explicit `null` limits exist because an implied limit
is read as present: Radia's own sandbox has no CPU bound and a memory cap that TypedArrays escape
(`extensions/ts/sandbox.ts` header), and a profile must say so. The probe rule exists because a
declaration nobody checks is a promise; [architecture-jail-confinement.md](architecture-jail-confinement.md)
records a read permission that did not bound module loading.

**§6 Entrypoint and function sit outside the program hash; arguments are files.** One program tree
then serves every call, stays cached, and each call adds one small args tree. Making arguments files
means identity, caching and lineage have one mechanism whichever calling style is used, and JCS
makes equal values produce equal spec ids. The note's four calling styles reduce to two cases
(`function` null or not), since a serialised call is an args tree holding `args.json`.

**§6.4 References are resolved by the runner before the code starts.** Large data enters by hash, so
everything the code saw is listed in the run record and the code never needs a network. Rewriting
`args.json` to carry resolved paths would change the spec id, so the code finds references by hash
instead.

**§7 Fresh process per attempt; only `work` is writable.** Files are safe to share between attempts
because a hash names them; a reused process can carry state. The program tree is shared by every run
of that hash, so a write into it would race other runs and change what the hash means.

**§8 Output is a sequence of complete trees.** A checkpoint makes an intermediate result inspectable,
usable as another run's input while this one continues, and survivable when the run later crashes.
Complete trees rather than diffs mean any step stands alone; shared blobs mean a step costs only
what changed. Over-limit captures are refused, never truncated, which is Radia's capture rule
already (`extensions/ts/workspace.ts`, the 2,000-file and 32 MiB caps).

**§9 The run record lives outside every tree.** It holds timestamps and timings, so inside a tree it
would make identical results hash differently, turn diagnostics into the next run's inputs, and
make a log impossible to delete without breaking the tree.

**§9.3 A crash is not retried automatically; a negative answer is a success.** An equal retry of a
deterministic failure repeats it: [research-agent-sessions.md](research-agent-sessions.md) records the
host retrying an authorization refusal to a dead letter. `{"ok": false}` as `succeeded` is the team
convention already (`note.ok`, `extensions/ts/team.ts`): work that could not be done is answered, not
given back.

**§9.4 Reuse is opt-in.** Code can read the clock and a random source (`Date.now()` and
`Math.random()` work in `extensions/ts/sandbox.ts`), so equal specs do not imply equal outputs. Only
the author can claim otherwise, and the runner cannot check the claim.

**§10.2 A dedicated channel, never stdout.** Radia's broker learned this: stdout markers were replaced
by FIFOs because program output without a trailing newline corrupts a frame
([architecture-workspace-agents.md](architecture-workspace-agents.md)).

**§10.1 Protocol separate from transport.** Backends offer different channels: FIFOs for a process,
`postMessage` for a Web Worker (`extensions/ts/sandbox-web.ts`), vsock for a VM. One message set
over all of them lets any conforming shim work with any conforming runner.

**§10.3 Handshake with the offered calls; call list published as data.** Profiles offer different
calls, and a model writing code should look shapes up rather than guess them. Radia publishes a
sandbox's calls as its `api` field already.

**§10.4 Every call is classified, and an input is recorded by hash.** This is what keeps "everything
the run saw is recorded" true as calls are added. Bytes stay out of frames so the message cap means
something.

**§12 Live streaming is deferred.** Most of its debugging value is a stored stderr linked from the run
record, which §12 already requires.

## Rejected

- **Provenance inside the tree hash.** Breaks §3.5: two runs producing the same files would get two
  hashes.
- **A new tree algorithm with UTF-8 byte order.** Cleaner for non-JavaScript implementations, but it
  re-identifies every stored workspace and invalidates every attestation pinned to one.
- **Git object ids as the identity.** They hash a typed, length-prefixed, per-directory encoding; git
  is an export format here (spec Appendix B; design-workspaces.md rejects git as storage).
- **Profiles referenced by name.** A run record would then point at whatever the name means today.
- **Logs and exit status inside output trees.** See §9 above.
- **Reuse by default.** See §9.4 above.
- **Bytes in protocol frames.** Data moves as files; frames stay small and capped.
- **A process reused across attempts.** Saves start-up time and makes no attempt explainable by its
  recorded inputs.

## Radia against the spec

| Spec concept         | Radia today                                                                    | Gap                                                                 |
|----------------------|--------------------------------------------------------------------------------|---------------------------------------------------------------------|
| blob (§3.1)          | an artifact; digest is hex sha256 of the plaintext                             | none                                                                |
| tree, `t1` (§3)      | a workspace manifest's `files` and `treeDigest` (`treeDigestOf`)               | a file `a` beside `a/b` is not refused at write; case-fold pairs not flagged |
| verification (§7.2)  | `materialize()` re-hashes every blob and the tree                              | none                                                                |
| version (§4.1)       | a workspace manifest record: record id, `basedOn`                              | no `origin`; an output workspace is parented on the request, not on a run and step |
| ref (§4.2)           | a workspace name, latest-wins, a fork detected through `basedOn`               | detection only, which §4.2 allows                                   |
| profile (§5)         | a `sandbox` record (`SandboxSpec`), probed by `probeSandbox`, selected by the binding's `sandboxPattern` | named, not hashed; limits implied rather than explicit `null`       |
| run spec (§6)        | a `binding` record (`workspaceDigest`, `entrypoint`, `inputs`, `sandboxPattern`) is a TEMPLATE; the run spec exists once a claim fixes the record and resolves the pattern to one sandbox (`extensions/ts/host.ts`) | no spec id, no `deterministic`, the argument is a record rather than an args tree |

**A binding is a template, not a run spec.** It names its sandbox by PATTERN, which is the
"a sandbox is a record matched by pattern" rule of [design-execution.md](design-execution.md) and
content routing applied to jails. The spec's profile hash and spec id are therefore computed at
claim time, from the sandbox the pattern resolved to, and recorded in the run record. Never replace
`sandboxPattern` with a fixed profile reference to make a binding look like a run spec: that undoes
the routing for a naming convenience.

## Which runs the spec describes

Unbrokered runs are the core case, and most runs are unbrokered. `Binding.brokered` defaults to
false (least privilege for model-written code), and its comment in `extensions/ts/host.ts` records
that the analysis pipeline, then the only brokered consumer, never touched `space`.

| Path                                                     | Brokered | Shape                                                        |
|----------------------------------------------------------|----------|--------------------------------------------------------------|
| chat exec worker (`examples/chat/workers/exec.ts`)       | no       | workspace in, captured output and stdout out, no side effects |
| analysis stages (`examples/analysis/host.ts`)            | no       | claimed record and input files in, value and `outputWorkspace` out |
| `radia host` default                                     | no       | plain jail unless a binding asks for the broker              |
| go-fish dealer (`examples/teams/go-fish/dealer-host.ts`) | yes      | writes game records into the team's compartment              |

What differs from the spec for the core case is how arguments and results travel, not purity: the
argument is the claimed record (immutable and id-named, so it pins the input, but it is not a tree),
and the return value becomes the ack record. Reuse (§9.4) is legal for these runs but would rarely
hit, because each claim carries a different record. It hits only if the argument is the record's
BODY as `args.json` (§6.2), and then the run record must still name the record served, or runs on
records of different lineage and taint share one cached result with nothing tying it to either.
| filesystem (§7.1)    | code root never writable; empty output dir when `outputWorkspace` is set       | otherwise the cwd is the input dir or the tree; cache is per process, LRU of 4 |
| steps (§8)           | one output workspace per run, captured at exit                                 | no `checkpoint`                                                     |
| run record (§9.2)    | `RunResult` in `run_javascript` only (`extensions/ts/exec-tool.ts`)            | the host writes none; stderr survives as a 64 KB tail in a thrown error |
| outcomes (§9.3)      | every throw is a nack and a retry; 401/403 marked permanent                    | no `failed` vs `infrastructure` split                               |
| protocol (§10)       | broker frames `{id, op, args}` over two FIFOs (`extensions/ts/broker.ts`), same frames over `postMessage` | no handshake or version; ops are unnamespaced; no run record to hold `inputs`/`effects` |
| return value (§8.3)  | the terminal `result` frame becomes the claim's ack record                     | a mapping, not a gap: the ack is how Radia publishes `result.json`  |

## Radia's extension: the broker's space calls

The broker's three operations are Radia's extension calls under §10.8, not spec calls. Each fails a
spec property the extension clause exists to fence: a `put` changes state no tree holds, and the
reads answer from the live space, so two attempts with one spec id can see different records.

| Call               | §10.8 class | What the run record holds                    | Why                                       |
|--------------------|-------------|----------------------------------------------|-------------------------------------------|
| `x-radia.put`      | effect      | the written record's id, in `effects`        | a record outside every tree               |
| `x-radia.read_one` | input       | the returned record's id, in `inputs`        | a record id names immutable content, so it meets "cannot later name different content" |
| `x-radia.query`    | input       | every returned record's id, in `inputs`      | same; the rows arrive inside the response, which §10.8 allows within the cap |

**Lineage stays as it is.** A `read_one` answer becomes a forced parent and a query page raises only
labels (`broker.ts` header, property 2): parents name records consumed singly, and a 500-row parent
list is unbounded. The run record's `inputs` is the complete account of what was read; parents stay
the bounded classification channel. Adding query rows as parents would undo that decision.

**Retry is the extension's, and it spans attempts.** A brokered `put` is keyed
`broker:<record id>:<ordinal>` (plus `keyScope` when a host varies the code), so a retried attempt's
writes dedupe against the first one's instead of doubling. That holds within
`idempotencyRetentionSeconds` and only if the code issues its puts in the same order. The spec
treats attempts as independent (§9.1); this is the documented exception §10.8 requires.

**A profile offering `x-radia.put` is never reused** (§9.4). Every brokered profile offers it, so
reuse in Radia applies to unbrokered runs only.

## Suggested build order

1. A run record per attempt and the §9.3 outcome split, in the host. Closes the largest gap and needs
   no wire change.
2. Record the broker's reads in `inputs` and its puts in `effects` (item 1's run record), by record
   id, leaving lineage as it is.
3. The §10.3 handshake on the broker channel, with a protocol version, together with renaming the
   operations to `x-radia.*` and publishing each one's §10.8 class: both change what a run is told
   at start.
4. The §3.2 and §3.3 write-time path checks Radia does not make yet.
5. Profile hashes, then spec ids and opt-in reuse (§5, §6.1, §9.4).
6. Checkpoints as workspace successors (§8), after deciding how many records a long run may write and
   whether a checkpoint needs the claim's lease to still be valid.
