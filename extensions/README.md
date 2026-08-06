# Radia extensions

Conventions built ON the substrate, for things more than one application wants and the runtime has
no business knowing about.

## The three tiers, and the test for each

| Tier | Test | Examples |
|------|-------------------------------------------|-------------------------------------------------|
| **Core** (`src/`) | Does the RUNTIME have to know? | taint labels (it computes and enforces them), grants, artifacts, erasure, leases |
| **Extension** (here) | Would two different apps want the same convention? | workspace manifests, tree digests, path rules, `sandbox` records and runners |
| **Application** (`examples/*`) | Neither | the chat's `conversation`/`message`/`llm_call` kinds, its grant lists, its REPL |

A workspace is not core: the substrate has no opinion about files, and a manifest is `putArtifact`
plus a `kind_def` plus a projection, built from primitives that already exist. Putting it in `src/`
would make the runtime claim to know what a path and a file mode are, and every space would carry a
`workspace` kind whether it wanted one or not.

It is also not one app's: any code-generating agent wants it, path validation is security-critical
and must not be reimplemented per app, and a tree digest has to be computed identically everywhere
or attestations do not compare.

## Admission rule

An `extensions/` directory is an invitation to become a junk drawer. Three conditions, all of them:

1. **It composes `/v0` and imports only the SDK.** Never `src/`. If it needs a runtime change it is
   not an extension. This is the same dependency rule [examples/README.md](../examples/README.md)
   states, and it is what keeps the tiers from collapsing into each other.
2. **A second consumer exists or is named.** Not "an agent might want this": the chat plus one more,
   or a stated user.
3. **If it produces an ATTESTABLE fact, it ships a spec and a conformance test**, not just an
   implementation.

## Normative surfaces

Most of what lives here is a convenience. Two things are not, and the difference matters because
they cross a trust boundary:

- **`treeDigestOf`** is what a `check` attests to, so a verdict from one language binding and one
  from another are comparable only if both hash the tree byte for byte identically. The digest
  carries its algorithm version (`t1:<hex>`) so a change is visible rather than silently
  incomparable; that lesson cost this codebase a real bug once already, in `grantKey`.
- **`validatePath`** is a security boundary. A rule that differs between implementations is a hole,
  not an inconsistency.
- **The git object encoding** (`gitObjectId` and the tree layout in `ts/git.ts`) has to be byte
  identical everywhere, or two exports of one workspace are not comparable and `git log` across them
  is meaningless. It is pinned by known-answer vectors taken from the real `git` binary, plus a
  round trip through `git fsck` and `git clone` where one is installed.
- **The broker frame format** (`ts/broker.ts`) crosses the biggest trust boundary here:
  model-written code against an agent's authority. A second implementation that speaks it
  differently is not a variant, it is a hole, so the escape probe and the host-side rules (labels,
  the compartment stamp, the forced parent, the idempotency key) are a contract. The framing
  details are part of it, because a shim that gets them wrong hangs rather than fails: a leading
  newline before every frame, a control character (`\x01`) leading both markers, and a marker
  found mid-line reported as interleaving. A new LANGUAGE is a shim against this spec, not a
  second broker.

All of them are specified by `extensions/conformance/`, which is the contract any implementation
has to meet, in any language.

## Layout

