# Plan: a Radia space that runs in a web page

**Status: steps 1, 2, 5 and 6 BUILT 2026-08-18; steps 3 (SharedWorker/SW) and 4 (IndexedDB
blobs) remain.** Built as an injectable backend rather than a bundler alias (better than
planned: `setPlatformBackend` in `src/platform.ts`, `browserBackend` in
`src/platform_browser.ts`, entry `src/browser.ts` with `bootBrowserSpace`). `deno task
bundle-browser` (`scripts/build-browser.sh`) bundles with `deno bundle --external
@electric-sql/pglite` (no new build tools), stages the console + PGlite's dist out of deno's npm
cache, and runs the smoke. NOTHING BUILT IS COMMITTED: `docs/playground/` outputs are gitignored
(only `index.html` is source), by decision — the build runs on demand or in CI (the embedded job
runs it as a clean-machine proof). Publishing: `.github/workflows/pages.yml` builds the
playground and deploys `docs/` via the Pages Actions path; it is INERT until the repo's Pages
source setting is switched from branch-deploy to "GitHub Actions" (operator action). Under
branch-deploy the site still publishes and `/playground/` degrades to its
"not built here" message. The page's exact wire flow
(keyed kind_def replay on reload, post -> claim -> ack, the empty-take shape) was rehearsed
against the BUILT bundle under Deno; the in-page half awaits the operator's click-through.
Analysis 2026-08-18, feasibility facts verified against source the same day. The goal is a "try Radia in this tab" playground: the docs site boots a
real, persistent space in the browser with zero install. Not a reimplementation: the same
`src/core` + `src/server` + PGlite adapter, bundled to JS, behind the same frozen wire contract.
Two standing invariants make this cheap, and this plan is partly their proof: the `platform.ts`
seam and web-standard types at the HTTP boundary.

## Verified feasibility

- **The host surface is one file.** `src/platform.ts` (~25 small functions: files, env, serve,
  signals, stdio) is the only place `src/` touches `Deno.*`; `test/layering.test.ts` has
  enforced it for months. The one grep hit elsewhere in the browser-relevant set is a comment.
- **PGlite is browser-native.** `src/storage/pglite.ts` imports `@electric-sql/pglite` and
  `pgbase` only, no host APIs. PGlite ships an IndexedDB filesystem (`idb://`), so the space
  persists across reloads, and the full conformance suite already runs against this adapter:
  browser semantics are the tested embedded mode, not a hope.
