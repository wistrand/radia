# Plan: a web UI for the chat

**Status: PLANNED, nothing built.** Analysis 2026-08-18; revised 2026-08-19 to drop the browser
fleet and narrow the goal. Sizes measured against the source.

**The goal, stated narrowly:** a page that signs in over SSO, JOINS a space somebody else is already
running, opens a conversation NAMED IN ITS URL, and takes turns in it. The page holds one run token
and nothing else. Workers, the provider key and the jail stay where they are.

Nothing about the space, the fleet or the wire contract changes. This is a client.

## Dropped: the fleet in the tab

The earlier second stage moved the worker fleet into Web Workers. It is REMOVED, not deferred:

- The chat's demonstration value is its security story, and OS-level isolation is most of it. Web
  Workers keep separate credentials and grants but not separate process permissions, so "the file
  worker cannot reach the network" stops being true.
- The provider key would live in the page, protected by the origin and nothing else.
- A token plus a model plus any loop is unbounded SPEND, with no process to kill.
- Whether OpenRouter permits browser-origin calls was never verified, and the fallback (a relay)
  gives the tab-local story away anyway.

`plan-webworker-sandbox.md` keeps its own reason to exist: code execution inside the browser SPACE
(`plan-browser-space.md`, the docs playground). It is not a step toward a fleet in a tab.

## Why a browser client can be thin

Two things are already built, and together they are most of the work:

- **Join mode** (`examples/chat/chat.ts`, selected by the ABSENCE of an operator credential). A
  session starts no workers, bootstraps nothing, and carries only its own login. `--serve` does the
  privileged half once. The browser is exactly this session with a different renderer.
- **The turn is records** (`plan-chat-turn.md`). The client seeds one `llm_call` and renders; a turn
  worker emits each next link. A dead terminal does not kill a turn, so neither does a closed tab, a
  reload, or a phone locking its screen. Resuming is re-reading the thread.

Measured against the source: `sdk/ts/` has ZERO `Deno.*`, and so do the chat client's protocol files
(`turn.ts`, `thread.ts`, `markdown.ts`, `waiting.ts`, `grants.ts`). Only `terminal.ts` (639 lines),
`edit.ts` (352), `clipboard.ts`, `fleet.ts` and `config.ts` touch Deno. But `turn.ts` (766 lines)
imports ELEVEN functions from `terminal.ts` and calls them at **44 sites**, and `markdown.ts` emits
ANSI. So the port is not "make the chat browser-safe": it is **getting the renderer out of the
protocol**, and that is the only refactor this plan needs.

## SSO is the only sign-in

No token paste box, no operator button, no definition token in the page.

- A run token is short-lived and holds no minting power, so a stolen one expires. A definition token
  in browser storage is a durable credential a person then has to carry between machines.
- There is no durable half to remember, so IdP deprovisioning bites within one run ceiling
  (`plan-oidc.md`).
- The implementation exists twice already and is ~60 lines: `examples/analysis/ui.html`
  (`oidcStart`/`oidcFinish`) and the console's copy in `src/ui/index.html`. Code + PKCE against the
  issuer `GET /v0/health` advertises, nonce checked page-side, id_token to `POST /v0/sessions/oidc`
  for an ordinary run.

Two things that bite and are already documented in `docker/keycloak/README.md`: a new port needs its
own entry in **Valid Redirect URIs**, and the page's token-endpoint call needs the origin in **Web
Origins**, which is a different field. `localhost` and `127.0.0.1` are different origins to an IdP.

**An enrolled identity holds ZERO grants until this app assigns them.** That is the commonest
join-mode failure and it looks identical to a broken token. The page states it in the wording
`chat.ts` already uses ("a valid credential but not this app's grants"), and names `--serve` as the
fix, rather than showing a raw 403.

## Joining costs one URL and one click

