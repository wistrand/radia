# Plan: one executor, from throwaway snippet to workspace agent

> Status: phases 1, 2 and 3 BUILT (2026-08-06); 4 CLOSED without building; 5 open. Origin: the chat and workspace agents
> ran the same jail through two different entry contracts, so code could not move from one to the
> other without being rewritten. Read [design-execution.md](design-execution.md) (the language
> question is an isolation question), [design-workspaces.md](design-workspaces.md) and
> [architecture-workspace-agents.md](architecture-workspace-agents.md) first: this joins them and
> adds almost nothing.

## Contents
- The ladder, and where code leaves each rung
- What was already shared
- Decided
- Phases
- Findings

## The ladder, and where code leaves each rung

The test is not size, it is IDENTITY. Code leaves rung 1 the moment somebody other than this turn
has to name it, read it, fix it, or attribute a result to it: a second file, a name, or a caller
that is not the current turn.

| rung | what it is | how it runs |
|---|---|---|
| 1. throwaway | the answer is the output, the program is not worth keeping | `code` on stdin, nothing stored |
| 2. named | a procedure: a tool in this conversation | a WORKSPACE, run as its entrypoint |
| 3. agent | a binding plus a pinned grant | the same tree, run by a host through the broker |

Rung 1 keeps stdin deliberately. Every snippet becoming a workspace would mean a blob plus an
artifact record plus a manifest per arithmetic question, and `artifact` records are NEVER swept
(the GC invariant: bytes with no other path to them), so retention would not clean it up. That is
the whole argument for keeping two shapes rather than one.

## What was already shared

Less was broken than it looked. Before any of this, both sides already used one jail
(`extensions/ts/sandbox.ts`), one sandbox registry (`sandbox` records, declared by the chat and
resolved by the broker), the same taint rule (`file` when read roots exist), and the same
manifests addressed by tree digest. The divergence was entirely in the ENTRY CONTRACT: a script
arriving on stdin whose answer is stdout, versus a module imported by a boot program and called as
`default(record, space)`.

## Decided

- **D1. A throwaway keeps stdin.** See above. This is a scoping decision, not a limitation to fix
  later.
- **D2. A tree declares its own entrypoint, and it is OUTSIDE the tree digest.** The digest attests
  WHICH FILES; re-pointing an entry would otherwise be a new digest and therefore a new promotion.
  A `binding` carries its own and stays authoritative for an agent, so the manifest's is a default.
  Being outside the digest has a consequence that bit immediately: the entrypoint has to join the
  dedupe check and the content key, or changing only the entrypoint is a silent no-op. The other
  consequence lands on review: a pinned digest does not fix which file runs, so promotion review
  covers the whole tree ([architecture-workspace-agents.md](architecture-workspace-agents.md),
  "The pin names the tree, never the file").
- **D3. A procedure IS a workspace.** It was a lone code artifact, which is a shape that cannot
  grow: one file, JavaScript whatever it contained, no versions to read back, no export, nothing an
  agent could be bound to. As a tree it inherits all of that, and promoting a script to a tool
  stops being a rewrite. Records saved the old way still resolve; re-saving is the only migration.
- **D4. The LANGUAGE comes from the file, never from the tool name.** Choosing it from the tool
  being called is what made every saved procedure JavaScript regardless of its contents, silently.
- **D5. Arguments arrive as a global, through a generated boot program.** `args` is what every
  procedure written so far was saved against (the old runner prepended `const args = …`). The boot
  lives in its own directory and never in the tree, for the same reason the broker's does: a
  per-call file inside a content-addressed directory changes the digest and collides with any other
  call sharing the materialised root. A procedure may instead `export default (args) => …` and
  RETURN its answer, which is the shape an agent entrypoint has.

## Phases

**1. A tree says how it is run. BUILT (2026-08-06).**
Shipped: `WorkspaceManifest.entrypoint` + `validateEntrypoint` (`extensions/ts/workspace.ts`),
enforced on all three write paths; `runEntry` (`extensions/ts/sandbox.ts`), sharing `spawnDeno`
with `runCode` so the jail flags stay in one place; `entrypoint` on the code runners, with `code`
no longer required. Four contract cases in `extensions/conformance/workspace.test.ts`.
Answered: a tree can be executed by anything holding it, as the file an agent would run, in
TypeScript, importing its siblings.
Plants: dropping the entrypoint from the dedupe check fails the re-point case; removing either
orphan check fails the edit case. A fourth plant (emptying the read roots) did NOT fail, which is
how the module-loading finding below was discovered.

