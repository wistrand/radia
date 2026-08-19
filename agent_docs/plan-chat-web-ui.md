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

## The conversation is named, never enumerated

A session deliberately does not hold `conversation: query`: listing every conversation on the space
is a real widening to save a keystroke (`resolveConversation` in `chat.ts`). So:

- The conversation id lives in the URL fragment, on the console's precedent (`#c/<id>`), which makes
  a reload, a bookmark and a shared link all the same mechanism.
- "New conversation" is a `put` the session already holds, and it rewrites the fragment.
- There is no conversation picker, and `--conversation last` has no browser equivalent. Both need
  enumeration.

## Phases

Each phase ships alone and has a check.

**Phase 0: the page, the relay, and sign-in.** Copy `examples/analysis/serve.ts` (a client that
happens to listen: serves one page, relays `/v0/*` with the CALLER's Authorization header, holds no
credential). SSO gate, identity read back from `GET /v0/ops/permissions` rather than assumed, the
missing-grants message. No chat yet.
*Check:* sign in against `docker/keycloak`, see your own principal and grants. Verify SSE is not
buffered through the relay before Phase 2 depends on it.

**Phase 1: the `ChatUI` port.** One interface covering what the protocol half asks the terminal for:
streaming answer sink, status on/off, notice, artifact display, width, dim/truncate as formatting
HINTS rather than escape codes. Thread it through `turn.ts`, `waiting.ts` and `grants.ts` instead of
the direct imports; `terminal.ts` becomes one implementation. `markdown.ts`'s `AnswerStream`
(`push`/`end`, with a passthrough implementation) is the shape to generalise. Split `markdown.ts`'s
PARSE from its ANSI emit.
*Check:* `deno task chat` looks and behaves identically; the existing suites (`smoke-render.ts`,
`smoke-markdown.ts`, `smoke-turnlink.ts`) are the guard.

**Phase 2: the DOM implementation.** Message list, streaming answer, tool calls, progress records,
artifacts as links and inline images, a stop button on the exported `cancelTurn`. Input is a
textarea: do NOT port `terminal.ts` or `edit.ts`, which are a line editor, raw mode and clipboard
staging that the DOM gives free.
*Check:* a page-level smoke in the chat's own harness, no API key, on `conformance/console.test.ts`'s
structural precedent.

**Phase 3: attachments and vision.** Upload through the relay, whose header allowlist already
carries `x-radia-meta`, `x-radia-filename` and `x-radia-parent-ids`. A browser file picker and paste
replace Ctrl-V staging; the retention rule is unchanged, so the page says an attachment is permanent.

**Phase 4: encrypted conversations.** A person's key is a PAIR PER MACHINE, and a browser profile is
a new machine (`plan-encryption.md`). So the page generates a key pair into IndexedDB, publishes the
public half as `person_key`, and can read a conversation only once a machine that already reads it
enrols this one. Until that lands, a page opening an encrypted conversation REFUSES and says why:
`assertReadable` is fail-closed, and rendering ciphertext to a person is the failure it exists to
stop.

## Not in scope

- The fleet, `--serve`, and every privileged setup verb. The page cannot do them and must not offer
  them.
- Session-served inspection tools (`session-tools.ts`). They cannot be delegated, and the client
  chooses whether to offer them, so a browser session simply does not: the model then never calls a
  tool nothing will answer.
- Conversation listing, procedure authoring in the page, and terminal input editing.
- CORS. The relay exists only because the space sends no CORS headers
  (`research-app-lessons.md`). If the runtime ever allows an origin, the relay becomes a static file
  server and this plan loses a file.
