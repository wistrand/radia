# A staged analysis pipeline, as a web app

A data pipeline where **re-running is not a mechanism**. There is no replay verb, no invalidation
pass, no "mark stale" flag. Work is identified by its content — which dataset, which input digest,
which code digest — so changing an analysis produces *different work*, and unchanged work is found
already done.

```
cd docker/keycloak && docker compose up -d && cd -   # an issuer, once
deno task analysis -- --auto-grant
open http://127.0.0.1:8081                           # sign in as demo / radia
```

One command. It starts its own space if none is running — **with** the OIDC flags, which is the
point: `--oidc-issuer` and `--oidc-audience` are space-level configuration, so a deployment that
starts the space can pass them itself instead of asking anyone to remember them. Same move as the
chat's solo mode.

Upload CSV, watch the stages run, follow any record into the console.

Attaching to a space somebody else started still works (`--url`), and is the honest limit of it:
this cannot reconfigure a running space, so if that one advertises no issuer it says so rather than
serving a page whose sign-in button cannot work.

### Who may use it

An SSO identity arrives with **zero grants**, under a principal DERIVED from (issuer, subject) —
`human:oidc-<32 hex>` — which nobody can know before that person's first sign-in. Authenticated is
not authorized, deliberately (plan-oidc.md).

So there are two ways in, and they answer different questions:

- `--auto-grant`: everyone the IdP vouches for may use this. One policy decision, said once. This is
  what makes the bundled `demo` user work with no extra step.
- `--grant human:…`: a principal you already have. Repeatable.
- `--observe`: additionally let them open the console links. SEPARATE because it is a real widening:
  the console's Graph and Feed views are the ops plane, and the only power that opens them for
  reading is `observe`, which opens EVERY read, unscoped. Right for a single-user or demo space,
  wrong for a shared one. Without it the links answer "may not access the ops plane", which is
  correct rather than broken.

`--observe` is applied to everyone who has ALREADY enrolled as well as to new sign-ins. It has to
be: the auto-grant sweep skips anyone already holding grants, so a power added on a later run would
never reach the people already using the app — they would keep being refused the ops plane while
the flag said otherwise. Adding a power is not the same question as admitting a person, and only
the second one is gated on holding nothing.

There is no "observe only my own records" tier that fits: the self-scope tier requires every grant
to say `createdBy: "self"`, and this pipeline's results are written by WORKERS, so that scope would
hide exactly what a person wants to look at.

Without either, sign-in SUCCEEDS and the person then sees nothing, which is the confusing failure —
so the launcher says so when neither flag is passed.

Banning someone is retiring their `oidc_identity` mapping, not revoking their grants: with
auto-grant on, a revoked person is re-admitted by the next sweep after a restart.

## The idea

Each stage's request names four things, and all four are indexed:

```
stage_request { dataset, stage, inputDigest, codeDigest }
stage_result  { dataset, stage, inputDigest, codeDigest, outputDigest }
```

A stage's OUTPUT is an artifact, so its content digest is the next stage's `inputDigest`. The chain
is content-addressed end to end and nobody computes a hash by hand.

From that, two behaviours fall out rather than being implemented:

- **Change a stage** and it re-runs, along with everything after it: its new output digest is the
  next stage's new input digest, so those keys miss too. Nothing walks the graph invalidating.
- **Change nothing** and nothing re-runs, however often the planner executes. It is a pure function
  of what it reads, so it is safe on a watch, a timer, or by hand.

## What the substrate gives you, and what you write

Given: the DAG (`parent_ids`, so `radia children <dataset>` walks a run), routing by pattern so a
stage worker claims only its own work, leases so a crashed worker's stage is redelivered, the event
chain as an audit of which code produced which result, and `radia flows` mining the pipeline's shape
from lineage without anyone declaring it.

You write **the planner** (`planner.ts`, ~60 lines). Deciding what is stale depends on what you
consider an input, which no runtime can know. That is the only piece.

## Files