**2. A procedure is a workspace. BUILT (2026-08-06).**
Shipped: `save_procedure` writes `proc-<name>` with an entrypoint and points the `procedure` record
at `{workspace, entrypoint}`; execution materialises that tree and runs its entrypoint through a
generated boot; `read_procedure` reads the file out of the tree; the legacy `artifactId` path still
resolves. `language: "python"` now genuinely runs in the Python jail (D4).
Answered: a procedure can be multi-file, can be Python, can be read and edited a line at a time
with `edit_workspace` instead of re-sent whole, keeps every version, and is a tree an agent could
later be bound to.
PROVENANCE, and the gap this phase opened before closing it (2026-08-07). A `tool_result` used to
carry the code's ARTIFACT ID, which pinned exact bytes; a tree-backed procedure's record names a
workspace by NAME, so the record alone answers "which procedure" and not "which code", and it stops
answering the moment the tree is edited. The `treeDigest` is now stamped once the tree is
MATERIALISED rather than read again at resolve time: `materialize` has already verified that digest
against the bytes it wrote, so what is recorded is what ran.
Guarded in `smoke-procedures.ts`, and the guard asserts the PROPERTY rather than the field: it edits
the procedure and requires the pinned digest to MOVE. Planted both ways, since a stamp that is never
written and a stamp that never changes are different bugs and only the second survives a
field-exists check.
Cost, and it is real: a procedure call now materialises a tree, so the exec worker needs a writable
directory it did not need before. `fleet.ts` always passed one; three standalone smoke launchers
did not, and now do. A worker without one refuses in words rather than nacking in silence.

**3. A way to test an agent entrypoint from the chat. BUILT (2026-08-06).**
Shipped: a `Performer` seam in `extensions/ts/broker.ts` (what a frame DOES, defaulting to
performing it as the agent), `recordingPerformer`, and `dryRunEntrypoint`. The spawn is now shared
by a real claim and a rehearsal (`runBrokered`), which is the point: a rehearsal that spawned its
own way would be testing something other than what a host does. In the chat, a `record` argument on
either runner rehearses the tree's entrypoint and returns `wouldWrite`.
Answered: an entrypoint written as `default(record, space)` can be exercised from the chat with the
real shim, the real frames and the real jail, and the transcript shows the host's contributions
(the stamp, the forced parent, the labels, the idempotency key) rather than only what the code
said. Nothing is written.
Two decisions worth keeping. READS ARE REFUSED in a rehearsal: a dry run holds no credential, and
answering a query from whatever client is nearby would hand jailed code that principal's reach,
which is the failure the broker exists to prevent, reintroduced by the thing meant to test it. The
unused client is a throwing Proxy rather than a real one, so "provably unused" is enforced instead
of asserted.
Plants: recording only what the code SAID (dropping the stamp, the parent and the labels) fails the
rehearsal case; swapping the recorder for the real performer fails the reads case.
The residual seam stays visible and was NOT papered over: a tool call carries arguments and an
agent handles a record, so `default(args)` and `default(record, space)` are still two signatures.
A single file serves both only if it ignores the second argument.

Three things a live session then found, all of them about what the CALLER is told (2026-08-08):
- A REHEARSAL'S FAILURE IS ITS ANSWER. It used to throw, so the loop nacked, at-least-once ran the
  same doomed code six more times, and the caller got a timeout while the diagnosis went to the
  terminal. Two bugs hid this way for a session each. Infrastructure faults return the same way on
  purpose: a jail the worker cannot start is something the caller needs told.
- `write` WITH `record` is REFUSED, not ignored. The flags mean different things (`write` lets a
  program change its TREE; a rehearsal never writes RECORDS by design), and silence sent a model
  looking for another way to run the tree "for real": it added an `import.meta.main` guard, so the
  code ran as a PROGRAM rather than as the agent, which is the one thing the rehearsal checks.
- The `space` API belongs in the TOOL DESCRIPTION. It said the entrypoint is called as
  `default(record, space)` and stopped, so a model guessed `space.put("result", out)`. The host now
  names the signature in the refusal, and the description names all three methods and the await.

