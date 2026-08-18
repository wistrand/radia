# Plan: a Radia space that runs in a web page

**Status: PLANNED, nothing built.** Analysis 2026-08-18, feasibility facts verified against
source the same day. The goal is a "try Radia in this tab" playground: the docs site boots a
real, persistent space in the browser with zero install. Not a reimplementation: the same
`src/core` + `src/server` + PGlite adapter, bundled to JS, behind the same frozen wire contract.
Two standing invariants make this cheap, and this plan is partly their proof: the `platform.ts`
seam and web-standard types at the HTTP boundary.

## Verified feasibility

- **The host surface is one file.** `src/platform.ts` (~25 small functions: files, env, serve,
  signals, stdio) is the only place `src/` touches `Deno.*`; `conformance/layering.test.ts` has
  enforced it for months. The one grep hit elsewhere in the browser-relevant set is a comment.
- **PGlite is browser-native.** `src/storage/pglite.ts` imports `@electric-sql/pglite` and
  `pgbase` only, no host APIs. PGlite ships an IndexedDB filesystem (`idb://`), so the space
  persists across reloads, and the full conformance suite already runs against this adapter:
  browser semantics are the tested embedded mode, not a hope.
- **The wire needs no socket.** `makeHandler(space, ui, authRequired)` is
  `(Request) => Promise<Response>`, pure web-standard, already driven socketless by
  `conformance/http.test.ts`. A Service Worker intercepting `fetch` to a virtual origin serves
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
- Its API calls are root-absolute `/v0/...`, so it cannot be served under the docs site's
  GitHub Pages path prefix (a SW scoped to `/radia/` cannot own `/v0` at the origin root).
- It keeps credentials in localStorage/sessionStorage, so a `srcdoc` iframe (OPAQUE origin,
  storage throws) breaks it.

Therefore: load the console HTML into an iframe via a `blob:` URL (same origin as the creating
page, so storage and the credential flow work) with a small prepended script that routes
`window.fetch` for `/v0` and `/ui` to the in-page handler. The shim also serves
`/ui/vendor/blitzoom.bundle.js` (the Space tab's pinned asset) from a local copy. Auth runs in
open mode; the console's labeled operator button is the sign-in.

## The suitable limitations, stated up front

1. **No code execution.** Everything that spawns a process (the jails, the broker's FIFO pair,
   `WorkspaceHost`) does not apply. Sandboxed iframes/Workers could become a NEW jail backend
   later; the sandbox-as-record design even anticipates backends with different guarantees. Day
   one: none.
2. **One space per browser profile.** PGlite is single-connection; multi-instance stays
   Postgres-only. This matches the existing embedded posture rather than adding a restriction.
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
   delta is the seam and the bundling. Add a bundle smoke that runs `makeHandler` requests
   through the BUILT bundle under Deno (no browser needed in CI).

**Verification constraint:** builds and type-checks are automatable here, but nothing in this
repo's tooling launches a browser (standing rule). The in-page click-through is the operator's.
