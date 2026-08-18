# Plan: a web UI for the chat, and the port it unlocks

**Status: PLANNED, nothing built.** Analysis 2026-08-18, sizes measured against the source the same
day. Two stages, and the ORDER is the point: stage 1 gives the chat a browser front end against
the real fleet, stage 2 moves the fleet into the tab (plan-browser-space.md,
plan-webworker-sandbox.md). Stage 1 is worth shipping alone, and it is also the cheapest way to
de-risk stage 2, because its whole deliverable is a seam both stages need.

## The measurement that decides the shape

The chat's logic is Deno-free but ANSI-BOUND, and those are different things:

- Every extension the chat leans on has ZERO `Deno.*`: `inference.ts`, `turn.ts`, `context.ts`,
  `model.ts`, `tool-worker.ts`, `capability.ts`, `progress.ts`, `encrypted.ts`.
- So does the client's protocol half. But `client/turn.ts` (766 lines) imports ELEVEN functions
  straight from `terminal.ts` and calls them at **44 sites** (`write` x10, `dim` x9, `endStatus`
  x7, `ensureLine` x6, `answerStream` x3, …), and `markdown.ts` renders to ANSI. Three more files
  import the terminal: `grants.ts` (`columns`, `dim`, `write`), `waiting.ts` (`endStatus`,
  `showStatus`), `fleet.ts` (`dim`, `notice`).
- The Deno usage in the WORKERS is almost entirely `Deno.env.get` config plus one `Deno.exit`;
  `provider/openrouter.ts` is a plain `fetch`, and `extensions/ts/inference.ts` already takes
  `complete` as an injected port ("the one function that knows an HTTP API").

So the port is not "make the chat browser-safe" — it mostly is. The port is **getting the
renderer out of the protocol**, and that is one refactor serving both stages.

## Stage 1: a `ChatUI` port, and a DOM implementation of it

**The deliverable is the seam, not the page.** Define one interface covering what the protocol
half actually asks the terminal for (streaming answer sink, status line on/off, notice, artifact
display, width, dim/trunc as formatting hints rather than escape codes), then:

1. Extract `ChatUI` and thread it through `turn.ts`, `grants.ts` and `waiting.ts` instead of the
   direct imports. `markdown.ts`'s `AnswerStream` (`push`/`end`, with a `passthrough`
   implementation "same interface, no decisions") is the shape to generalise: the hardest part of
   a chat UI is already behind an interface.
2. `terminal.ts` becomes ONE implementation, unchanged in behaviour. `deno task chat` must look
   and feel identical afterwards; the existing suites are the check.
3. A DOM implementation: messages list, streaming answer, tool-call and progress rendering,
   artifact links. Markdown renders to HTML here rather than ANSI, which means splitting
   `markdown.ts`'s PARSE from its ANSI emit.
4. A page that serves it, on the analysis example's pattern: a client that listens, relays `/v0`
   with the browser's own token, holds no credential of its own. The fleet stays as Deno
   processes; the space stays a server.

**Do not port the terminal itself.** `terminal.ts` (639 lines) and `edit.ts` (352) are a line
editor, clipboard staging and raw-mode handling; a textarea and the DOM give all of it free.
Reimplement input, port only the renderer.

## Stage 2: the fleet in the tab

Now, and only now, change where things run. Each piece is independently testable because the UI
is already proven against a real fleet:

- Workers become WEB WORKERS, one per fleet member, each holding only its own definition token.
  That keeps the fleet's credential separation honest and puts the provider key inside the
  inference worker rather than the page — so "a session holds no provider key" mostly survives.
- `config.ts` (25 `Deno.env.get`) becomes page config; `Deno.exit` becomes a rejection.
- `workers/exec.ts` becomes the Web Worker jail (plan-webworker-sandbox.md), which is the one
  isolation boundary that survives the move, and the one that matters most.
- `space/keys.ts` (key files at 0600) becomes the browser platform backend's storage.

**What the browser costs, stated because the chat's demo value is its security story.** OS-level
isolation goes: the fleet keeps separate credentials and grants, genuinely enforced, but not
separate process permissions, so "the file worker cannot reach the network" is no longer true. The
API key is only as safe as the origin. And a visitor's token plus a model plus any loop is an
unbounded SPEND, so stage 2 needs a hard per-session cap and no auto-run by default.

**The one external unknown**, and it gates stage 2 alone: whether OpenRouter permits
browser-origin calls (CORS). Stage 1 does not touch it, since inference stays server-side. If it
refuses, the fallback is a relay, which contradicts "nothing leaves the tab" less than it sounds
(a model call leaves the tab by definition) but is worth deciding deliberately.

## Why this order rather than one jump

Stage 1 ships something useful on its own (a web chat against a server space) and validates
streaming, tool calls, progress, escalation and the encrypted path in a browser BEFORE anything
moves. A rendering bug and a port bug never get to be the same bug. Stage 2 then has one UI, one
seam, and four independent swaps.
