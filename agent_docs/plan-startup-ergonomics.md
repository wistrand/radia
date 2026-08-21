# Starting, restarting and inspecting a space

Ergonomics backlog, measured 2026-08-20 by starting, restarting, killing and inspecting real
spaces: an isolated lab (`RADIA_DIR`/`RADIA_CREDENTIALS` in a scratchpad, ports 7911-7922) plus
read-only verbs against a four-day-old live space. Every number below was observed, not inferred.
Items 1-3 are BUILT (2026-08-21); the rest is open, in the order to spend effort in.

The target property: a person restarts a space, or looks at one, and is never surprised. The two
failures that broke it (items 1 and 2) are closed, and the rest is residue nobody reports.

## What works, and must not regress

- **One directory is the whole footprint.** A persisted start wrote exactly `space-pg`,
  `space-pg-blobs`, `space-pg.lock` (item 1) and `seal.json` under `RADIA_DIR`, and nothing outside
  it (`src/paths.ts`).
- **The startup log names which side of every either/or you got**: `persisted at …` vs
  `in-memory (--db to persist)`, seal key `(generated)` vs reused, observer `provisioned` vs
  `reused`. All four observed across restarts, and they are the only place some of this is said.
- **A persisted restart is continuous and silent**: records, kinds, seal key and the observer
  identity all carry over, with no prompt and no warning.
- **The unreachable-space message is the model the rest should follow**: names the base URL, the
  likely cause, and both overrides, exit 1.
- **Empty states explain their two causes** (`flows` on an idle space is the worked example).
- **Verb latency is a non-issue**: from source 68/83/162ms for `version`/`health`/`stats`, compiled
  49/64/159ms. Compiling buys ~20ms, so no one needs to for speed.

## 1. Two `radia dev` on one PGlite directory both start, and diverge silently (BUILT)

PROVEN: 7915 and 7917 on the same `--db`, a record written through 7917 was absent from 7915, both
`health` 200, both `radia integrity` "chain OK" at heads 5 and 7. The last writer wins the files.
The same test on `--storage sqlite` is CLEAN (the write was visible through both), so the DEFAULT
backend is the unsafe one. Nothing takes a lock or names the holder, and tamper evidence cannot
catch it: each process's own chain is internally consistent.
BUILT: `src/lock.ts`, taken in `dev()` before `storage.init()` and released after `storage.close()`.
An OS advisory lock (`platform.lockFile`) rather than a pid file, because the kernel releases it
when the holder dies: a SIGKILLed space leaves nothing stale, and no liveness check is needed (Deno
has none that does not cost `--allow-run`). Deno's `lock()` waits rather than failing, so a 400ms
timer is the try-lock; the loser reads the holder's own line (pid, base URL, start time) out of the
file and exits 1. Both local backends lock, postgres and in-memory do not. Verified live for
pglite and sqlite, across a clean restart and a SIGKILL. Guard: `conformance/defaults.test.ts`,
"one writer per database".

## 2. A port conflict prints a raw Deno stack trace (BUILT)

`AddrInUse: Address already in use (os error 98)` plus eight frames of `ext:deno_net` /
`ext:deno_http`, after two successful-looking startup lines. Exit code 1 is right and the
credential file is correctly untouched, so the guard in `dev()` holds. The message is the worst in
the product and covers the most likely restart failure.

BUILT: the bind throws AddrInUse SYNCHRONOUSLY (the trace only looked asynchronous because it
propagated out of an async `main`), so `bind()` in `server/http.ts` catches it and names the port
and the listener, and `dev()` adds the cause and both overrides, exit 1. The artifact origin is
covered too: its `serve` result was discarded, so that bind failure had no observer at all. Guard:
`conformance/defaults.test.ts`, "a taken port is a message, not a stack trace".

## 3. `radia query` reads oldest-first and truncates at 500 in silence (BUILT)

Measured on a space with 818 `interest` records: `--limit 500` returns 09:15 first and 16:04 last;
`--limit 1000` returns 500 (`Math.min(j.limit, 500)`, `server/handlers/records.ts`). The server
returns `nextAfter`; `client.query()` drops it and neither the table nor `--json` mentions it.
This is the console Records browser's oldest-50-as-"the records" trap, fixed there and still live
in the CLI, and it is the class CLAUDE.md names as the most repeated bug in the codebase.

BUILT: the verb reads through `queryPage` with `dir: "desc"`, prints the explain notes, and turns
`nextAfter` into a runnable `radia query <kind> --limit N --after <id>` line; `--oldest` restores
ascending order and `--order` still suppresses `dir`, which `Space.query` rejects alongside a
cursor. `--json` now carries the same object the server sent (`{records, nextAfter, explain,
scope}`) instead of the bare array, which is the caller-visible break to know about. The 500 cap
stands: it is the server's, and a page that says it is a page is the fix. One explain note was
wrong and now visible in the CLI, so it went with it: an undeclared kind CAN return records (an
undeclared put is allowed), and the note said "can only ever return nothing" above rows a reader
could see. Guard: `conformance/defaults.test.ts`, "query reads NEWEST first".

