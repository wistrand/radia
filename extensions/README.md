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

Both are specified by `extensions/conformance/`, which is the contract any implementation has to
meet, in any language.

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
| `conformance/` | the contract an implementation must meet (`deno task extensions`) |

Two isolation backends ship: `deno-permissions` (JS, safe by ABSENCE of flags) and `bubblewrap`
(any interpreter, safe by PRESENCE of them). That difference is why every declaration is PROBED
before it is served — verified directly, a bwrap jail missing `--unshare-all` reaches the network
while its record still claims it cannot.

Selection is by CAPABILITY NAME, not by a field: a runner publishes `run_javascript` or
`run_python` only where that backend probed clean, so an unavailable language is undiscoverable
rather than a runtime failure. Nothing dispatches on a sandbox record; the record is what a policy
binds to and what the probe tests. See [design-execution.md](../agent_docs/design-execution.md).

## Language parity

TypeScript only, and deliberately. [sdk/README.md](../sdk/README.md) freezes Python to the core
surface, so extensions follow. The SPEC is what makes another binding possible; the library does
not have to exist twice for the convention to be shared.

## Versioning

Extensions ship in the npm package alongside the SDK and are **not** covered by the frozen wire
contract. The SDK mirrors `/v0` one method per verb and carries that stability promise; a convention
here evolves. Anything normative (above) carries its own version tag so a change is detectable
rather than silent.
