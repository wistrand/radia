# The analysis pipeline on the workspace-agent deployment

**Status: BUILT, all seven steps, 2026-08-17** (planned and built the same day; renamed from
`plan-analysis-workspace-agents.md`, keeping the step and gap numbers because source comments cite
them). This is [research-app-lessons.md](research-app-lessons.md) action 5 taken to
its full shape: not only pinning stage code with promotion, but running the stages as workspace
agents ([architecture-workspace-agents.md](architecture-workspace-agents.md)). It is the first
worked composition of promotion with something other than an exec runner, and it DELETED a
registry (`stage_code`) rather than adding one.

## Why

The pipeline's memo rests on a claim: each worker hashes its own `stages.ts` and advertises the
digest (`examples/analysis/worker.ts`, `stagesDigest`). Nothing verifies it. A worker reporting
digest X while running Y files every result, and caches it, under a version that never produced
it. The same doc records the second wart this closes: "which code is live" has two mechanisms
(promotion enforces, `stage_code` discovers) and no convention joining them.

## The mapping

- **Stage code becomes workspaces.** Each stage is a tree with an `entrypoint` exporting
  `default(record, space)`, the contract `WorkspaceHost` + `brokeredInvoker` already run.
  `codeDigest` becomes the treeDigest, computed by the runtime instead of by the code hashing
  itself. Side effects for free: per-stage invalidation granularity (the one-file coarseness
  `stages.ts` apologises for), multi-file stages, Python stages via the sandbox registry.
- **`stage_code` is deleted.** The planner's `liveCode()` reads BINDINGS (`readBindings`) for
  discovery; the promotion pin enforces; the host's `digest_mismatch` refusal catches the two
  disagreeing. Bindings, not pins, because reading the `grant` kind is operator-flavored and
  `binding` is an ordinary readable kind.
- **The three workers become one host.** `WorkspaceHost` already takes `requestKind`, so it
  claims `stage_request` for `agent:analysis-clean`/`-features`/`-report`. Routing moves from
  pattern-per-stage-name plus an in-handler digest check to the grant pattern itself:
  `promote()` pins `{workspace: <digest>, tier}`, so an agent can only claim requests naming its
  tree, and `worker.ts`'s "leaving this, I serve another digest" branch dissolves into
  authorization. Requires `stage_request` to INDEX `workspace` and `tier` (the pin pattern is
  hardcoded to those paths), effectively renaming `codeDigest` to `workspace`.
- **Pin the RESULT side too.** Grant each agent `stage_result: put` with pattern
  `{workspace: <digest>}`: `bodyMatchesGrant` then refuses a result that lies about which code
  produced it, a hole the current design cannot close. `stage_result` indexes `workspace` for it.
- **Deployment becomes the demo.** Edit-and-restart becomes `writeWorkspace` + `radia promote
  <digest> --tier prod --kind stage_request --pin agent:analysis-clean:take` + `radia bind`; the
  memo keys miss and the cascade re-runs. Rollback is `radia rollback`, "what is prod running"
  is `radia pins`, not an advertisement.
- **Outputs are stamped for the requester.** Found in build, not in analysis: capture stamps
  artifacts with the workspace's owner (the AGENT), so a person's `{owner}`-scoped grant stopped
  reaching the report computed for them. `Binding.outputMeta` names claimed-record fields the host
  copies onto every captured artifact's meta, winning over the defaults (`["owner", "dataset"]`
  here), stamped host-side where the code cannot lie about whom the work was for.
- **The jail upgrades a promise to enforcement.** `stages.ts` rests its caching soundness on
  stages being pure, "and nothing in the runtime could tell" if one lied. Jailed, a stage has
  no net, no env, no filesystem beyond its inputs and output dir. The clock remains reachable,
  so purity is bounded rather than total.

## The pipeline shape as records (last phase)

BUILT (order step 7 below). The planner used to walk a FIXED `STAGES` array, so everything above
swapped implementations of the three named stages and could never add a fourth. Making the
sequence itself a registry closed that: a `stage_def` record per stage ({stage, index}), read
through `readRegistry` (latest-wins, retire to remove, content-keyed writes, paged to
exhaustion like every registry). This is the kinds-are-records move applied to the pipeline definition. What it
enables is the chat-to-pipeline path for NEW stages, not only new implementations: a
conversation authors a tree (`save_procedure` already yields a bindable workspace with the same
`default(record, space)` contract), and an operator deploys it as `stage_def` + `promote` +
`bind`. Two properties fall out unchanged: inserting or reordering a stage changes the digest
chain, so the memo keys miss and the affected suffix re-runs with no invalidation pass; and
authoring stays unprivileged while deployment stays operator-only, since the def, the pin and
the binding are all writes only an operator can make.

## The three gaps