## 4. Inspecting a space grows the space

Measured: `agent_run` 765, three `radia query` calls, 766 — the one new record came from the
measuring `stats` call. Operator verbs (`query`/`put`/`get`) mint nothing; every OBSERVER verb
(`stats`, `doctor`, `events`, `flows`, `integrity`, `permissions`, `lineage`, `children`, `otlp`)
writes one `agent_run` because it exchanges its definition token for a run. Consequences: 766
`agent_run` records after four days, `doctor`'s own `available=` rising each run, and
`radia events --tail 5` on an idle space returning five `agent_run` puts, so the event tail shows
the reader their own inspection. Compaction keeps newest-per-run and so cannot reduce the count of
RUNS, only their renewals.

## 5. The credential file accumulates and nothing prunes it

`~/.radia/credentials.json`: 23KB, 57 entries after four days — 43 `#observer`, 10 stale operator,
1 login, 3 content keys, across 43 distinct ports. Clean shutdown removes only the operator entry
(verified: the `#observer` entry for that base survived a SIGTERM alone), and ten stale operator
entries means ten processes that did not exit cleanly. Each `#observer` entry holds a durable
mint-only definition token for a space that no longer exists. The entries are keyed by base URL, so
an ephemeral-port space (every smoke run) can never reuse one. Nothing prunes and no verb owns it:
`doctor` reports on a space, and this file belongs to the user.

## 6. `health` identifies neither the instance nor whether it persists

The payload is status/version/api/storage/now/principal/oidc. No start time, no instance id, no
persistence flag, so "where did my records go" is answerable from the startup log and nowhere else,
and a reconnecting client cannot tell "same space, memory intact" from "same port, fresh empty
space". `startedAt` plus `persistent: true|false` is ADDITIVE to the frozen contract (spec and
router are checked in both directions by `conformance/openapi.test.ts`) and turns the most
confusing restart symptom into one line of `radia health`.

## 7. `doctor` undercounts what `gc` would reclaim

`doctor` reported "19 sweepable" where `radia gc` dry-run reported 19 sweepable plus "181
superseded registry entries: agent_run=153 chat_fleet=28" on the same space. Deliberate
(`gcBacklog: () => this.gc({ dryRun: true, compact: false })`, commented "a superseded successor is
bookkeeping, not a finding"), but the effect is that the number a person acts on is the small one.
One extra line in the report closes it.

## 8. Every fleet restart mints six permanent credentials

Measured: 25 `agent_definition` records each for `agent:chat-inference`, `-router`, `-tools`,
`-images`, `-exec`, `-turn`. `roles.ts`'s `mint` always calls `createAgentDefinition`, and
`agent_definition` is in `NEVER_COMPACT` (`src/core/gc.ts`), so 150 records stand, 6 of them
current, and the authorization surface grows one definition per worker per `--serve`. Nothing
reports it, and `radia permissions <agent>` shows grants rather than how many definitions hold
them.

## 9. Smaller papercuts, each a contained fix

- **The human table's id cannot be fed to `get`.** `recordTable` prints `r.id.slice(-8)` and
  `radia get TDK8RZPW` answers "no record"; the drill-down needs a `--json` re-run first.
- **`kinds` and `stats` disagree about what exists.** A `put` of an undeclared kind succeeds by
  design (`space.ts`: an unknown kind is not an error, since a put must not race a fleet's
  declaration), so `stats` lists `task` while `kinds` says "(no kinds declared)". Both are right;
  neither says that one means DECLARED and the other PRESENT.
- **Starting a space prints a 48-character token, not a link**, though `login --console` already
  builds `${base}/#token=…` and `dev()` holds both halves. The line a reader wants (`listening on
  …`) is fifth of nine and the token is last.
- **No `deno task` for the CLI**, so every inspect command is `deno run -A src/main.ts <verb>`
  while all documentation reads `radia <verb>`. A `"cli": "deno run -A src/main.ts"` task closes it.
- **Clean shutdown prints nothing**, so Ctrl-C gives no confirmation that the credential cleanup
  ran, which is the step that decides whether the next CLI call 401s.
- **Version skew is visible but unflagged**: `radia version` reports the CLI build, `health` the
  space's, and they differed (0.0.1 against 0.0.0) with nothing saying so.
- **`examples/chat/web/app.js` is a committed minified bundle**, so a repo-wide grep dumps 40KB
  single lines into the terminal.