- **The wire needs no socket.** `makeHandler(space, ui, authRequired)` is
  `(Request) => Promise<Response>`, pure web-standard, already driven socketless by
  `test/http.test.ts`. A Service Worker intercepting `fetch` to a virtual origin serves
  the UNMODIFIED TS SDK and the UNMODIFIED console, SSE watches included (a SW can return a
  streaming Response; the SDK's poll fallback covers SW lifecycle quirks).
- **All crypto is WebCrypto.** Chain sealing is HMAC-SHA256 via `crypto.subtle` (`seal.ts:52`),
  blob encryption is AES-GCM, digests are SHA-256. The only WASM is PGlite's own.

## The shape

The space lives in a **SharedWorker**, which is the architecture's own sentence made literal: "a
single runtime process that owns all concurrency guarantees". Every tab is a client over the
SW-intercepted wire. Storage is PGlite on `idb://`; blobs start on the existing memory
`BlobStore` (an IndexedDB implementation is a later, small addition). The build is ONE esbuild
pass with a `platform.ts -> platform-browser.ts` alias, which fits the "single bundling step"
invariant and the vendored-asset precedent (`src/ui/vendor/blitzoom.bundle.js`).

`platform-browser.ts` maps the seam: file ops used for the credential file, the chain key and
the KEK go to localStorage/OPFS; `serve` is unused (the handler path replaces it); `onShutdown`
is `pagehide`; env/args/stdio are stubs or console. It lives beside `platform.ts` and is swapped
at BUNDLE time, so `src/` and the layering test are untouched.

What runs unchanged: the whole coordination core. Records, kinds-as-records, matching with SQL
pushdown, leases and fencing (the DB clock is PGlite's), watches/notifier/coalescing, the full
auth stack (definition/run tokens, grants, delegation, taint, ops powers), the event chain,
artifacts, registries, GC, flows mining, the ops plane, the console page, `agentLoop` and
`reactorLoop` (demo workers run in the page or other tabs).

## The console IS the playground UI

Reuse all of `src/ui/index.html`, embedded whole, zero forked code: the playground page is a
thin shell (boot the space, seed the demo, narrative sidebar) around an embedded console, and
the narrative drives it through the fragment router the console already has (`#feed`,
`#graph/<id>`), which was built for exactly this kind of link. Never extract individual views:
the console is one no-build file that changes weekly, so extraction is a fork that drifts, where
embedding inherits every future tab for free.

Three facts verified 2026-08-18 decide the technique:

- The console POLLS; it has no EventSource or WebSocket. A `fetch` shim alone runs all of it.
- Its API calls are root-absolute `/v0/...`. When the site lived under the `/radia/` path prefix
  that ruled out serving it directly (a SW scoped to `/radia/` cannot own `/v0` at the origin
  root); since 2026-08-18 the site IS an origin root (`radia.sh`), so a Service Worker scoped at
  `/` CAN own `/v0`, which makes step 3 cleaner than first planned: the console could be served
  at a real path with no HTML patching at all. The blob-iframe MVP stays valid either way.
- It keeps credentials in localStorage/sessionStorage, so a `srcdoc` iframe (OPAQUE origin,
  storage throws) breaks it.

Therefore: load the console HTML into an iframe via a `blob:` URL (same origin as the creating
page, so storage and the credential flow work) with a small prepended script that routes
`window.fetch` for `/v0` and `/ui` to the in-page handler. The shim also serves
`/ui/vendor/blitzoom.bundle.js` (the Space tab's pinned asset) from a local copy. Auth runs in
open mode; the console's labeled operator button is the sign-in.

## The suitable limitations, stated up front

1. **No PROCESSES** (rewritten 2026-08-18, when the Web Worker backend shipped:
   plan-webworker-sandbox.md). JavaScript snippets DO run, in a Worker inside a sandboxed iframe
   — opaque origin, `connect-src 'none'`, probed before it is offered. What still does not apply
   is anything that spawns: Python, the broker's FIFO pair, `WorkspaceHost`, and multi-file
   workspace trees (which need module resolution the tab has no filesystem for; the SW step makes
   that possible). Memory is the one axis a browser cannot cap, and the record says so.
2. **One space per browser profile.** PGlite is single-connection; multi-instance stays
   Postgres-only. This matches the existing embedded posture rather than adding a restriction.
   The page is also the ONE place a browser's `Request` reaches server code: Firefox has no
   `Request.body` getter, so `readCapped` (`src/server/body.ts`) buffers whole when the stream is
   missing. A server-side reader that only Deno has exercised is untested here until a person
   opens the playground in Firefox (2026-09-04, every put answered `invalid_body`).
3. **Artifact-origin isolation weakens.** The two-port design cannot exist on a static page;
   rendering agent-generated content needs sandboxed iframes or stays download-only, and the
   playground says so.
4. **Auth is real but single-person.** Every principal is the same human's tabs. That is also
   the demo's point: a grant refusing a `take` happens live in front of the reader. OIDC: skip.
5. **Tamper evidence holds against accidents, not against the user**: the HMAC key sits in their
   own storage. The same trust statement the docs make about a DB admin, one ring closer.
6. Performance is PGlite single-threaded WASM; the bench numbers do not transfer and the
   playground must not imply they do.

## Order

1. `platform-browser.ts` beside the seam, plus an esbuild bundle script (entry: Space +
   PGliteAdapter + memory BlobStore + `makeHandler`; alias the seam; ship PGlite's wasm asset
   beside the bundle). Type-check is the gate; nothing here needs a browser.
2. In-page boot, simplest wiring first: boot the space, then the console in its blob-URL iframe
   with the fetch shim (the section above). This is the demo's minimum viable form (single tab),
   and because the console polls, it needs nothing beyond the shim.
3. SharedWorker + Service Worker upgrade: the space moves out of the page, tabs share it, the
   unmodified SDK works from any script on the site.
4. IndexedDB `BlobStore`, so artifacts survive reload with the records.
5. The playground page on the docs site: the narrative sidebar beside the embedded console,
   seeding the pipeline demo and deep-linking each step into the console's tabs by fragment. The
   docs guard's external-host allowlist is unchanged (the bundle and the vendor asset are
   local); the prose obeys plan-prose-tells.md.
6. Conformance stance: semantics are already covered by the PGlite adapter suites; the browser
   delta is the seam and the bundling. `test/browser-bundle.test.ts` runs `makeHandler`
   requests through the BUILT bundle under Deno (no browser needed in CI); it SKIPS loudly when
   the bundle is absent so a clean checkout's `deno task test:runtime` stays runnable, and the
   build task is the run that cannot skip (the py-parity stance).

**One SDK fix the browser transport forced** (2026-08-18): `client.watch` ended its stream only
when the read errored, which a socket does on abort and a DIRECT handler call cannot — the server
ends an SSE stream from the reader's `cancel()` and nothing else. So an aborted watch parked
forever, its stream stayed open, and `reactorLoop`'s shutdown never returned. It now cancels the
reader on abort. Guard: `test/loop.test.ts`, "an abort ends the stream even when no socket
can break it", which patches `fetch` at the handler and was proven to hang without the fix. Every
socket-backed case in that file passes either way, which is why the browser transport is where it
had to be caught.

**Erasing a persisted space, and the trap under it** (the playground's "Reset the space",
2026-08-18). Deleting the database from a page that has booted DOES NOT WORK: PGlite's IDBFS
keeps its IndexedDB connection open across `close()`, so `deleteDatabase` blocks, `blocked` is not
guaranteed to fire when the holder is your own page, and the reset's own `location.reload()` is
never reached — leaving a live tab on a closed space. Worse, the pending delete then queues ahead
of the NEXT tab's `open`, so one click makes every later visit hang at boot. So the erase runs at
the top of the next load, before anything opens the database, bounded at 3s per delete with
`blocked` treated as an outcome. Two rules generalise beyond this page: a RECOVERY CONTROL MUST
NOT DEPEND ON WHAT IT RECOVERS (the button was wired after boot, so it was dead in exactly the
state that needed it — it is now wired first and reachable by hand as `?reset=1`), and an
IndexedDB open that waits reports nothing, so it needs its own watchdog to name the cause.

**Running it:** `deno task bundle-browser`, then `deno task serve-docs` (`scripts/serve-docs.ts`,
dependency-free; it exists because the playground needs `application/wasm` served correctly or
PGlite's streaming compile is refused) and open `/playground/`. The console starts at its
sign-in screen and the way in is the labeled "Sign in as local operator" button: the space runs
in open mode and the console never assumes authority silently, in a tab exactly as on a server.

**Verification constraint:** builds and type-checks are automatable here, but nothing in this
repo's tooling launches a browser (standing rule). The in-page click-through is the operator's.

## Playground v2: the guided demo (PLANNED 2026-08-18)

Prompted by an external review of v1 and designed around one principle the review circled but
never stated: **the demo never asserts; every claim is a link to the record that proves it** (the
inspection doctrine, applied to marketing). One escalating story on one live space, not separate
experiments, so the Feed and Graph accumulate a single history the visitor built. Five beats,
~90 seconds, all page-level work over the existing wire; nothing in `src/`.

The prerequisite, and a finding about v1: **the toy worker acts as the operator**, so the full
authorization stack runs and is never consulted on the claim path. Beat 2 forces the fix: the
worker becomes a real principal (definition minted through the wire, `take` grant pattern-scoped
to `classification: public`, `classification` joins the seeded kind's indexed paths).

1. **Routing.** Post a document with the worker's actual pattern shown beside the button.
   Verdict lines fill from REAL events, each a deep link into the embedded console: published ->
   the record; matched and claimed -> the lease event; answered -> the summary. Event-driven
   states, never a scripted animation: the honest version is the more convincing one.
2. **Authorization, the hero.** Post public vs post confidential. Public flows; confidential
   shows "pattern matches (link: the interest) / grant permits NOTHING (link:
   `effectivePermissions`) / still waiting, and it will wait forever". Then the beat that turns
   four doc pages into one click: a "Grant the clearance" button writes a real `grant` record and
   the stuck document is claimed within a second, live, no restart, because grants are records
   read on the claim path and the watch wakes the worker.
3. **Failure.** "Kill the worker mid-claim" (lease ~5s for pacing): leased by A -> A gone ->
   lease expired -> claimed by B. Then A "returns" and its late ack is REFUSED `lease_lost`:
   fencing shown, not described.
4. **The thesis: add your own worker.** A declarative form (name, claim pattern, produced kind,
   field-copy template; the translator example) mints a real definition with real grants and
   starts a real loop. Repost: `document -> summary -> translation` with the first worker
   untouched, said in exactly those words, linked to the Flows tab where the mined shape changed.
   "Start a second replica" on any worker shows competition: two claimants, each record claimed
   once. Declarative on purpose: user-typed JS in their own tab would not violate the no-exec
   limitation (their code, their machine), but the form teaches the pattern vocabulary and keeps
   v1 small.
5. **Look at what you built.** Auto-follow toggle driving the EMBEDDED console's Graph tab by
   fragment (never a custom lineage view: embed-don't-fork stands). One line, "everything above
   is a record; this survives reload", and reload proves it.

Frame: the "real runtime, running locally" badge (true, verified); the console collapsed under
"Open full console"; and the honesty label the review's own proposal needs: "this page acts as
the local operator (open mode, what any script here gets); the console below asks first", which
turns the page-vs-console asymmetry into a second authorization lesson.

Rejected from the review: a custom live graph renderer (forks the weekly-changing console); a
pre-seeded fake OCR/sentiment pipeline (beat 4 grows the graph honestly); auto-playing the tour
(the visitor pressing the buttons IS the demo, since "you did this without wiring anything" only
lands if they did).

Build order: worker-as-principal refactor; the experiment rail with event-sourced verdict lines
replacing the lone post button; add-a-worker; auto-follow graph; badge and labels; then the
homepage CTA swap ("Add a worker without wiring it into anything. Try it ->"). Every step ends
at the operator's click-through.
