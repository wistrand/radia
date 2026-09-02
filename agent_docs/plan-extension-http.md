# Extension conventions over HTTP

STATUS: FIRST SLICE BUILT 2026-09-02 (`src/surfaces/extserve.ts` + the `radia serve-ext` verb in
`src/surfaces/cli.ts`, default port 7791 since a space occupies 7788+7789 and git-serve holds
7790; `beatPresence` added to `extensions/ts/presence.ts` as the stateless single beat the
facade's `POST beat` needs). Verified end to end against a live space: workspace
write/list/read/file/edit, the digest verification round trip, path refusal, capability
declare/publish/tools with presence policing, presence declare/beat/live, and the turn
seed-and-wait long-poll (result delivered in 1.6s with lineage intact). Building it added one
route class the design section below did not name: `POST /ext/{workspace,capability}/v1/declare`
writes the convention's own `KindDef`, because a bare space refuses everything until setup
declares the kinds and the declaration (the `contentKey`, the indexed paths) is exactly what a
non-TS app would mis-declare. Slice 2 (below, 2026-09-02) closed the rest: the binding guard,
the second tier, the scope answer, and the Python wrapper.
One stated limitation: `awaitResult`'s coordination-plane fallback (for callers without the ops
read tier) is a newest-100 window per poll, and says so in the code.

