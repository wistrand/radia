# Radia extensions

Extensions are reusable application conventions built on the public `/v0` API. They provide
workspaces, sandbox selection, tool workers, inference, encrypted fields, promotion, hosting and
export without adding those concepts to the runtime kernel.

## Dependency tiers

| Tier | Test | Examples |
|------|-------------------------------------------|-------------------------------------------------|
| **Core** (`src/`) | Does the RUNTIME have to know? | taint labels (it computes and enforces them), grants, artifacts, erasure, leases |
| **Extension** (here) | Would two different apps want the same convention? | workspace manifests, tree digests, path rules, `sandbox` records and runners |
| **Application** (`examples/*`) | Neither | the chat's `conversation`/`message`/`llm_call` kinds, its grant lists, its REPL |

A workspace is an extension because it composes existing records and artifacts, is reusable across
applications and has security-sensitive path and digest rules. The runtime remains unaware of files
and directories.

## Admission rule

Code belongs in `extensions/` only when all three conditions hold:

1. It composes `/v0` and imports only the SDK, never `src/`.
2. A second consumer exists or is explicitly identified.
3. Any trust-boundary output has a specification and conformance test.

## Normative surfaces

Four surfaces cross trust boundaries and are normative:

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
  details are part of it, because a shim that gets them wrong hangs rather than fails, and they are
  now small: frames are lines of JSON on a PRIVATE pipe pair whose paths the host passes in, so
  there is no marker and no interleaving rule. BYTES never travel in a frame either: a run's binary
  output is a FILE in its output workspace (`Binding.outputWorkspace`). A new LANGUAGE is a shim against this spec, not a
  second broker.

All of them are specified by `extensions/conformance/`, which is the contract any implementation
has to meet, in any language.

## Layout