The person joining installs nothing, clones nothing, and is handed no token. What they need is a
URL, and the processes that know it PRINT it, on the precedent already in the tree (`radia git-serve`
prints the exact `git clone` line, `radia login --console` prints a sign-in link, and `chat.ts`
prints the console's Graph URL for the live thread at boot).

- **The page starts with the fleet:** `deno task chat -- --serve --web [--web-port 8082]`. One
  command sets the space up, holds the workers and serves the page. The page server is a SPAWNED
  PROCESS, like every fleet member (`client/fleet.ts`), not a listener inside the process holding the
  operator credential: `makeHandler(spaceUrl)` closing over a URL keeps the token out of the handler,
  and a separate process keeps it out of the address space that listens.
- **The banner prints what to send people**, beside the grant line it already prints: the page URL,
  and that signing in is the "Sign in with SSO" button and nothing further.
- **The default port ships registered.** 8082 goes into `docker/keycloak/realm-radia.json` for both
  host spellings, in Valid Redirect URIs and Web Origins, the way 8081 and 8253 already are. A local
  demo then needs no IdP edit at all, and `--web-port` is the case that does.
- **The handoff is free in the direction that costs nothing.** The page knows its own origin, so it
  prints `deno task chat -- --conversation <id>`; the terminal already prints the conversation id,
  which the page takes in a box. Publishing the page URL as a `chat_web` fact so the terminal can
  print a deep link is the tempting version and carries a trap worth paying attention to before
  reaching for it: a NEW grant reaches nobody already admitted, because the auto-grant sweep decides
  each principal once and skips anyone already holding something (`extensions/ts/enrolment.ts`), so
  retro-fitting means enumerating `enrolledPrincipals`. Any grant this page needs and the terminal
  did not carries the same cost.
- **The fragment survives the round trip.** The console already stores `route: location.hash` before
  redirecting to the IdP; a link to a conversation has to land on that conversation after sign-in,
  not on a blank page.
- **The run ceiling must not end the conversation.** An SSO session holds no durable half, so on a
  401 the page re-runs the code flow with `prompt=none` and falls back to a visible redirect if the
  IdP answers `login_required`. UNVERIFIED against Keycloak's config here; check it in Phase 0,
  because the alternative is a thread dying mid-sentence twelve hours in.

## What breaks in a browser and does not in a terminal

Found by review, each verified against the source. These are the parts that make this a port rather
than a re-skin.

**The connection budget, and it binds first.** A chat session parks FIVE long-lived streams
(`WAKE_KINDS` = `llm_chunk`/`message`/`tool_result` in `waiting.ts`, `ToolSet.watch`, and the session
tools' claim loop). A browser allows SIX connections per origin over HTTP/1.1, shared across tabs of
one profile, and the page shares its origin with the relay. So one tab leaves a single connection for
every POST, and two tabs deadlock. There is no one-stream escape: `handleCreateWatch` refuses a
pattern without a `kind` (400 `invalid_pattern`). Three ways out, in order of cost: park at most one
stream and let the fallback tick carry the rest (`WAKE_FALLBACK_MS` is 250ms and the client ALREADY
degrades to it when a watch is refused, so this path is exercised); serve the page over TLS for
HTTP/2; or give the runtime a multi-kind watch, which is a wire change and is named here only so the
option is on the record. Decide it in Phase 0, because the symptom is an app that intermittently
hangs and no error anywhere.

**Artifact bytes must not be relayed onto the page's origin.** `handleGetArtifact` sets
`content-security-policy` and `x-content-type-options: nosniff` and varies them by ORIGIN, while the
analysis relay's response allowlist forwards neither. See the next section, which this requirement
belongs to rather than the problem list.

**A stop button would lie.** `cancelTurn` trips a local `AbortController`; `TurnCancelled`'s own
comment states that claimed work runs to completion and its records land anyway, and the turn worker
resumes a turn while the seed's `deadlineAt` is in the future (`TURN_BUDGET_MS`, 15 minutes). Ctrl-C
in a terminal reads as "stop watching". A button labelled Stop does not. Either label it for what it
does or design a real cancel, which is a chat feature (a record the turn worker honours) and not a UI
one.

**An artifact link that a person can click.** `showArtifact` prints `${url}/v0/artifacts/{id}`, which
is a Bearer URL: fine to curl, 401 in a browser. Every artifact reference the page renders is a
minted capability URL, and the assistant's own instruction to "give them a link they can open" is
only true in the tab once that holds.

**Browser storage is evictable.** Phase 4's person key lives in IndexedDB, which a browser may clear
under storage pressure or with site data. Conversations created only in that browser then need the
operator path (`recover-keys.ts`). Ask for `navigator.storage.persist()` and state that it is a
request, not a guarantee.

**Rejected: hosting the page as a workspace tree on the artifact origin.** It looks like zero
deployment (no relay, no port, the space already serves trees by capability). The tree CSP leaves
`connect-src` unlisted under `default-src 'none'`, so the page could not call `/v0` at all. That
denial is the property the origin exists for.

## Artifacts are links a person can open

REQUIRED, not a nicety: an artifact the chat produced or was handed opens from the page by clicking
it. Today `showArtifact` prints `${url}/v0/artifacts/{id}`, which is a Bearer URL and answers 401 to
a browser, and the assistant's own standing instruction ("give them a link they can open, not an
identifier") is false in a tab until this holds.

Three lanes. The split follows the rule the runtime already applies to itself, which is what a
browser may be trusted to PAINT versus what has to land somewhere isolated:

1. **Inline preview**, for the types the space itself calls renderable (`RENDERABLE` in
   `artifacts.ts`: raster images, audio, video; deliberately not SVG, not PDF, not `text/*`). The
   page reads the bytes through the relay, which is same-origin and therefore the one lane needing no
   CORS, and paints a blob URL built with that explicit media type. It never expires, needs no second
   origin and cannot hit mixed content; it costs memory and one relay round trip per image, and a
   revoke when the node leaves the DOM. Never build a blob URL for a type the page is not itself
   painting: a `blob:` document inherits the page's origin, which is the artifact origin's isolation
   thrown away.
2. **Open**, for everything else, including HTML, SVG, PDF, JSON, text and a workspace tree. A click
   mints `POST /v0/artifacts/{id}/capability` and points a new tab at the returned
   `space.artifactOrigin` URL, which needs no header, which is why that endpoint exists. Mint at
   CLICK time, never at render: a capability lasts `downloadCapabilitySeconds` (300 by default),
   lives in memory and does not survive a space restart. Open the tab synchronously inside the click
   handler and set its location after the mint, or a popup blocker eats it.
3. **Download** is lane 2's URL unchanged: the space already stamps `content-disposition: attachment`
   with the `x-radia-filename` it was given for anything outside its renderable set.

**A capability URL is never stored.** Not in a message body, not in a record, not in scrollback that
outlives it. It is a five-minute bearer link over one artifact; the artifact id is the stable name
and the only thing worth keeping.

**Lane 2 is the one with a deployment cost.** It needs `space.artifactOrigin`
(`http://<advertised>:<artifactPort>`) reachable from the browser and on the SAME SCHEME as the page,
since an HTTPS page cannot load `http://` at all. Where that port cannot be exposed, the page server
binds a SECOND PORT of its own and mirrors the space's split, forwarding `content-security-policy`,
`x-content-type-options` and `content-disposition` verbatim. A second port is a second origin, so the
isolation survives; folding artifacts onto the page's own origin is what must not happen, because it
puts sniffable bytes next to the run token.

**Forward constraint.** Artifact bytes are plaintext today (`extensions/ts/media.ts` seals nothing;
`plan-encryption.md` covers prose). Sealing them would end lane 2 by construction, because the
artifact origin holds no key and must not be given one, leaving in-page decryption to a blob URL and
therefore images only.

## The conversation is named, never enumerated

A session deliberately does not hold `conversation: query`: listing every conversation on the space
is a real widening to save a keystroke (`resolveConversation` in `chat.ts`). So:

- The conversation id lives in the URL fragment, on the console's precedent (`#c/<id>`), which makes
  a reload, a bookmark and a shared link all the same mechanism.
- "New conversation" is a `put` the session already holds, and it rewrites the fragment.
- There is no conversation picker, and `--conversation last` has no browser equivalent. Both need
  enumeration.

## Two clients on one conversation: read-only until the order is the space's

A terminal and a tab open on one `conversationId` do NOT see each other today, and the two halves
fail for different reasons:

- **Nothing watches for messages it did not write.** `runTurn` streams its own call's result by
  `callId` and follows `nextCall`; no client watches `message{conversationId}` for foreign authors.
  So a message typed in the tab never reaches the terminal even though both are allowed to read it
  (a `message` body carries `owner` AND `conversationId`, and the session's grant scopes on one of
  them, so authorization is not the blocker here).
- **The transcript is numbered by the client.** `index` is client-held single-writer state, stated
  as such in `thread.ts`'s header, and it does not stay in that file: a turn seeds `upToIndex`, the
  inference worker writes the assistant message at `upToIndex + 1`, and the turn worker derives each
  reply slot from there. Two clients driving turns therefore collide across a whole turn's slots,
  not on one write, and the damage lands in the context window every later turn reads.

So concurrency is a phase, not a rendering detail:

1. **Read side first.** Any client watches `message{conversationId}` and renders what it did not
   write, on `reactorLoop` (`plan-reactor-loop.md`) rather than a hand-rolled watch. A viewer
   attaches WITHOUT `Thread.open`/`resume`, both of which append a fresh system message.
2. **A second client is read-only until the write side lands**, and says so. That is the whole of
   the interim rule: open the tab on a thread the terminal is driving and watch it run.
3. **Then the order becomes the space's.** Drop the client counter and order the transcript by
   RECORD ID, which the runtime assigns as a monotonic ULID; `query` already paginates that way
   (`after` + `dir`), so `upToIndex` becomes `upToId` and the context window becomes a keyset scan.
   Touches `thread.ts`, `turn.ts`, `extensions/ts/context.ts`, `extensions/ts/inference.ts` and the
   `message` kind's sortable paths.

**Two TABS are the common case and the browser arbitrates them for free.** `navigator.locks` is
per origin and shared across a profile's tabs, so the tab holding the conversation's lock is the
writer and the rest show a viewing banner with a Take over button, which is safe because a lock moves
rather than being shared. It covers nothing else: a second profile, a private window, a phone or the
terminal are all outside it, and there the rule is one writer by discipline until step 3 lands. Two
tabs also double the stream demand against a budget of six, which is the other reason a browser
client parks as few streams as it can.

Rejected as the whole fix: claiming a slot by putting `index` in the idempotency key. It reads like
optimistic append and is not, because an idempotency key is scoped to the DURABLE IDENTITY behind
the caller (`Space.idem`), so it separates two of one person's clients and never the workers, which
are the writers that derive their slots from `upToIndex`.

Sequential handoff needs none of this and works now: `--conversation <id>` resumes by reading the
highest existing index.

## Phases

Each phase ships alone and has a check.

**Phase 0: the page, the relay, and sign-in.** Copy `examples/analysis/serve.ts` (a client that
happens to listen: serves one page, relays `/v0/*` with the CALLER's Authorization header, holds no
credential), started by `--serve --web`. SSO gate, identity read back from `GET /v0/ops/permissions`
rather than assumed, the missing-grants message, the fragment kept across the redirect, port 8082 in
the shipped realm. No chat yet.
*Check:* sign in against `docker/keycloak` with one URL and one click, see your own principal and
grants. Four things get answered here rather than later, because each one changes what Phase 2 may
assume: that SSE is not buffered through the relay, that `prompt=none` renews a lapsed run without a
visible redirect, how many parked streams the page may hold before requests start queueing, and
whether the browser reaches `space.artifactOrigin` directly or the page server has to mirror it on a
second port.

**Phase 1: the `ChatUI` port.** One interface covering what the protocol half asks the terminal for:
streaming answer sink, status on/off, notice, artifact display, width, dim/truncate as formatting
HINTS rather than escape codes. Thread it through `turn.ts`, `waiting.ts` and `grants.ts` instead of
the direct imports; `terminal.ts` becomes one implementation. `markdown.ts`'s `AnswerStream`
(`push`/`end`, with a passthrough implementation) is the shape to generalise. Split `markdown.ts`'s
PARSE from its ANSI emit.
*Check:* `deno task chat` looks and behaves identically; the existing suites (`smoke-render.ts`,
`smoke-markdown.ts`, `smoke-turnlink.ts`) are the guard. Then the structural one, which is why this
phase is separable at all: `deno bundle` the browser entry and grep the output for `Deno.`, exactly
as `scripts/build-browser.sh` does for the jail bundle. A reference that survives the tree-shake
fails the build instead of the tab.

**Phase 2: the DOM implementation.** Message list, streaming answer, tool calls, progress records,
and artifacts as openable links (all three lanes above; lane 2 needs the artifact-origin reachability
answered in Phase 0, and a page that cannot reach it says so rather than rendering a dead link).
Input is a textarea: do NOT
port `terminal.ts` or `edit.ts`, which are a line editor, raw mode and clipboard staging that the DOM
gives free. The interrupt is labelled for what `cancelTurn` does (stop following) unless a real
cancel is designed first. The page prints the `--conversation <id>` line for the terminal.
*Check:* a page-level smoke in the chat's own harness, no API key, on `conformance/console.test.ts`'s
structural precedent. This is also where the bundle stops being a build detail: the page needs one,
so `deno task bundle-chat-web` joins `bundle-browser`, output gitignored.

**Phase 3: the live view.** Watch `message{conversationId}` and render what this client did not
write, in the terminal as well as the page; a second client attaches read-only and appends no system
message. Two things belong here and not in Phase 2, because without them the plan's premise is
invisible: on attach, find the newest unanswered `llm_call` and resume streaming its `llm_chunk`s, so
a turn survives the tab that started it; and reconcile on `visibilitychange`, because a backgrounded
tab has its timers throttled and its streams dropped, which is the case `reactorLoop`'s tick exists
for.
*Check:* start a turn, close the tab, reopen it, and watch the same turn finish. A tab opened on a
thread the terminal is driving shows it running and writes nothing to the transcript.

**Phase 4: the session's own tools in the tab.** `serveTools` with the inspection set, on the
session's own credential. It belongs in the page for the same reason it is in the REPL and not a
worker: a delegated run carries no ops power and loses `scope: {createdBy: "self"}`, so nobody else
can answer these (`client/session-tools.ts`). Nothing here touches Deno (`tool-worker.ts`,
`agent-tools.ts`, `capability.ts` and `encrypted.ts` are clean), and the cost is the one the terminal
already has: a client that goes away mid-call leaves that call unanswered until its lease expires.
*Check:* ask the assistant something only `space_query` can answer, from the page.

**Phase 5: attachments and vision.** Upload through the relay, whose header allowlist already
carries `x-radia-meta`, `x-radia-filename` and `x-radia-parent-ids`. A browser file picker and paste
replace Ctrl-V staging; the retention rule is unchanged, so the page says an attachment is permanent.

**Phase 6: encrypted conversations.** A person's key is a PAIR PER MACHINE, and a browser profile is
a new machine (`plan-encryption.md`). So the page generates a key pair into IndexedDB, publishes the
public half as `person_key`, and can read a conversation only once a machine that already reads it
enrols this one. Until that lands, a page opening an encrypted conversation REFUSES and says why:
`assertReadable` is fail-closed, and rendering ciphertext to a person is the failure it exists to
stop.

**Phase 7: two writers.** Order the transcript by record id and retire the client counter, per the
section above. Only after this may a second client send. It is last because it is the only phase
that changes a shape the workers share, and everything before it is useful without it.
*Check:* two clients alternating turns on one conversation, with the inference worker's
reconstructed context asserted against what was actually said.

## Not in scope

- The fleet, `--serve`, and every privileged setup verb. The page cannot do them and must not offer
  them.
- Conversation listing, procedure authoring in the page, and terminal input editing.
- Approving a grant request. The page can ask (`grants.ts` comes across with the port); answering is
  the operator's, and stays in the CLI.
- CORS. The relay exists only because the space sends no CORS headers
  (`research-app-lessons.md`). If the runtime ever allows an origin, the relay becomes a static file
  server and this plan loses a file.
