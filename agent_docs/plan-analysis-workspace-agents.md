# Plan: the analysis pipeline on the workspace-agent deployment

**Status: PLANNED, nothing built.** Analysis 2026-08-17. This is
[research-substrate-lessons.md](research-substrate-lessons.md) action 5 taken to its full shape:
not only pinning stage code with promotion, but running the stages as workspace agents
([architecture-workspace-agents.md](architecture-workspace-agents.md)). It would be the first
worked composition of promotion with something other than an exec runner, and it DELETES a
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
  `codeDigest` becomes the treeDigest, computed by the substrate instead of by the code hashing
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
- **The jail upgrades a promise to enforcement.** `stages.ts` rests its caching soundness on
  stages being pure, "and nothing in the substrate could tell" if one lied. Jailed, a stage has
  no net, no env, no filesystem beyond its inputs and output dir. The clock remains reachable,
  so purity is bounded rather than total.

## The pipeline shape as records (last phase)

The planner walks a FIXED `STAGES` array, so everything above swaps implementations of the three
named stages and can never add a fourth. Making the sequence itself a registry closes that: a
`stage_def` record per stage ({stage, index, resultKind conventions}), read through
`readRegistry` (latest-wins, retire to remove, content-keyed writes, paged to exhaustion like
every registry). This is the kinds-are-records move applied to the pipeline definition. What it
enables is the chat-to-pipeline path for NEW stages, not only new implementations: a
conversation authors a tree (`save_procedure` already yields a bindable workspace with the same
`default(record, space)` contract), and an operator deploys it as `stage_def` + `promote` +
`bind`. Two properties fall out unchanged: inserting or reordering a stage changes the digest
chain, so the memo keys miss and the affected suffix re-runs with no invalidation pass; and
authoring stays unprivileged while deployment stays operator-only, since the def, the pin and
the binding are all writes only an operator can make.

## The three gaps

1. **Input bytes into the jail. THE BLOCKER, and a substrate-extension change.** Broker frames
   are `put | query | read_one`; bytes never travel in a frame; the jail has no net. A stage
   needs the input artifact's bytes, which `worker.ts` today fetches with its own credential.
   Design: HOST-SIDE INPUT MATERIALISATION in `extensions/ts/host.ts`. The claimed record names
   `inputArtifact`; the host fetches it under the AGENT's authority (so the read is authorized
   and the artifact is a data parent, so taint flows) into the run's cwd beside the code tree.
   Generic: any data-processing workspace agent needs this, so it passes the extension
   admission test. `dryRunEntrypoint` needs the same move (materialise a SAMPLE input into the
   rehearsal cwd), or a chat-authored stage can rehearse its frames but not its transform.
2. **`outputDigest` in the result.** The entrypoint's returned body is acked before the
   output-workspace capture turns its file into an artifact. Preferred shape: the entrypoint
   computes the sha256 of the bytes it wrote (crypto works in the jail) and the planner resolves
   digest to artifact id with one indexed `artifact` query at plan time. Keeps `host.ts`
   untouched; the alternative (host enriches the ack from the captured version) is a host change.
3. **Drive the host from work.** `tick()` is one claim per binding per call; wrap it in a watch
   on `stage_request` (small). Two honest regressions: the host publishes no `interest`, so the
   console's routing diagram and dry-run lose these listeners; and the planner's "blocked" state
   becomes "no binding/pin for this stage" instead of "no advertisement".

## Rejected

- A `get_artifact` broker frame: violates "bytes never travel in a frame" and meets the frame
  size cap exactly where real data would.
- Folding input data into the code tree: the digest then changes per dataset, which destroys
  pinning. The code tree's identity must be the code alone.

## Order

1. Host input materialisation (`extensions/ts/host.ts` + a conformance case; the one
   substrate-tier prerequisite).
2. Split `stages.ts` into three entrypoint trees; bootstrap writes them as workspaces.
3. Redeclare `stage_request`/`stage_result` with `workspace` + `tier` indexed paths (additive).
4. Three stage agents; pins on both `take` (request) and `put` (result); bindings; host loop.
5. Planner reads bindings; delete `stage_code` and its grants from `roles.ts`.
6. `smoke.ts` keeps every assertion and adds the one this enables: a result filed under a
   non-pinned digest is REFUSED, the test the current architecture cannot express.
7. The `stage_def` registry replaces the `STAGES` constant, and a smoke case deploys a NEW
   stage into a live pipeline: def + promote + bind, then the suffix re-runs because the digest
   chain changed, and nothing else does.