| Path | Role |
|--------------------------|--------------------------------------------------------------|
| `ts/workspace.ts` | multi-file working trees: manifest, tree digest, path safety, materialisation, an `entrypoint` the tree declares (OUTSIDE the digest, so re-pointing is not a new promotion, which also means it must join the dedupe check and the content key or changing it is a silent no-op), and `attach` (an artifact that already exists becomes a file in a tree, moving no bytes and becoming a data parent so its labels follow). `writeWorkspace`, `editWorkspace` and `commitWorkspace` take an optional `reader`, because each READS before it writes (the predecessor, its bytes, the fork check) and under delegation the two halves are different credentials: authoring a tree is the worker's own capability, looking at the one being superseded is bounded by whoever it belongs to. Defaults to the writing client, so an undelegated caller is unchanged |
| `ts/sandbox.ts` | running untrusted code in a jail, plus the spec describing it and the probe that tries to escape. Three backends and, separately, a filesystem CONFINER: a read permission does not bound MODULE LOADING, so an unconfined Deno jail reads any JSON its user can read, and only a mount namespace (bubblewrap) or a Seatbelt profile closes it. `runCode`/`runEntry` are the Deno jail (stdin or a FILE, and a file states its own dialect), `runBwrap` and `runSeatbelt` the other two. Python's Seatbelt profile must `(deny default)` while Deno's may `(allow default)`, because only Deno denies the other axes itself. Imports nothing |
| `ts/sandbox-registry.ts` | a sandbox as a RECORD: the operator declares, the worker verifies before serving |
| `ts/git.ts` | a workspace's version history projected into a real git repository. Export only, no dependency, no `git` binary. `buildWorkspaceRepo` returns the objects in memory; the disk export and the HTTP server are two SINKS for one builder, so neither reimplements the correspondence |
| `ts/git-http.ts` | that history served for `git clone`: routes, the repo cache, and authorization as the CALLER, re-checked when a fetch starts. Both protocols, since the dumb routes cost two `if`s and are what anything without a git client can read. Read-only; push is refused in words |
| `ts/git-pack.ts` | the SMART protocol: pkt-lines, the advertisement, `want`/`done`, and an undeltified packfile. Measured before it was built (22 versions of a 9-file tree = 96 objects, so 98 dumb round trips against 2 smart ones). NOT normative: two packs of one history may differ, only the object ids must match |
| `ts/export-git.ts` | the runnable form: `deno task workspace-git --name <ws> --dir <out>` (serving is `radia git-serve`) |
| `ts/otlp.ts` | threads as OTLP traces, attempts as spans: a CLIENT that pushes, the way git-serve is a client that listens. Deterministic content-derived ids (re-export dedupes in the collector; consequently one id is sent ONCE, which is why the follower holds a family until its ancestor's open attempt settles instead of freezing the ancestor at zero-duration), the first IN-EXPORT parent nests and every other parent becomes a Link (a dangling parentSpanId is Jaeger's "not in the trace" + Incomplete; the follower backfills ancestry for the same reason), services resolve run → agent through `agent_run` RECORDS (the principal string carries no name), taint travels as label attributes, unsettled work says `radia.open` over a deliberate 1ns point-span (collectors refuse `end == start`). Runnable form: `radia otlp --to <collector> (--thread <id> \| --follow) [--trace-root <kind>]`; any OTLP/HTTP collector (Jaeger v2, Tempo, Alloy) accepts it on `/v1/traces` |
| `ts/promotion.ts` | which CODE a tier may run, as a grant rotation: a pattern-scoped grant pins `exec_request` to a workspace digest, promotion writes the new pin and retires the old, rollback is promotion pointed backwards. The promotion state IS the grant registry, so the event chain covers it and `radia pins <runner> --tier <t>` answers "what is prod running" from the enforcement path (`radia permissions` shows the whole fold). Runnable form: `radia promote` / `radia rollback`. Two footguns it exists to hold: GRANT before retire (retire-first leaves a window claiming nothing, and only a test on the ORDER OF WRITES can see it), and revive a retired identity through `RadiaClient.grant`'s `:after:` anchor or a rollback reports success and grants nothing |
| `ts/compartment.ts` | who can get data OUT of a compartment, from the grants that decide it. Crossing is reserved to a principal granted BOTH sides, and nothing enforces that but the grants themselves, so `auditCompartment` finds the ones who hold both, plus the two doors that are not grants (`observe` reads every body, `declassify` clears labels) and the one kind that cannot be partitioned (`artifact` is reserved: scoped by pattern or not at all). `unexpectedCrossers` is the promotion checklist as a function, and `radia compartment --inside <kinds> [--expect <p,p>]` is its runnable form. Its caveats name what it cannot see, starting with privileged principals |
| `ts/host.ts` | a generic host that runs a workspace's code AS the agent it belongs to: a `binding` record names the digest and entrypoint, the host mints that agent's run and CLAIMS UNDER IT, so `created_by`, `lease_owner` and delegation are the agent's and one host serving ten agents needs none of their authority. Two locks (binding + pattern-scoped grant) are each inert alone, and building it found they must also AGREE: a binding at one digest while the grant pins another is refused (`digest_mismatch`) rather than run. The invoker is pluggable; the default materialises the tree and runs the entrypoint in the Deno jail. Runnable form: `radia host --agent <p>=<definition-token>` (brokered by default), with `radia bind` / `radia bindings` for the binding itself. `treeCache` keys materialised trees by DIGEST, which is what makes reuse provably safe rather than merely likely (changed code is a different key, so a warm entry cannot be stale). The PROCESS is deliberately not pooled: that argument covers code, not the state a reused interpreter carries between claims |
| `ts/broker.ts` | how jailed code participates without ever holding a credential: the entrypoint gets `(record, space)`, `space` writes PROPOSALS to a PRIVATE PIPE PAIR, and the host performs them under the AGENT's run token. NORMATIVE (the frame format), because this is the boundary between model-written code and an agent's authority. Three properties follow: the host stamps labels and the compartment field from the jail's DECLARED powers, so the code cannot lie about what it touched; every brokered put carries the claimed record as a parent, so it cannot launder lineage either (and the runtime then computes `foreign` on its own); and idempotency keyed on `(claimed record, output ordinal)` makes a retried attempt's writes a replay. `dryRunEntrypoint` rehearses all of that and writes NOTHING: same shim, same frames, same jail, proposals recorded with the host's rules already applied, reads refused because a rehearsal holds no credential. ANY language (a shim in `RUNTIMES`; the host never learns which asked) and ANY backend (`resolveSandbox` reads the binding's `sandboxPattern`), chosen independently. Sharing stdout with an entrypoint that logs WAS the hard part (a write with no trailing newline swallowed the next frame and hung the jail until a timeout naming the wrong cause), and the framing rules that answered it are gone: frames travel on two FIFOs whose paths the host passes in, so a frame is one line of JSON with no marker and no interleaving rule. Its cost is `--allow-run=mkfifo` on the HOST, taken over a unix socket's `--allow-net` in the JAIL. Stdout and stderr are diagnostics only, each capped, and every failure names the exit code and carries both ENDS of the output, since a Python traceback keeps its point last and a JavaScript one keeps it first |
| `ts/encrypted.ts` | the clear marker on a body whose prose is ciphertext, the refusal every reader owes it, and the per-conversation keys. A convention rather than a mechanism: the runtime never inspects prose, so `message.content` can be ciphertext without matching or the event chain noticing, and what it cannot do is stop a reader from rendering ciphertext as text. `assertReadable(body, where)` names the READER and raises; the set of markers this build can read is EMPTY until keys land (agent_docs/plan-encryption.md). A tool worker's refusal is an ANSWER, never a nack: an undecryptable body will not decrypt on redelivery. One DEK per conversation, wrapped TO the fleet (RSA-OAEP: in join mode the SESSION creates the conversation, so it must wrap for a fleet whose secret it must not hold, and wrapping to a symmetric KEK is holding it) and UNDER each person's own key (AES-KW, wrapper and reader being the same party there); unwrapped TWICE, once as AES-GCM and once as HKDF, so the nonce can be derived without the DEK ever becoming extractable. `sealBody`/`openBody` seal the fields `ENCRYPTED_FIELDS` names per kind, and OPENING is what clears the marker — a whitelist would disarm the refusal for a reader that forgot to decrypt. A keyed write derives its nonce from the idempotency key so a retry is byte-identical and REPLAYS; an unkeyed one is random. Tool ARGUMENTS seal one level down (inside the assistant message, leaving `id` and `function.name` clear), so a turn router copies an opaque blob and needs no key at all. Wraps are keyed by KEY ID rather than by principal, because a person is several machines: `withWrapsFor` extends a conversation to a newly published key, and only a holder can, since adding a wrap needs the DEK |
| `ts/enrolment.ts` | "everyone the IdP vouches for may use this app", as a sweep an app parameterises with its own grants. An SSO identity enrols holding NOTHING (plan-oidc.md), so somebody has to decide; this is the shape of saying yes once instead of per person. The app supplies one function; the rest is shared because each part has a failure behind it — paging the identity registry to exhaustion (a person off the page is never admitted), deciding once per process (or a busy space pays a `permissions` read per identity per sign-in), and never re-assigning to someone who already holds something (`grant` revives a retired grant, so a blind re-assign undoes an operator's narrowing). Banning is RETIRING the mapping; revoking grants only holds until the next restart |
| `ts/team.ts` | several agent harnesses (Claude Code, Codex, anything speaking MCP) sharing one space to pass work between them: two kinds of its own (`task`, claimable so a lease is what stops two agents doing it twice, routed by `tags` because `assignee` names a performer and binds nothing; `note`, a mailbox by `to` and a thread by `topic`), two it extends with `team` (`artifact`, and `capability`, which is how a member says what it can do so `task.tags` has something to match), and the grant set a member holds. A member is an AGENT DEFINITION rather than a run, which is the whole reason it is a convention worth sharing: a run is what `created_by` names and dies at the 12h ceiling, so attribution resting on one lasts a day, while every run a definition mints resolves back to the same `agent:` name for as long as the space exists. `definitionState` is read before creating one because a SECOND definition is not a rotation and looks like one: both tokens keep minting while `radia revoke` reaches only the newest. `observe` is opt-out rather than assumed, since it is the only power that opens `space_get`/`space_lineage`/`space_children`/`space_stats`/`space_events` at all and it opens EVERY body. Teams are ISOLATED by default: grants are pattern-scoped to a `team` field, `bodyMatchesGrant` refuses a write carrying another team's label or none at all, and `observe` is opt-in because it is unscoped and reads every team off the ops plane. See [agent_docs/architecture-teams.md](../agent_docs/architecture-teams.md). Runnable form: `radia team add <name>… [--team <t>]…`, which also prints the harness config (`src/surfaces/mcp/config.ts`); the label itself is filled in by `src/surfaces/mcp/scope.ts` |
| `conformance/` | the contract an implementation must meet (`deno task test:extensions`) |

Three isolation backends ship: `deno-permissions` (JS, safe by ABSENCE of flags), `bubblewrap` (any
interpreter, safe by PRESENCE of them) and `sandbox-exec` (macOS Python, where a Seatbelt profile is
the whole boundary because Python brings no permission model). Safe-by-presence is why every
declaration is PROBED before it is served: verified directly, a bwrap jail missing `--unshare-all`
reaches the network while its record still claims it cannot.

Separately from the backend, a `confiner` bounds the FILESYSTEM: bubblewrap on Linux, `sandbox-exec`
on macOS, none on Windows. It exists because a read permission does not cover module loading, so a
Deno jail without one reads any JSON its user can read (agent_docs/plan-jail-confinement.md).
Consequence for languages: both run on Linux and macOS, but not behind the same shape of profile.
The Deno jail's Seatbelt profile may `(allow default)` because its flags deny every other axis;
Python's must `(deny default)` and grant upward, because it has no flags at all.

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
