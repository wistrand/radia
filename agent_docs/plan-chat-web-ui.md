# Plan: a web UI for the chat

**Status: PHASES 0-5 AND 7 BUILT 2026-08-19.** A page that signs in over SSO, attaches to a conversation,
takes turns, and shows what other clients say (`examples/chat/web/`, `--serve --web`,
`deno task bundle-chat-web`), on the `ChatUI` port in `client/ui.ts` and the shared live view in
`client/live.ts`; phase 6 (encrypted conversations in a browser) is what remains. Analysis 2026-08-18; revised 2026-08-19 to drop the browser
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
- **The handoff works both ways, and neither direction costs a grant.** The page knows its own
  origin, so it prints `deno task chat -- --conversation <id>`. The terminal PROBES for the page
  (`http://<space host>:8082`, overridable with `--web-url`/`RADIA_CHAT_WEB`) and prints
  `…/#c/<id>` only when something answers carrying the page's own marker. Publishing the URL as a
  `chat_web` fact was the tempting version and carries a trap worth knowing before reaching for it:
  a NEW grant reaches nobody already admitted, because the auto-grant sweep decides each principal
  once and skips anyone already holding something (`extensions/ts/enrolment.ts`), so retro-fitting
  means enumerating `enrolledPrincipals`. A probe answers "there IS a page there" rather than
  "there should be", which config cannot.
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
option is on the record. TAKEN: the first, all the way to zero. The page opens no watch at all, and
`LoopOptions.watch: false` (phase 4) is what let the claim loop join it there. Decide it in Phase 0, because the symptom is an app that intermittently
hangs and no error anywhere.

**Artifact bytes must not be relayed onto the page's origin.** `handleGetArtifact` sets
`content-security-policy` and `x-content-type-options: nosniff` and varies them by ORIGIN, while the
analysis relay's response allowlist forwards neither. See the next section, which this requirement
belongs to rather than the problem list.

**A stop button stops the turn but not the round in flight.** Escape already writes a
`cancel{conversationId, owner, turnAt}` record under the key `cancel:<conv>:<turnAt>`, and the turn
worker reads it before emitting each next link (`extensions/ts/turn.ts`), so a cancelled turn stops
advancing even with every client gone. What it does not do, per `TurnCancelled`'s own comment, is
recall an `llm_call` or `tool_call` already claimed: those finish and write their results. The page
writes the same record with the same key, so a turn stopped in one client is stopped in all of them,
and the label says "stop this turn" rather than implying the round in flight was undone.

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

## Two clients on one conversation

A terminal and a tab open on one `conversationId` do NOT see each other today, and the two halves
fail for different reasons:

- **Nothing watches for messages it did not write.** `runTurn` streams its own call's result by
  `callId` and follows `nextCall`; no client watches `message{conversationId}` for foreign authors.
  So a message typed in the tab never reaches the terminal even though both are allowed to read it
  (a `message` body carries `owner` AND `conversationId`, and the session's grant scopes on one of
  them, so authorization is not the blocker here).
- **The transcript was numbered by the client.** `index` was client-held single-writer state: a turn
  seeds `upToIndex`, the inference worker writes the assistant message at `upToIndex + 1`, and the
  turn worker derives each reply slot from there. Two clients driving turns therefore collided
  across a whole turn's slots, not on one write. FIXED in phase 7 by claiming the slot; what remains
  is ambiguous display order between records written in the same instant.

So concurrency is a phase, not a rendering detail:

1. **Read side first. BUILT** (`client/live.ts`, phase 3): any client renders what it did not
   write, supervised by `reactorLoop` (`plan-reactor-loop.md`) rather than a hand-rolled watch, and
   a viewer attaches with `Thread.attach`, which is `resume` minus the system message.
2. **A second client is read-only until the write side lands**, and says so. BUILT for tabs of one
   profile (`navigator.locks`, with a lock that moves on Take over); across machines and against
   the terminal it stays discipline.
