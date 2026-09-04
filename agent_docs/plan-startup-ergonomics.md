# Starting, restarting and inspecting a space

Ergonomics backlog, measured 2026-08-20 by starting, restarting, killing and inspecting real
spaces: an isolated lab (`RADIA_DIR`/`RADIA_CREDENTIALS` in a scratchpad, ports 7911-7922) plus
read-only verbs against a four-day-old live space. Every number below was observed, not inferred.
Items 1-7 and 9 are BUILT (2026-08-21). Item 8 (six permanent definitions per fleet restart) was
FIXED 2026-08-29 by rotation; what stays open there is reporting the count.

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
pglite and sqlite, across a clean restart and a SIGKILL. Guard: `test/defaults.test.ts`,
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
`test/defaults.test.ts`, "a taken port is a message, not a stack trace".

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
could see. Guard: `test/defaults.test.ts`, "query reads NEWEST first".

## 4. Inspecting a space grows the space (BUILT)

Measured: `agent_run` 765, three `radia query` calls, 766 — the one new record came from the
measuring `stats` call. Operator verbs (`query`/`put`/`get`) mint nothing; every OBSERVER verb
(`stats`, `doctor`, `events`, `flows`, `integrity`, `permissions`, `lineage`, `children`, `otlp`)
writes one `agent_run` because it exchanges its definition token for a run. Consequences: 766
`agent_run` records after four days, `doctor`'s own `available=` rising each run, and
`radia events --tail 5` on an idle space returning five `agent_run` puts, so the event tail shows
the reader their own inspection. Compaction keeps newest-per-run and so cannot reduce the count of
RUNS, only their renewals.

BUILT: `POST /v0/agent-runs {reuse: true}` (`Space.mintRun`), which derives the run token from the
definition token and a 12h bucket and returns the run that credential already holds. The mechanism
is `mintDelegatedRun`'s, and both now share `Space.reuseRun`. OPT-IN, because reuse collapses run
identity: two processes on one definition token share a run principal and `runs --stop` stops both,
which is right for a person's CLI and wrong for a fleet. The CLI and the MCP adapter ask for it
(`ClientAuth.reuseRun`); nothing else changes. Measured after: six observer verbs, one `agent_run`,
where six was the count before. The cost to know about: a stopped reused run stays stopped until the
bucket rolls, so `runs --stop` on the observer blocks read-only verbs for up to 12h. Guard:
`test/exchange.test.ts`, "a credential exchanged per process gets its run back".

## 5. The credential file accumulates and nothing prunes it (BUILT)

`~/.radia/credentials.json`: 23KB, 57 entries after four days — 43 `#observer`, 10 stale operator,
1 login, 3 content keys, across 43 distinct ports. Clean shutdown removes only the operator entry
(verified: the `#observer` entry for that base survived a SIGTERM alone), and ten stale operator
entries means ten processes that did not exit cleanly. Each `#observer` entry holds a durable
mint-only definition token for a space that no longer exists. The entries are keyed by base URL, so
an ephemeral-port space (every smoke run) can never reuse one. Nothing prunes and no verb owns it:
`doctor` reports on a space, and this file belongs to the user.

BUILT: `radia credentials [--prune]`, the verb that owns this file. Two rules decide what it may
delete. WHAT A RESTART REBUILDS: an operator or `#observer` entry comes back by starting `radia dev`
again, while a `#login` durable half and a content key do not, and the key is the only copy of what
opens a person's conversations, so those two are never pruned whatever their age. And AGE IS NOT
PERMISSION: an entry is rewritten only when a space starts, so a dev up for a month looks exactly
like one that died a month ago. `--prune` therefore probes each dormant entry's base URL and keeps
the ones that still answer, saying which. Nothing prunes as a side effect of a write, which is where
this first landed and what the suite caught: an unrelated `radia login` deleted a live space's
operator entry, the port-race bug wearing a clock. `radia dev` reports the dormant count and deletes
nothing. Clean shutdown does drop the `#observer` entry for an IN-MEMORY space, whose base URL will
never answer again; a persisted one keeps it, because the identity is still in its database. Guard:
`test/exchange.test.ts`, "prunes what a restart can rebuild, and nothing else".

## 6. `health` identifies neither the instance nor whether it persists (BUILT)

The payload is status/version/api/storage/now/principal/oidc. No start time, no instance id, no
persistence flag, so "where did my records go" is answerable from the startup log and nowhere else,
and a reconnecting client cannot tell "same space, memory intact" from "same port, fresh empty
space". `startedAt` plus `persistent: true|false` is ADDITIVE to the frozen contract (spec and
router are checked in both directions by `test/openapi.test.ts`) and turns the most
confusing restart symptom into one line of `radia health`.

BUILT, three fields: `instance` (a ULID per `Space`, so a restart is visible as a different space
rather than inferred from a changed clock), `startedAt` (the DATABASE clock, or uptime would be a
cross-clock subtraction) and `persistent`. The last two are absent unless the boot path stamped
them, since a `Space` is handed an adapter and cannot see where it writes, and `storage` reads
`pglite` either way. Still PUBLIC, like `principal` and `storage` before them: the reconnecting
client is the one that needs the answer and it has not signed in yet. `radia health` prints
`persisted`/`in-memory` on its first line and `instance=… started=…` on a second. Guard:
`test/http.test.ts`, "health says WHICH space this is".

## 7. `doctor` undercounts what `gc` would reclaim (BUILT)