1. **Input bytes into the jail. BUILT** (`Binding.inputs` + `materializeInputs`, host.ts;
   cases in `extensions/conformance/host.test.ts`). Broker frames are `put | query | read_one`;
   bytes never travel in a frame; the jail has no net. The binding declares which body FIELDS
   name artifact records, and the host fetches them under the AGENT's authority (so the read is
   authorized, and the artifact is a data parent of the result and every brokered put, so taint
   flows) into `input/<path>` in the run's cwd (`INPUT_DIR`), which capture excludes. Without an
   output tree the input dir IS the cwd, read-only. `dryRunEntrypoint({inputFiles})` is the
   rehearsal half: caller-supplied sample bytes, same layout, no credential.
2. **`outputDigest` in the result. BUILT** as preferred: the harness computes the sha256 in the
   jail, and the planner bulk-resolves digest -> artifact id in `readPass` (one `$in` query per
   pass, so the pass stays flat; `smoke.ts` counts it). The UI and `smoke.ts` resolve the same
   way, falling back to `outputArtifact` on pre-host records.
3. **Drive the host from work. BUILT** in the example (`examples/analysis/host.ts`): drain on
   start, then a watch on `stage_request` under the reader identity; a drain stops when nothing
   acks or fails, so `digest_mismatch` waits for an operator instead of spinning. The two
   regressions stand as predicted: no `interest` published, and "blocked" still means "no
   advertisement" until step 5.

## Rejected

- A `get_artifact` broker frame: violates "bytes never travel in a frame" and meets the frame
  size cap exactly where real data would.
- Folding input data into the code tree: the digest then changes per dataset, which destroys
  pinning. The code tree's identity must be the code alone.

## Order

1. Host input materialisation (`extensions/ts/host.ts` + a conformance case; the one
   extension-tier prerequisite). BUILT 2026-08-17, gap 1 above.
2. Split `stages.ts` into three entrypoint trees; bootstrap writes them as workspaces. BUILT
   2026-08-17: `examples/analysis/stages/<name>/main.ts` + a shared `harness.ts` (per-tree copy,
   one artifact by content), `publishStageWorkspaces` at bootstrap, and the worker advertises the
   treeDigest of its own tree, asserted equal to the published one in `smoke.ts`. Per-stage
   invalidation arrived with it, and `dryRunEntrypoint({inputFiles})` rehearses a stage tree with
   no space (the rehearsal cwd is writable, mirroring the host's output-tree layout).
3. Redeclare `stage_request`/`stage_result` with `workspace` + `tier` indexed paths (additive).
   BUILT 2026-08-17: bodies renamed `codeDigest` -> `workspace`, requests stamped with
   `tier` (`PIPELINE_TIER`), `codeDigest` kept declared for pre-rename records and read as a
   fallback in the memo key and the UI. `smoke.ts` asserts both pin paths are matchable.
4. Three stage agents; pins on both `take` (request) and `put` (result); bindings; host loop.
   BUILT 2026-08-17: `agent:analysis-<stage>` hold only container grants (workspace, artifact);
   both work grants come from two `promote` calls per stage (results echo `tier` so the hardcoded
   pin pattern matches), `deployStages` writes pins + bindings (inputs, `outputWorkspace`,
   `outputMeta`) and the `stage_code` BRIDGE the planner still reads until step 5. `worker.ts` is
   deleted; `examples/analysis/host.ts` runs all three brokered under a least-privilege reader
   identity. The smoke's "left unclaimed" check now passes through AUTHORIZATION: no pin matches
   the bumped digest.
5. Planner reads bindings; delete `stage_code` and its grants from `roles.ts`. BUILT 2026-08-17:
   `liveCode` is now `readBindings` keyed by `stageAgent(stage)`, the kind, the bridge write and
   every `stage_code` grant are gone (persons and the planner read `binding` instead), and the
   smoke's code-change test rebinds rather than re-advertises — which also demonstrates the two
   locks: a rebind without a promotion leaves the new digest's work unclaimable.
6. `smoke.ts` keeps every assertion and adds the one this enables: a result filed under a
   non-pinned digest is REFUSED, the test the current architecture cannot express. BUILT
   2026-08-17: a forged `stage_result` under the features agent's own credential 403s at the
   write, with a positive control (identical body, pinned digest, accepted) proving the refusal
   is about the digest and nothing else.
7. The `stage_def` registry replaces the `STAGES` constant, and a smoke case deploys a NEW
   stage into a live pipeline: def + promote + bind, then the suffix re-runs because the digest
   chain changed, and nothing else does. BUILT 2026-08-17: the planner and the UI walk
   `readStageDefs` (latest-wins, index-ordered, retire to remove), `liveCode` inverts the
   `agent:analysis-<stage>` convention so a later-deployed stage needs no code change anywhere,
   the `STAGES` constant survives only as "which trees this repo ships" (deployment writes one
   def per built-in, indexes gapped by 10), and the smoke deploys a fourth stage (`tldr`) under a
   SECOND host process — the running one never learns it exists — with nothing already computed
   re-running.