3. **Then the write side. BUILT (phase 7), and NOT by ordering on record id.** `append` claims its
   slot with an idempotency key, so a second client loses the race and takes the next slot. What
   that buys is the thing that mattered: `turnAt` IS the index a turn started at, so unique slots
   mean two concurrent turns cannot share an identity, and no worker addressing
   `{turnAt, round, role}` can answer with the other turn's records.

   Ordering by RECORD ID was the plan and did not survive contact. Two findings killed it. A record
   cannot be addressed BY ITS OWN ID on the coordination plane (`readOne` matches bodies; get-by-id
   is the ops plane), so every index-based address — the router's `classifyOf: {conversationId,
   owner, index}`, the turn worker's slots — has no one-for-one translation. And `turnAt` is
   declared `integer` across four kinds, so making it an id is an index-type change on live data,
   not an edit. The remaining cost of NOT doing it is display ORDER between records written in the
   same instant, which is ambiguous in any concurrent conversation, rather than corruption.

**Two TABS are the common case and the browser arbitrates them for free.** `navigator.locks` is
per origin and shared across a profile's tabs, so the tab holding the conversation's lock is the
writer and the rest show a viewing banner with a Take over button, which is safe because a lock moves
rather than being shared. It covers nothing else: a second profile, a private window, a phone or the
terminal are all outside it, and since phase 7 none of them need it. Two tabs also double the stream
demand against a budget of six, which is the other reason a browser client parks as few streams as
it can.

**What the idempotency-key claim does and does not reach, since it is what shipped.** It is scoped to
the DURABLE IDENTITY behind the caller (`Space.idem`), so it separates one person's clients and not
two people's, and it never reaches the WORKERS, which derive their slots from `upToIndex` and claim
nothing. Both are survivable for one reason: a worker's slot is only ever addressed through the
`turnAt` its call carries, and phase 7 made those unique.

Sequential handoff needs none of this and works now: `--conversation <id>` resumes by reading the
highest existing index.

## Phases

Each phase ships alone and has a check.

**Phase 0: the page, the relay, and sign-in. BUILT 2026-08-19.** `examples/chat/web/serve.ts` is the
client that happens to listen (one page, `/v0/*` relayed with the CALLER's header, no credential of
its own), spawned by `--serve --web` through `launchWebUi` so the process holding the operator
credential is not the one bound to a port. `web/ui.html` is the SSO gate: code + PKCE, the nonce
checked page-side, the fragment carried across the redirect in `sessionStorage`, identity and grants
read back from `GET /v0/ops/permissions` rather than assumed, and the missing-grants case named with
the `grant-user.ts` line that fixes it. A lapsed run renews itself with a top-level `prompt=none`
redirect, falling back to a visible one on `login_required`; the iframe form is not used, because a
third-party IdP cookie is blocked or partitioned in every browser that matters. Port 8082 ships in
the Keycloak realm, both spellings, both fields.

Two things the build added that the plan had not called for. The page's own CSP names the IdP
origin in `connect-src`, learned from the space's health probe rather than configured, because the
page talks to the issuer directly and a policy that did not name it would block sign-in. And the
relay forwards `last-event-id`, without which every watch reconnect silently restarts from now.

The page shows the IdP's display name beside the enforced principal, taken from the id_token it
verified itself. A session holds no `oidc_identity` grant, so the enrollment record the terminal
reads (when it happens to be an operator) is not available to it; the claim is decoration and the
principal stays visible because that is what every record is stamped with.

*Check:* `smoke-web.ts` (`deno task chat-test web`) covers the server half: the relay refuses an
unauthenticated call while holding an operator token in its own environment, artifact responses keep
the `content-security-policy`, `nosniff` and `content-disposition` the space set, and a watch streams
unbuffered and resumes from `Last-Event-ID`. WRITTEN BUT NOT RUN. The browser half stays manual: sign
in against `docker/keycloak` with one URL and one click. Two questions Phase 2 depends on are still
open, deliberately: how many parked streams the page may hold before requests queue behind the
six-connection budget, and whether the browser reaches `space.artifactOrigin` directly or the page
server has to mirror it on a second port.

**Phase 1: the `ChatUI` port. BUILT 2026-08-19.** `client/ui.ts` holds the interface (write,
ensureLine, columns, trunc, dim, notice, holdLine, answerStream, showStatus, endStatus,
statusLineOn, showArtifact) and delegates to whichever implementation is installed. `terminal.ts`
exports `terminalUI` and is now one implementation of it, unchanged in behaviour: not a line of
rendering moved. `turn.ts`, `waiting.ts` and `grants.ts` swapped ONE import line each and kept all
44 call sites, which is what made the change safe to do without a rendering diff to review.

Three decisions worth carrying forward. `dim` and `trunc` are hints whose result belongs to the
implementation that produced it, so a DOM `dim` may return a marked string its own `write` turns
into markup; never inspect one from outside. The default surface is a line-buffered `console`
writer rather than a thrower, so a missing install degrades instead of crashing, and it uses
`console` rather than the platform so this file stays as portable as what it serves. And installing
is EXPLICIT (`installUI(terminalUI)` in `chat.ts`, and in the five suites that assert on or want
terminal output), never on import, or a front end would acquire a terminal by importing something
for an unrelated reason.

**Splitting `markdown.ts`'s parse from its ANSI emit turned out to be unnecessary, and Phase 2 says
why:** the DOM renderer consumes the ANSI the shared parser already emits and converts it, so there
is one parser and one emit format rather than two of either. See the Phase 2 entry.

*Check:* the structural one is now permanent, in `smoke-web.ts`: bundle `turn`/`thread`/`waiting`/
`grants`/`ui` and assert the output contains no `Deno.`, the same check `scripts/build-browser.sh`
makes of the jail bundle. Measured on the day: 14 modules, 35.5KB, zero references. `deno task chat`
is unchanged, and `smoke-render`/`smoke-markdown`/`smoke-turnlink` remain the guard on that.

**Phase 2: the DOM implementation. BUILT 2026-08-19.** `web/dom-ui.ts` implements `ChatUI` for a
document, `web/auth.ts` holds the sign-in dance, and `web/app.ts` is the browser's counterpart to
`chat.ts`: it signs in, attaches to a conversation, and calls the SAME `runTurn`. Input is a
textarea; `terminal.ts` and `edit.ts` were not ported, because a line editor, raw mode and clipboard
staging are what the DOM gives free. Stop calls `cancelTurn`, which is what writes the `cancel`
record, so it stops the turn rather than this client's view of it. `deno task bundle-chat-web`
builds `app.js` (gitignored, 57KB, 16 modules), and `--serve --web` builds it before serving so a
fresh checkout has no build step in front of it.

Four decisions this phase made that the plan had not:

- **The markdown parser was not split, and does not need to be.** `MarkdownStream` emits ANSI; the
  DOM sink converts it to nested spans as it arrives, using the same converter that renders every
  `write` call, because `dim` returns ANSI here too. One parser, one emit format, and a closed code
  set we are the only producer of. What it costs is that tables and rules stay CHARACTER-drawn, so
  answers render in a monospace block; a real `<table>` is what would need the split.
- **Nothing is built with innerHTML.** Text arrives as text nodes and styling as spans, so an
  answer, a tool's output or a filename cannot become markup.
- **The page parks NO watch streams.** `waiting.ts` already degrades to its 250ms reconcile tick
  when a watch is refused, so the browser takes the tick as its spine and leaves the six-connection
  budget alone. Whether it can afford one stream is a measurement nobody has taken.
- **The page is markup and the logic is the bundle**, which buys `script-src 'self'` with no
  `unsafe-inline` at all. A token in `sessionStorage` is worth that.

Two things beyond the phase's list, because without them "connect to an existing conversation"
does not work: attaching to a named conversation RENDERS ITS HISTORY (ascending by `index`, through
the same surface the live turn uses), and an ENCRYPTED conversation is refused with the terminal
command that can open it, rather than shown as ciphertext.

The page also links into the console's Graph tab on the live conversation, which is the affordance
the terminal prints at boot and the ONLY thing the injected space URL is for. It arrives as a `meta`
tag, since the page carries no inline script: `/v0` goes through the relay, but the browser may
reach the space itself by a different name than the page server does.

*Check:* `smoke-web.ts` bundles the real browser entry and asserts it reaches no platform API (16
modules, zero `Deno.` references), that the page is markup whose only script is the bundle, and that
a missing bundle explains itself instead of leaving a blank page. Rendering, sign-in and the artifact
lanes stay manual until there is a browser in the loop.

**Phase 3: the live view. BUILT 2026-08-19.** `client/live.ts` is shared by both front ends:
`liveView` supervises with `reactorLoop` and renders through the port, so what the page draws and
what the terminal draws cannot drift. Callers pass the wakeup hints their host can afford — the
terminal a `message{conversationId}` watch, the page NONE, living on the 1s tick, because six
connections per origin is a page's whole budget. `renderMessages` is shared with the page's history
rendering for the same reason, with an `onUser` hook because a bubble is a thing only a document
has.

The rule that keeps a live view from fighting the local client is one line: `accountedFor()` is the
thread's own cursor, and everything at or below it was rendered by whoever advanced it. `busy()` is
the second: a foreign message arriving mid-turn WAITS, which is `holdLine`'s rule applied to a whole
turn rather than a line.

- **`Thread.attach`** is `resume` minus the system message, and `resume` is now attach plus that
  append, so the two cannot drift. Appending is a write; a viewer performs none.
- **Resuming a turn in flight** is `findOpenTurn` plus a `resumeFrom` parameter on `runTurn`, not a
  second loop: everything after the seed was already identical. It checks all four ways a turn is
  over (no call, `turn_complete`, `cancel`, an answer with no tool calls) plus a passed
  `deadlineAt`, because following a finished turn means waiting out `INFERENCE_DEADLINE_MS` in
  silence and then reporting a timeout that never happened.
- **One writer per conversation per browser profile**, elected with `navigator.locks`; the lock
  MOVES on a `BroadcastChannel` "release", so Take over is safe. Where the API is absent everybody
  writes, since refusing to let someone type would be worse than the collision it avoids.
- **`visibilitychange`** catches up immediately rather than waiting for the next tick.

*Check:* `smoke-live.ts` (`deno task chat-test live`) covers all three properties without a model: a
viewer writes nothing while `resume` writes exactly one message, a second client's message is
rendered and attributed while one arriving mid-turn waits, and `findOpenTurn` answers every way a
turn can be open or over, including a re-dispatched call resolving to the untiered one. The
tab-to-tab handoff stays manual.

**Phase 4: the session's own tools in the tab. BUILT 2026-08-19.** The page serves the inspection
set on its own credential and offers `SESSION_TOOL_SCHEMAS` to the model, which is two lines because
nothing in that path was ever terminal-specific. It belongs in the page for the same reason it is in
the REPL and not a worker: a delegated run carries no ops power and loses `scope: {createdBy:
"self"}`, so whoever is asking has to be the one answering (`client/session-tools.ts`).

**It cost one SDK option, and that is the interesting part.** `agentLoop` opens one watch per
distinct kind, so serving tools would have quietly spent a connection out of a page's six. Rather
than accept it or hand-roll a claim loop, `LoopOptions.watch: false` leaves the loop on its tick
alone, threaded through `ServeOptions` and `serveSessionTools`. It is safe because the take-side
poll was always the correctness argument here and a watch is a wakeup hint, the same relationship
`ReactorOptions.patterns` states on the fact side; what it costs is up to a second of latency,
against a tool call that takes longer than that. So the page still parks NO streams.

Every tab serves, viewer or not: claims are leased, so two tabs cannot answer one call, and the
redundancy is free — a tab that goes away mid-call leaves it to another rather than to the lease
clock.

*Check:* `conformance/loop.test.ts` proves the option (an intercepted `POST /v0/watches` is never
made, and the work is still claimed twice on the tick), and `smoke-web.ts` proves the shape end to
end (a `space_stats` call answered by a tick-only session worker).

**Phase 5: attachments and vision. BUILT 2026-08-19.** A picker, a paste and a drop on the
conversation all end in the same place: `staging` from `client/attachments.ts`, reused verbatim. That
matters more than the three input paths, because it carries the rule the terminal learned the hard
way — the PLACEHOLDER IN THE BOX is the record of intent, so deleting it before sending means the
bytes were never stored. The chat stamps no retention, which makes an attachment permanent, which is
what makes staging worth having; the page says so where the decision is made rather than in a banner
nobody rereads.

The marker moved to `client/attach.ts` and both front ends now produce it from one function. It is
what the assistant READS, and `artifactId <id>` in it is how a later tool call reaches the bytes, so
two clients describing one attachment two ways would give the model two vocabularies for the same
thing. Vision needs nothing further: `read_image` is discovered from `capability` records like any
tool, and it takes the id out of the marker.

**The relay was dropping `x-radia-taint`**, found while building this. It would not have failed a
write; it would have stored every attachment UNLABELLED, which is the shape of mistake an allowlist
makes best — invisible until a policy that reads the label silently permits something. Added, with
the reason, beside `last-event-id`, which was the same class of omission.

*Check:* `smoke-web.ts` uploads through the relay with both headers and asserts the stored record
keeps the `file` label and the conversation stamp, plus the marker's shape. The staging rules
themselves are already covered by `smoke-edit.ts`, which is why they were worth reusing rather than
rewriting.

**Phase 6: encrypted conversations.** A person's key is a PAIR PER MACHINE, and a browser profile is
a new machine (`plan-encryption.md`). So the page generates a key pair into IndexedDB, publishes the
public half as `person_key`, and can read a conversation only once a machine that already reads it
enrols this one. Until that lands, a page opening an encrypted conversation REFUSES and says why:
`assertReadable` is fail-closed, and rendering ciphertext to a person is the failure it exists to
stop.

**Phase 7: two writers. BUILT 2026-08-19, in one method.** `Thread.append` claims its slot with the
idempotency key `msg:<conversation>:<index>`: a key reused with a DIFFERENT request is refused, and
the runtime makes exactly one writer win even on pooled connections, so the loser re-reads the end
of the transcript and takes the next slot. Compare-and-append, out of a primitive that was already
there.

**What it fixes is `turnAt`, not the ordering.** The collision that corrupted anything was never two
messages sharing a display position: `turnAt` is the index a turn started at, so two clients
appending at one index gave two turns ONE IDENTITY, and workers addressing `{turnAt, round, role}`
could answer with each other's records. Unique slots end that.

**Two limits, both tested rather than assumed.** The idempotency key is scoped to the DURABLE
IDENTITY behind the caller (`Space.idem`), so it serializes one person's clients and not two
people's — which is the case that exists, since a conversation's grants scope to its owner. And an
identical message racing for one slot is DEDUPED rather than refused (same key, same request), so
both clients end up holding the one record.

The plan's record-id ordering was dropped, with the reasons in the section above. The browser keeps
its per-profile writer election, now as a courtesy rather than a correctness gate: two boxes on one
conversation is confusing, not unsafe.

*Check:* `smoke-live.ts` races two clients from one cursor and asserts both messages survive at
different slots with no index used twice, that the turn identity follows, and that the dedup limit
behaves as described.

## Not in scope

- The fleet, `--serve`, and every privileged setup verb. The page cannot do them and must not offer
  them.
- Conversation listing, procedure authoring in the page, and terminal input editing.
- Approving a grant request. The page can ask (`grants.ts` comes across with the port); answering is
  the operator's, and stays in the CLI.
- CORS. The relay exists only because the space sends no CORS headers
  (`research-app-lessons.md`). If the runtime ever allows an origin, the relay becomes a static file
  server and this plan loses a file.