| Path | Role |
|--------------------------|--------------------------------------------------------------|
| `ts/workspace.ts` | multi-file working trees: manifest, tree digest, path safety, materialisation, and `attach` (an artifact that already exists becomes a file in a tree, moving no bytes and becoming a data parent so its labels follow) |
| `ts/sandbox.ts` | running untrusted code in a permissionless subprocess, plus the spec describing that jail and the probe that tries to escape it. Imports nothing |
| `ts/sandbox-registry.ts` | a sandbox as a RECORD: the operator declares, the worker verifies before serving |
| `ts/git.ts` | a workspace's version history projected into a real git repository. Export only, no dependency, no `git` binary. `buildWorkspaceRepo` returns the objects in memory; the disk export and the HTTP server are two SINKS for one builder, so neither reimplements the correspondence |
| `ts/git-http.ts` | that history served for `git clone`: routes, the repo cache, and authorization as the CALLER, re-checked when a fetch starts. Both protocols, since the dumb routes cost two `if`s and are what anything without a git client can read. Read-only; push is refused in words |
| `ts/git-pack.ts` | the SMART protocol: pkt-lines, the advertisement, `want`/`done`, and an undeltified packfile. Measured before it was built (22 versions of a 9-file tree = 96 objects, so 98 dumb round trips against 2 smart ones). NOT normative: two packs of one history may differ, only the object ids must match |
| `ts/export-git.ts` | the runnable form: `deno task workspace-git --name <ws> --dir <out>` (serving is `radia git-serve`) |
| `ts/otlp.ts` | threads as OTLP traces, attempts as spans: a CLIENT that pushes, the way git-serve is a client that listens. Deterministic content-derived ids (re-export dedupes in the collector; consequently one id is sent ONCE, which is why the follower holds a family until its ancestor's open attempt settles instead of freezing the ancestor at zero-duration), the first IN-EXPORT parent nests and every other parent becomes a Link (a dangling parentSpanId is Jaeger's "not in the trace" + Incomplete; the follower backfills ancestry for the same reason), services resolve run → agent through `agent_run` RECORDS (the principal string carries no name), taint travels as label attributes, unsettled work says `radia.open` over a deliberate 1ns point-span (collectors refuse `end == start`). Runnable form: `radia otlp --to <collector> (--thread <id> \| --follow) [--trace-root <kind>]`; any OTLP/HTTP collector (Jaeger v2, Tempo, Alloy) accepts it on `/v1/traces` |
| `ts/promotion.ts` | which CODE a tier may run, as a grant rotation: a pattern-scoped grant pins `exec_request` to a workspace digest, promotion writes the new pin and retires the old, rollback is promotion pointed backwards. The promotion state IS the grant registry, so the event chain covers it and `radia pins <runner> --tier <t>` answers "what is prod running" from the enforcement path (`radia permissions` shows the whole fold). Runnable form: `radia promote` / `radia rollback`. Two footguns it exists to hold: GRANT before retire (retire-first leaves a window claiming nothing, and only a test on the ORDER OF WRITES can see it), and revive a retired identity through `RadiaClient.grant`'s `:after:` anchor or a rollback reports success and grants nothing |
| `ts/compartment.ts` | who can get data OUT of a compartment, from the grants that decide it. Crossing is reserved to a principal granted BOTH sides, and nothing enforces that but the grants themselves, so `auditCompartment` finds the ones who hold both, plus the two doors that are not grants (`observe` reads every body, `declassify` clears labels) and the one kind that cannot be partitioned (`artifact` is reserved: scoped by pattern or not at all). `unexpectedCrossers` is the promotion checklist as a function, and `radia compartment --inside <kinds> [--expect <p,p>]` is its runnable form. Its caveats name what it cannot see, starting with privileged principals |
| `ts/host.ts` | a generic host that runs a workspace's code AS the agent it belongs to: a `binding` record names the digest and entrypoint, the host mints that agent's run and CLAIMS UNDER IT, so `created_by`, `lease_owner` and delegation are the agent's and one host serving ten agents needs none of their authority. Two locks (binding + pattern-scoped grant) are each inert alone, and building it found they must also AGREE: a binding at one digest while the grant pins another is refused (`digest_mismatch`) rather than run. The invoker is pluggable; the default materialises the tree and runs the entrypoint in the Deno jail. Runnable form: `radia host --agent <p>=<definition-token>` (brokered by default), with `radia bind` / `radia bindings` for the binding itself. `treeCache` keys materialised trees by DIGEST, which is what makes reuse provably safe rather than merely likely (changed code is a different key, so a warm entry cannot be stale). The PROCESS is deliberately not pooled: that argument covers code, not the state a reused interpreter carries between claims |
| `ts/broker.ts` | how jailed code participates without ever holding a credential: the entrypoint gets `(record, space)`, `space` writes PROPOSALS to stdout, and the host performs them under the AGENT's run token. NORMATIVE (the frame format), because this is the boundary between model-written code and an agent's authority. Three properties follow: the host stamps labels and the compartment field from the jail's DECLARED powers, so the code cannot lie about what it touched; every brokered put carries the claimed record as a parent, so it cannot launder lineage either (and the runtime then computes `foreign` on its own); and idempotency keyed on `(claimed record, output ordinal)` makes a retried attempt's writes a replay. `dryRunEntrypoint` rehearses all of that and writes NOTHING: same shim, same frames, same jail, proposals recorded with the host's rules already applied, reads refused because a rehearsal holds no credential. ANY language (a shim in `RUNTIMES`; the host never learns which asked) and ANY backend (`resolveSandbox` reads the binding's `sandboxPattern`), chosen independently. Sharing stdout with an entrypoint that logs is the hard part and is why the framing is normative: a write with no trailing newline used to swallow the next frame and hang the jail until a timeout naming the wrong cause. Both streams are capped and every failure names the exit code and carries the TAIL of stderr, which is where a stack trace keeps its point |
| `conformance/` | the contract an implementation must meet (`deno task extensions`) |

Two isolation backends ship: `deno-permissions` (JS, safe by ABSENCE of flags) and `bubblewrap`
(any interpreter, safe by PRESENCE of them). That difference is why every declaration is PROBED
before it is served — verified directly, a bwrap jail missing `--unshare-all` reaches the network
while its record still claims it cannot.

The backend and the LANGUAGE are independent, and neither implies the other. A language
contributes a broker shim and nothing else (`RUNTIMES`, ~30 lines each for JavaScript and
Python); the jail comes from the `sandbox` record a binding's `sandboxPattern` resolves to
(`resolveSandbox`). Conflating them is how "python means bubblewrap" becomes a rule nobody wrote
down. Which WORKER serves is a separate question, answered by capability name: a runner publishes
`run_javascript` or `run_python` only where that backend probed clean, so an unavailable language
is undiscoverable rather than a runtime failure. See
[design-execution.md](../agent_docs/design-execution.md).

## Language parity

TypeScript only, and deliberately. [sdk/README.md](../sdk/README.md) freezes Python to the core
surface, so extensions follow. The SPEC is what makes another binding possible; the library does
not have to exist twice for the convention to be shared.

## Versioning

Extensions ship in the npm package alongside the SDK and are **not** covered by the frozen wire
contract. The SDK mirrors `/v0` one method per verb and carries that stability promise; a convention
here evolves. Anything normative (above) carries its own version tag so a change is detectable
rather than silent.