`doctor` reported "19 sweepable" where `radia gc` dry-run reported 19 sweepable plus "181
superseded registry entries: agent_run=153 chat_fleet=28" on the same space. Deliberate
(`gcBacklog: () => this.gc({ dryRun: true, compact: false })`, commented "a superseded successor is
bookkeeping, not a finding"), but the effect is that the number a person acts on is the small one.
BUILT: `gcBacklog` asks for `compact: true`, and the compaction backlog is reported as its own
`compactable` row rather than added to `sweepable`, since a retention policy expiring records and a
registry keeping its newest entry per key are different things. Both surfaces print it (`radia
doctor`, the console's Overview), and the guard asserts `doctor` and `gc` report the SAME number,
which is the disagreement that started this. The dry compaction walk is bounded per kind
(`MAX_WALK`, `src/core/gc.ts`) and diagnostics is on demand in both surfaces, never polled. Guard:
`test/http.test.ts`, "diagnostics reports the compaction backlog".

## 8. Every fleet restart mints six permanent credentials (FIXED 2026-08-29)

Measured: 25 `agent_definition` records each for `agent:chat-inference`, `-router`, `-tools`,
`-images`, `-exec`, `-turn`. `roles.ts`'s `mint` always called `createAgentDefinition`, and
`agent_definition` is in `NEVER_COMPACT` (`src/core/gc.ts`), so 150 records stood, 6 of them
current, and every one of the 150 could still MINT A RUN.

**The fix is rotation, not deletion.** A definition token is shown once and stored as a hash, so a
restarting fleet cannot recover the one it had and must create another; what it must not do is
leave the old one minting. `bootstrap` now revokes the definition it replaces, carrying the record
id its decision rested on into the create (`supersedes`), which is `radia team add --rotate`'s dance
and is there for the same reason: two fleets starting together must not both revoke and both create.
Measured after: three restarts, ONE token still minting, where before it was four of four
(`examples/chat/smoke-restart.ts`, proved red against the unrotated code).

**Two things this is deliberately not.** The record count still GROWS, because a revocation is a
successor rather than a delete; what is bounded is how many credentials can act, which is the thing
item 8 was about. And rotation is a parameter rather than the behaviour of `mint`, because a SESSION
is not a fleet: several sessions for one person are legitimately live at once, and revoking on each
mint kills every one before the newest. That is not hypothetical, it is what the turn-link suite
failed with when rotation was applied to both. For the same reason `bootstrap` is memoized per
process: a second call would revoke the tokens the first handed to running workers.

Still open: nothing REPORTS the count, and `radia permissions <agent>` shows grants rather than how
many definitions hold them. A second `--serve` against one space now rotates the first fleet's
tokens out, so it fails loudly with `invalid_credential` rather than quietly double-claiming.

## 9. Smaller papercuts, each a contained fix (BUILT)

Guards: `test/defaults.test.ts` ("what a table prints can be fed back in", "a version skew … is
named", "a start hands over a LINK").

- **The human table's id cannot be fed to `get`.** FIXED by printing the id WHOLE and shortening
  the body preview instead: the body is a preview either way and `--json` carries all of it, while
  an id that cannot be used is noise. The guard is the round trip (table -> `get`), not a format.
- **`kinds` and `stats` disagree about what exists.** A `put` of an undeclared kind succeeds by
  design (`space.ts`: an unknown kind is not an error, since a put must not race a fleet's
  declaration), so `stats` lists `task` while `kinds` says "(no kinds declared)". Both are right;
  neither said that one means DECLARED and the other PRESENT. FIXED: each verb now says which
  question it answers, and `stats` names the undeclared kinds it is holding. RESERVED kinds are
  excluded from that list, since they are declared IN CODE and have no `kind_def` record, so calling
  them undeclared would be a new wrong answer for an old one.
- **Starting a space prints a 48-character token, not a link.** FIXED: `dev` prints the same
  fragment sign-in link `login --console` builds, and keeps the raw token on its own line for `curl`
  and `RADIA_TOKEN`. The line ORDER is unchanged and still worth revisiting: `listening on …` is
  fifth of ten.
- **No `deno task` for the CLI.** FIXED: `deno task cli <verb>`, beside `dev` and `mcp` in the task
  table, so a checkout can run what the docs write as `radia <verb>`.
- **Clean shutdown prints nothing.** FIXED: a stop line naming what happened to the credential and
  to the data. Conditional on having SERVED, since the port-in-use path reaches the same `finally`
  having written nothing and must not claim it cleaned anything up.
- **Version skew is visible but unflagged.** FIXED: `radia health` names it when the two differ and
  says nothing when they match. Named, never resolved: mixing versions is allowed, and a note on
  every call is a note nobody reads.
- **`examples/chat/web/app.js` dumps 40KB single lines into a repo-wide grep.** The claim that it
  was COMMITTED was wrong, and worth recording as a measurement error: `git log` shows zero commits
  touching it and `.gitignore:20` has ignored it all along. What a plain `grep -r` reads is the
  WORKING TREE, which knows nothing about `.gitignore` (`git grep` and `rg` skip it). The build path
  was already right too: `deno task bundle-chat-web` writes it, `--serve --web` builds it before
  serving (`launchWebUi`), and `serve.ts` names the task at boot when it is absent. The one real gap
  was CI, which never built it, so a break in bundling would have surfaced the first time somebody
  ran the web UI; `ci.yml` now builds it beside `bundle-browser`, the other never-committed bundle.