HARDENED 2026-09-02 after a review pass: unknown body fields are refused BY NAME on every POST
(`rejectUnknownFields`, the facade's own `rejectUnknown` since a surface may not import
`src/server/problem.ts` — a misspelled `scope` would otherwise widen a workspace write across
compartments, plan-bounded-reads.md's class); a seed whose wait fails answers with the `seedId`
beside the error, since the seed is already written and an id-less error invites a duplicating
retry; the tools endpoint's presence policing FAILS OPEN per `liveAdvertisements`' contract (an
unreadable view polices nothing, reported as `policed: false`); malformed percent-encoding is a
400 rather than an escape to a bare 500; the file route follows the main-origin paint rule
restated from `src/server/handlers/artifacts.ts` (raster/audio/video inline, everything else
`attachment`, always nosniff under `default-src 'none'; sandbox`); every response is
`cache-control: no-store`; `WriteInput.ignore` and the seed's `availableAt`/`deadlineAt`/
`retentionUntil`/`taint` pass through instead of dropping. The review's last three items closed
the same day: request bodies are capped at 32 MiB (`MAX_BODY_BYTES`, matching the workspace
capture ceiling, checked without trusting Content-Length, 413), the relay base brackets a literal
IPv6 host and maps each wildcard to its family's loopback (the same fix applied to the sibling in
`startServer`'s artifact origin), and the co-hosted mount logs the facade's failures through the
process log (4xx that are not the caller's 401/404, and 5xx as warnings).

SLICE 2 BUILT 2026-09-02, four items:
- **The binding guard** (`test/extserve.test.ts`, in `test:runtime`): cases each crossing
  the boundary rather than round-tripping it (see Contract discipline above for why interop is
  the form), plus the co-hosted MOUNT hook proven directly (forwarded, passed through, and every
  shadowing or malformed prefix refused at construction). The interop cases that earn their keep: a capability retired over HTTP then revived by the
  DIRECT implementation still surfaces in the HTTP tool list (the `:after:` anchor is the write a
  forked binding replays), two HTTP beats in one refresh window are ONE record beside a TS beat,
  and a promote/rollback rotation through HTTP reads back through `pinnedDigests` both ways.
- **The scope answer**: `GET /ext/permissions/v1/scopes` returns which pattern-scope fields the
  CALLER's own grants bind, per kind, from `effectivePermissions` (any principal may read its
  own). DISCOVERY, never a fill: patterns union every grant on a kind whatever operation it
  permits (architecture-teams.md), so which one to stamp on a write stays the caller's explicit
  `scope`, and the response's `note` says so. This is the stateless replacement for the MCP
  adapter's learned-from-refusal label, closing the open question above.
- **The second tier**: `promotion/v1` (declare, `promote`/`rollback` as two routes over one
  implementation, `pins` read from the enforcement path), `host/v1/bindings` (the latest-wins
  projection, `?agent=` filter), `compartment/v1/audit` (`?inside=`, `?field=`). Grant writes
  stay operator-only by relay: the space refuses a non-operator, never the facade.
- **The Python wrapper** (`sdk/py/radia_ext.py`, staged into the pip package as `radia.ext` by
  `scripts/build-release.sh`): stdlib-only, ZERO choreography — every method is one HTTP call,
  and the one client-side convenience is splitting str/bytes file values into
  `files`/`filesBase64` (encoding, not choreography). Exercised by the suite's python3-gated
  case over a real facade socket, with the tree it writes read back by the direct TS API.

CO-HOSTING BUILT 2026-09-02, same day: `radia dev --ext` / `radia serve --ext` mounts the same
handler at `/ext/` on the space's own port, so a client's base URL is the only difference between
the two hosting modes. The mechanism keeps the layering honest: `ServerOptions.mount` is a
GENERIC `{prefix, handler}` hook (`src/server/http.ts`, `Mount`), validated at construction
(`/v0/` and `/ui/` refused as prefixes, one lowercase segment), and the entry point (`src/main.ts`)
is what wires the surface's handler into it, so the runtime forwards a prefix and learns nothing
and `test/openapi.test.ts` sees no new route literal. The mounted facade stays an ordinary `/v0`
client relaying each caller's Bearer token over loopback to the very port it is mounted on: same
process, no shortcut through `Space`. Discovery is `GET /ext/health` (the standalone port keeps
`/health` too); CORS applies to the mounted namespace only, `/v0` is untouched. Verified live:
`/v0/health` and the whole workspace round trip on one port, 401 without a token, preflight 204.

## The problem

Extensions are reusable conventions composed from `/v0`, distributed as TypeScript imports
(`extensions/ts/`). An app backend in Python, Go or C# can speak the frozen wire contract
directly, but the conventions themselves are import-only, and imports do not cross languages.
The existing non-TS access paths each serve a different audience: the MCP adapter serves model
harnesses, the CLI serves people and CI, and CORS (still missing,
[research-app-lessons.md](research-app-lessons.md)) would serve browsers. None serves a program
that builds ON the space. Today that program either shells out to the CLI or hand-implements the
choreography, and hand-implementing it exports this codebase's most repeated bug class
([plan-bounded-reads.md](plan-bounded-reads.md)) to every app in every language.

The runtime already conceded this argument once, one level down: server-side registry projection
exists because a latest-wins fold reimplemented per client kept going wrong, and it is documented
as the only correct path from Python. When a convention's correctness matters cross-language, it
needs a SERVED home, not a ported one.

## What an extension carries, and which layer HTTP is for

- **Vocabulary** (kind names, field shapes, usage): stays a RECORDS problem. Kinds are records;
  `query {kind: kind_def}` plus the `usage` string is the designed cross-language channel, and
  the discover-don't-hardcode corollary binds apps too. If an app cannot learn a convention's
  kinds from the space, thicken the `usage` strings; never restate them in an endpoint that can
  drift.
- **Choreography** (multi-step writes with ordering rules): the facade's actual job.
  `writeWorkspace`'s predecessor read, fork check and scope refusal; `publishCapability`'s
  read-before-write and `:after:` anchor; presence's window-keyed beats. Each has a silent
  failure behind it that prose cannot transmit.
- **Folds** (reads composing several queries): `summarizeWorkspaces`, `pinnedDigests`,
  `liveAdvertisements` + `collapseByTool`. Served, they cannot be re-derived wrong.
- **Normative pure functions** (`treeDigestOf`, `validatePath`): verification endpoints, so an
  app can CHECK a digest even when the facade computed it.

## The decision shape

A new verb in `src/surfaces/` (working name `radia serve-ext`), in git-serve's slot: a client
that happens to listen. It binds its own port, composes `/v0` through the SDK, imports
`extensions/ts/` conventions, and never takes a value from `src/core`/`server`/`storage`
(`test/layering.test.ts` applies unchanged). No runtime change, no wire-contract entry.

- The facade holds ZERO credentials. Every `/v0` call relays the caller's own Bearer token, the
  way `extensions/ts/git-http.ts` authorizes as the CALLER. It adds no authority, so there is no
  confused deputy and no need for the delegation machinery
  ([plan-delegation.md](plan-delegation.md)), which exists for workers acting with authority of
  their own.
- Scope is in the contract from day one: workspace routes take a `WorkspaceScope` and an
  ambiguous lookup is refused NAMING the choices, matching `ScopeFiller.choose`. Open question
  below on the team write label.
- Same binary, no new artifact to install. Two hosting modes, same routes: the standalone verb
  (`radia serve-ext`, its own port), and co-hosted (`--ext` on `radia dev`/`serve`, mounted at
  `/ext/` on the space's port through the generic `ServerOptions.mount` hook; see the status note).
- CORS is on: the facade is not the runtime, and browser apps are a legitimate caller here.

## First slice (app-facing), second tier (operator-facing)

First: workspace read/list/write (scoped), capability publish + live-tool discovery, presence
beat + `livePresence`, and an `llm_call` seed-and-wait facade (publish the record, wait for the
result record; coordination stays in the space, see [plan-chat-turn.md](plan-chat-turn.md)).
Second: promotion and compartment audit, whose consumers are CI and operators and whom the CLI
serves today. Never: direct run endpoints for host/tool-worker/inference (they would bypass
claiming, leases, lineage and delegation), or any central service for `encrypted.ts` (key
custody contradicts the per-machine person keys, [plan-encryption.md](plan-encryption.md)).

## Contract discipline

- The routes are a BINDING of the conformance contract, never the definition: the normative
  surfaces stay `treeDigestOf`, `validatePath`, the git object encoding and the broker's
  behaviour (`extensions/README.md`), specified by `extensions/conformance/`.
- The definition of done is the binding proven against the direct TS API. Built as
  `test/extserve.test.ts` (slice 2) rather than re-running `extensions/conformance/` wholesale:
  those suites import the TS functions directly and live in a tier that may not import `src/`, so
  the guard took the INTEROP form instead, every case running an operation through one side and
  verifying it through the other on the shared records (an HTTP retire the TS projection honours,
  a TS revive the HTTP tool list shows). That catches a fork where a binding-only round trip
  cannot, because a facade that keyed its writes differently would still agree with itself.
- Versioned per extension, explicitly NOT frozen, and never added to `openapi/radia.yaml`:
  extensions evolve with the binary, and freezing the facade would pin the extension layer as
  hard as the kernel, losing what the tier split bought. There IS an OpenAPI document,
  `openapi/radia-ext.yaml` (built after slice 2), for the cross-language audience that reaches for
  one first — but as a SEPARATE file whose `info.description` states the non-frozen policy in
  words, since a reader who finds an OpenAPI file assumes a contract. It DESCRIBES the routes and
  never generates them (that would be the declaration-to-routes framework this doc rejects). The
  single statement both the dispatch and the spec read is `EXT_ROUTES` in `src/surfaces/extserve.ts`
  (the dispatch takes each POST allowlist from it via `fieldsOf`, which throws on a missing entry).
  `test/extopenapi.test.ts` holds the spec to that table both ways (documented==served, request
  fields and query params field-for-field) AND the DISPATCH to the table both ways: every table
  route is one the dispatcher recognises, and every `rest === "…"` branch the dispatch serves is a
  table path (the three workspace regex routes are covered behaviourally by the binding suite and
  asserted to be the only regex branches). That closes the direction the frozen spec's
  `openapi.test.ts` has and a hand-kept table most needs: a route added to the dispatch without a
  table entry. An unguarded spec would be worse than none for an audience that cannot read the TS
  to correct it, so the guard is the precondition, not an extra. One documented caveat: the
  `files/{path}` route accepts slashes in the path, which an OpenAPI path parameter cannot express,
  so the param carries a note (the facade decodes the whole path before matching, so an encoded or
  raw slash both reach the file).
- Thin per-language wrapper packages are fine while they hold no logic. Any client-side
  reimplementation of a fork check or a digest is a port of the SPEC with conformance run
  against it, never a convenience copy: the broker's rule (a new language is a shim against the
  spec) applies.

## Rejected

- **`/v0/extensions/*` inside the runtime.** Violates the dependency direction (the runtime
  imports no extension), grows the frozen contract per convention, and turns the extension tier
  into kernel surface.
- **A generic declaration-to-routes projection framework.** A second wire contract with none of
  `test/openapi.test.ts`'s discipline; hand-write the few routes that earn their keep. Discovery
  belongs in `capability` records the facade publishes, not a bespoke `GET /extensions`.
- **SDK ports as the primary answer.** O(languages x extensions) of security-sensitive
  maintenance; a `validatePath` that differs between implementations is a hole, not an
  inconsistency. Ports remain possible via `extensions/conformance/`; they are not the plan.
- **Token exchange / a facade principal.** A facade with authority of its own must then decide
  what callers may do, which is the confused-deputy boundary the zero-credential relay deletes.

## Open questions

- ANSWERED (slice 2): the team write label stays explicit, and became discoverable instead of
  learnable: `GET /ext/permissions/v1/scopes` surfaces which pattern fields the caller's grants
  bind, the app passes `scope` explicitly from then on, and ambiguity stays a refusal naming the
  choices.
- Seed-and-wait transport: long-poll bounded by a client deadline, or relaying a `/v0` watch as
  SSE. The browser six-connections budget (plan-chat-web-ui.md) argues against multiplying
  parked streams.
- Availability: apps will treat the facade as load-bearing. State plainly that it is stateless
  and restartable, and that everything it does is reachable over `/v0` plus a conformance port.

Read this before adding an extension endpoint, before porting an extension to another language,
and before proposing a `/v0` addition whose real subject is a convention.