**4. Scratch snippets as workspaces. CLOSED, not built (2026-08-06).** It contradicts D1, which is
the later decision and the right one: a throwaway has no identity, and giving every arithmetic
question a manifest and a permanent blob buys nothing. Kept here as a REJECTED option rather than
deleted, because it reads like an obvious next step and is not.
The retention question it was gated on is answered below, and phase 2 made it live regardless: a
procedure is a workspace now, so iterating on one accumulates versions. Measured, 50 successive
edits of ONE procedure: 50 manifests, 50 artifacts, and `summarizeWorkspaces` scanning all 50 to
report one tree, in 2ms. Linear, unreclaimed, and far too cheap at this scale to justify a sweep.
Neither existing mechanism helps, and one would do damage:

| mechanism | why not |
|---|---|
| compaction | `workspace` declares no `contentKey`, so it is untouched. Giving it one is keep-NEWEST, which deletes the version history `workspace-git` exports and fork detection reads |
| retention (`defaultRetentionSeconds`) | would sweep, but `workspace` is not a keyed registry, so "the newest per key survives" does not protect it: it could delete the CURRENT version of a live procedure |
| blob/artifact GC | BUILT since 2026-08-11 (plan-gc.md phase 4): an artifact with declared retention sweeps, and a live `gc` reclaims unreferenced bytes. One with no retention stays permanent, which is what the chat's writers rely on |

So the answer is DO NOTHING STRUCTURAL until a real space shows the read cost. The options if it
ever does, in the order they should be considered: keep-newest-N per workspace name (a bounded
history rather than compaction's keep-1); then explicit forgetting, which needs reference counting
because artifacts are content-addressed and shared between versions AND between trees, so shredding
one naively breaks another tree that shares the file.

**5. `radia`-side parity.** Nothing in the CLI knows about procedures; a tree that is both a
procedure and a binding target has two names for one thing.

## Findings

- **A stdin program CAN import the tree's files.** Deno gives it the URL
  `file://$CWD/$deno$stdin.mts` and the runner sets `cwd` to the tree, so relative specifiers
  resolve into it. The tool description said the opposite ("cannot import them; read and eval") and
  sent the model to `eval`. Verified through `runCode` itself, not a bare `deno run`.
- **The real stdin trap is the DIALECT.** `--ext=js` is added for stdin because it has no filename,
  so a type annotation in the driver is a SyntaxError while the modules it imports may be
  TypeScript. That is almost certainly what the false advice was reaching for.
- **`--allow-read` does not gate MODULE LOADING, and neither does `--deny-read`.** A jailed program
  reads any local `.ts`/`.js` by importing it, and any JSON with an import attribute, outside every
  read root and past every deny. Measured; `Deno.readTextFileSync` on the same path is correctly
  refused. Pre-existing and not introduced here, but `examples/chat/workers/exec.ts` relies on
  `--deny-read` to protect the blob KEK and the operator credential, and both are JSON. There is no
  Deno flag for it (2.9.2); the structural answer is a filesystem-level jail, which inverts
  design-execution.md's measurement that bubblewrap is the weaker backend on filesystem. Needs its
  own remediation entry.
- **Three write-path bugs, all from the entrypoint sitting outside the digest.** Changing only the
  entrypoint deduplicated to a no-op; the content key omitted the conversation, so the same tree
  name in two conversations collided as `idempotency_conflict`; and it omitted the predecessor, so
  editing a tree and editing it back reused a key whose body had changed. All three are the same
  lesson: a content key must carry everything the body carries.
- **A boot program needs somewhere writable, and it is not always the system temp directory.** The
  broker wrote its boot to `/tmp` by default, which is right for a standalone host and wrong for the
  chat's exec worker, which holds write access to its workspace root and nowhere else. `bootRoot`
  exists for that, and the failure without it was another silent nack.
- **A silent nack loop is the least diagnosable failure here. FIXED (2026-08-06).** `agentLoop`'s
  `log` defaulted to a no-op and the nack path used it, so a throwing handler retried invisibly and
  the caller saw only a tool-call timeout. Every one of the bugs above presented identically until
  the log was turned on by hand. Failures now reach stderr when no `log` was given, in both SDKs;
  routine trace stays opt-in. `test/loop.test.ts`, and gotchas.md under leases.