| File | Role |
|------|------|
| `kinds.ts` | the record kinds, and the indexed paths the whole design rests on |
| `stages.ts` | the analysis: three pure `bytes -> bytes` functions, hashed to give the code digest |
| `worker.ts` | one stage: advertises its code, claims requests naming it, reads and writes artifacts |
| `planner.ts` | what is stale, and the only thing that asks for work |
| `roles.ts` | three principals; a person cannot write a `stage_result` |
| `serve.ts` | the web app: serves one page and relays `/v0`, holding no credential |
| `ui.html` | sign-in, upload, the stage table, links into the console |
| `run.ts` | brings it all up |
| `smoke.ts` | the proof: `deno run -A examples/analysis/smoke.ts` |

## Things worth knowing

**A stage must be pure.** `bytes -> bytes`, no clock, no randomness, no I/O. That is what makes the
memo sound; a stage that read the time would make every cached result a lie and nothing in the
substrate could tell.

**The memo is a QUERY, not an idempotency key.** Content-keyed idempotency looks like free caching
and expires with `idempotencyRetentionSeconds` (7 days), after which a re-put is a fresh record and
the stage silently recomputes. A memo that quietly stops memoizing is worse than none.

**A stage's code digest is SELF-REPORTED, and nothing verifies it.** A worker writes its own
`stage_code` record, so one could report digest X while running Y and every result would be filed
and cached under a version that never produced it. The whole memo rests on that claim. Radia has the
answer already and this example does not use it: `extensions/ts/promotion.ts` pins which digest a
tier may run, and a `binding` that disagrees with the pin is refused rather than run. Composing the
two is the honest next step (research-substrate-lessons.md, action 5).

**The planner re-plans every dataset on every wake**, and the watch discards the `Wakeup` naming
what changed, so cost is O(datasets x stages) queries per stage completion. Fine for a demo, wrong
at scale; `ui.html` beside it already does the right thing with three bulk reads and in-memory
planning.

**A person cannot write a `stage_result`.** That is what makes a result evidence rather than a
claim: it says a worker computed this, from that input, under that code.

**The app holds no credential.** It relays the browser's own run token, so the space applies that
person's grants and the app can neither see nor do anything they could not. The relay exists only
because the space sends no CORS headers; if it ever allowed the origin, `serve.ts` becomes a static
file server.

**The space it starts is durable.** SQLite at `<RADIA_DIR>/analysis.db`, so a restart keeps every
dataset, result and artifact; without a `--db` a space is in-memory and the whole pipeline dies with
the process.

**Invalidation granularity is a property of how you version, not of the substrate.** All three
stages hash one file, so editing any of them re-runs all three. Splitting the digest per stage is
the obvious refinement and is left undone so the trade-off stays visible.

## The OIDC side is not covered by the smoke test

`smoke.ts` drives the pipeline and the relay against a real space and passes with no browser. The
sign-in dance — PKCE in the page, the token exchange, `POST /v0/sessions/oidc` — is **not**
exercised: it needs a browser and an issuer. The console's equivalent code is guarded by
`conformance/console.test.ts`; this page's copy of it is not. Treat it as reviewed, not tested.

### "Invalid parameter: redirect_uri"

Keycloak refusing the sign-in, and it names neither the value it rejected nor the list it checked.
Two causes, in order of likelihood:

**The running Keycloak predates the realm entry.** `--import-realm` skips a realm that already
exists, so editing `realm-radia.json` changes nothing for a container that already imported it. The
compose file declares no volume, so recreating the container is enough to get a fresh database and a
fresh import:

```
cd docker/keycloak && docker compose down && docker compose up -d
```

Or add it by hand instead: `http://localhost:8080` → realm `radia` → Clients → `radia-console` →
Valid redirect URIs.

**The origin does not match.** `http://localhost:8081` and `http://127.0.0.1:8081` are different
origins to an IdP, and the page sends whichever one you opened. The realm allows both for 8081; an
issuer configured by hand may allow only one. The launcher prints the exact string the browser will
send, so it can be pasted straight into the client's list.
