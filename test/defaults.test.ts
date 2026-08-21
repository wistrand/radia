// The defaults a space lands on when nobody configures it.
//
// A default is not a convenience, it is the posture every unconfigured space actually runs in, so
// each one here was at some point the wrong one: auth was open, so a space started life fully
// accessible unless someone knew the flag; runtime files defaulted to wherever each call site named
// them, so a project collected four `.radia-*` entries nobody chose as a set.
//
// These read the source rather than starting a server. Each assertion is about one literal or one
// pure function, and it should fail when that literal changes, which is the point: a default that
// can drift silently is the same problem again.

import { assert, assertEquals } from "@std/assert";

Deno.test("dev: --auth defaults to required", async () => {
  // The default IS the security posture for every space nobody configured. Open mode resolves a
  // header-less request to the operator, so defaulting to it meant a space started life fully open
  // and stayed there unless someone knew the flag existed. Reading the source rather than starting
  // a server: this is one literal, and the assertion should fail on the literal changing.
  const main = await Deno.readTextFile(new URL("../src/main.ts", import.meta.url));
  const m = main.match(/const authMode = flag\(args, "--auth"\) \?\? "(\w+)"/);
  assert(m, "src/main.ts no longer resolves --auth this way; update this test with it");
  assertEquals(m[1], "required", "--auth must default to required");
});

Deno.test("dev: an observer credential is provisioned, and the MCP adapter defaults to it", async () => {
  // The posture (architecture-ops-tiers.md phase 5): the model behind `radia mcp` holds `observe`, not
  // the operator bit. Three literals keep it wired: dev provisions through `provisionObserver`,
  // the MCP adapter prefers the stored observer, and the CLI's read-only verbs ride it too.
  // Source-read like the --auth default above, and each half must fail alone.
  const main = await Deno.readTextFile(new URL("../src/main.ts", import.meta.url));
  assert(/provisionObserver\(space, base/.test(main), "dev no longer provisions the observer identity");
  const creds = await Deno.readTextFile(new URL("../src/credentials.ts", import.meta.url));
  assert(/operations: \["observe"\]/.test(creds), "…or the observer no longer gets exactly the observe power");
  const mcp = await Deno.readTextFile(new URL("../src/surfaces/mcp/server.ts", import.meta.url));
  assert(/storedObserver\(base\)/.test(mcp), "the MCP adapter no longer reads the observer credential");
  assert(/definitionToken: observer/.test(mcp), "…or no longer prefers it as its default auth");
  const cli = await Deno.readTextFile(new URL("../src/surfaces/cli.ts", import.meta.url));
  assert(/OBSERVER_VERBS/.test(cli), "the CLI's read-only verbs no longer ride the observer");
});

Deno.test("dev: the observer's power is assigned at mint, and a RETIREMENT stands across restarts", async () => {
  // The resurrection class, planted (gotchas.md "Content-key idempotency dedupes for a window"):
  // a provisioning pass that re-put the ops_grant on every boot would outrank an operator's
  // `retired: true` tombstone once the idempotency row that dedupes it is swept (7 days), so a
  // deliberately revoked observer power would silently return. Assign-at-mint is the fix, and
  // this is the test that fails if a re-put ever creeps back in.
  const dir = await Deno.makeTempDir({ prefix: "radia-observer-" });
  Deno.env.set("RADIA_CREDENTIALS", `${dir}/credentials.json`);
  const { provisionObserver, OBSERVER_PRINCIPAL } = await import("../src/credentials.ts");
  const { Space } = await import("../src/core/space.ts");
  const { SqliteAdapter } = await import("../src/storage/sqlite.ts");
  const { rawExec } = await import("./conformance/suites/integrity.ts");
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  try {
    const space = new Space(adapter);
    const base = "http://127.0.0.1:59999";
    const first = await provisionObserver(space, base, "test");
    assertEquals(first.created, true);
    assertEquals([...await space.opsPowers(OBSERVER_PRINCIPAL)], ["observe"]);
    // Beside the power, exactly two metadata reads: agent_run (a run principal carries no agent
    // name; without this the OTLP exporter's services were raw run ids) and kind_def. Query only,
    // and nothing else rides along.
    const perms = await space.effectivePermissions(OBSERVER_PRINCIPAL);
    assertEquals(
      perms.kinds.map((k) => `${k.kind}:${k.operations.join(",")}`).sort(),
      ["agent_run:query", "kind_def:query"],
    );

    // The operator retires the power. Every later "restart" must reuse the live definition and
    // must NOT re-assign what was deliberately withdrawn.
    await space.put({ kind: "ops_grant", body: { principal: OBSERVER_PRINCIPAL, operations: ["observe"], retired: true } });
    // Simulate the aged idempotency window (the sweep deletes these rows after 7 days). Without
    // this the row still dedupes a re-put and the buggy shape PASSES here for a week: the exact
    // blindness that made the bug worth a plant. With it, a provisioning pass that re-puts on
    // reuse writes a fresh record that outranks the tombstone, and the next assert fails.
    await rawExec(adapter, "delete from idempotency", []);
    const again = await provisionObserver(space, base, "test");
    assertEquals(again.created, false, "a live stored definition is reused");
    assertEquals((await space.opsPowers(OBSERVER_PRINCIPAL)).size, 0, "the retirement stands");

    // The documented recovery path: revoke the identity, and the next start re-creates it.
    await space.revokeDefinition(OBSERVER_PRINCIPAL);
    assertEquals((await provisionObserver(space, base, "test")).created, true);
  } finally {
    await adapter.close();
    Deno.env.delete("RADIA_CREDENTIALS");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dev: losing a port race leaves the running space's credential alone", async () => {
  // Seen live: a second `radia dev` aimed at an occupied base overwrote the running space's
  // operator entry at startup, then deleted it outright in its shutdown cleanup when the bind
  // failed. Every CLI verb against the healthy space then got auth_required, with nothing
  // pointing at the long-dead loser. Two halves, each must fail alone.

  // Half 1, behavioral: the shutdown clear deletes only the caller's own entry.
  const dir = await Deno.makeTempDir({ prefix: "radia-portrace-" });
  const credPath = `${dir}/credentials.json`;
  Deno.env.set("RADIA_CREDENTIALS", credPath);
  try {
    const { saveCredential, clearCredential } = await import("../src/credentials.ts");
    const base = "http://127.0.0.1:59998";
    saveCredential(base, { token: "winner-token", mintedAt: new Date().toISOString() });
    clearCredential(base, "loser-token");
    const file = JSON.parse(await Deno.readTextFile(credPath));
    assertEquals(file[base]?.token, "winner-token", "a clear conditioned on someone else's token deleted the entry");
    clearCredential(base, "winner-token");
    assertEquals(await Deno.readTextFile(credPath).catch(() => "gone"), "gone", "the owner's own clear no longer works");
  } finally {
    Deno.env.delete("RADIA_CREDENTIALS");
    await Deno.remove(dir, { recursive: true });
  }

  // Half 2, source-read like the --auth default above (main.ts runs on import, so it cannot be
  // driven in-process): the file writes happen only after the bind, and the clear names the token.
  // Comments stripped first; the fix is explained in one that names both calls.
  const main = (await Deno.readTextFile(new URL("../src/main.ts", import.meta.url)))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const bind = main.indexOf("startServer({ port");
  const save = main.indexOf("saveCredential(base");
  assert(bind >= 0 && save >= 0, "dev no longer binds or provisions this way; update this test with it");
  assert(bind < save, "dev writes the credential file BEFORE binding; a loser of a port race clobbers the winner's entry");
  assert(bind < main.indexOf("provisionObserver(space, base"), "…and the observer entry has the same problem");
  assert(/clearCredential\(base, operatorToken\)/.test(main), "dev's shutdown clear is unconditional; it deletes whatever dev wrote the entry last");
});

Deno.test("dev: OIDC is off until someone configures an issuer", async () => {
  // The posture: an unconfigured space refuses /v0/sessions/oidc outright. The endpoint requires
  // no credential, so "off by default" is the difference between opt-in SSO and every space
  // shipping an anonymous mint that trusts whatever issuer a later config typo names.
  const { Space } = await import("../src/core/space.ts");
  const { SqliteAdapter } = await import("../src/storage/sqlite.ts");
  const { makeHandler } = await import("../src/server/http.ts");
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  try {
    const space = new Space(adapter);
    assertEquals(space.oidcConfig, null, "an unconfigured space has no OIDC trust anchors");
    const res = await makeHandler(space, "<html>x</html>", false)(
      new Request("http://t/v0/sessions/oidc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id_token: "x" }),
      }),
    );
    assertEquals(res.status, 403);
    assertEquals((await res.json()).title, "oidc_not_configured");
  } finally {
    await adapter.close();
  }
});

Deno.test("paths: every runtime default lives under one directory", async () => {
  // The complaint this fixes: `.radia-blobs/`, `.radia-kek.json`, `.radia-chat-space.db` and
  // `.radia-chat-space.db-blobs/` were four top-level entries in a project, each named where it was
  // needed and never looked at as a set. One directory means `rm -rf .radia` is a complete reset
  // and the sandbox deny-list is one entry rather than a list that drifts.
  const { defaultBlobDir, defaultDbPath, defaultKekPath, radiaDir } = await import("../src/paths.ts");
  const dir = radiaDir();
  assertEquals(dir, ".radia");
  for (const p of [defaultDbPath("sqlite"), defaultDbPath("pglite"), defaultKekPath(), defaultBlobDir(undefined)]) {
    assert(p.startsWith(dir + "/"), `${p} is outside ${dir}`);
  }
  // Blobs sit beside their database when one was named, so a `--db` pointed elsewhere keeps a
  // space's bytes and its records together instead of splitting them across two places.
  assertEquals(defaultBlobDir("/tmp/x/space.db"), "/tmp/x/space.db-blobs");

  // The KEK is a SIBLING of the blob directory, never inside it: it decrypts every blob, so
  // copying the blobs alone must not carry the key along.
  assert(!defaultKekPath().startsWith(defaultBlobDir(undefined) + "/"), "the KEK is inside the blob directory");

  // Nothing may reintroduce a sibling: `.radia-<something>` in the repo root is the old shape.
  const ignore = await Deno.readTextFile(new URL("../.gitignore", import.meta.url));
  assert(/^\/\.radia\/$/m.test(ignore), ".gitignore no longer ignores the runtime directory");
  assert(!/\.radia-/.test(ignore), ".gitignore still names a `.radia-*` sibling; consolidate it");
});

Deno.test("flags: an optional-value flag distinguishes bare, valued and absent", async () => {
  // `--db` means "persist under the runtime dir", `--db /tmp/x` names a place, and no flag at all
  // is in-memory. Reading a bare flag's value as the next token is how `--db --port 7788` would
  // silently name a database `--port`.
  const { optionalFlag } = await import("../src/flags.ts");
  assertEquals(optionalFlag(["--db", "/tmp/x"], "--db"), "/tmp/x");
  assertEquals(optionalFlag(["--db"], "--db"), "");
  assertEquals(optionalFlag(["--db", "--port", "7788"], "--db"), "");
  assertEquals(optionalFlag(["--port", "7788"], "--db"), undefined);
});

Deno.test("flags: a verb reads its positional through the shared scanner, not argv[0]", () => {
  // A flag written BEFORE a positional would otherwise be taken as the positional, and for a verb
  // whose argument is a bare string that failure is SILENT: `permissions --json alice` cheerfully
  // reported on a principal named "--json" and printed a well-formed answer about nobody.
  //
  // The three verbs added most recently (`login`, `shred`, `permissions`) each had it. Checked
  // structurally rather than by driving the CLI: the rule is "use the scanner", and a per-verb
  // behavioural test would pass the moment someone added a fourth verb that does not.
  // Comments are stripped first: the rule is explained in a comment that NAMES the thing it
  // forbids, and prose is not code. (The same trap caught the `sessionOwner` guard in
  // examples/chat/smoke-login.ts, which had to match the import rather than the word.)
  const cli = Deno.readTextFileSync(new URL("../src/surfaces/cli.ts", import.meta.url))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const direct = [...cli.matchAll(/argv\[0\]/g)];
  assertEquals(direct.length, 0, "a verb still indexes argv directly; use positional(argv, n)");

  // …and the scanner has to know which switches carry no value, or it eats the token after one.
  const flags = Deno.readTextFileSync(new URL("../src/flags.ts", import.meta.url));
  for (const valueless of ["--json", "--compact", "--untainted", "--all", "--drain"]) {
    assert(
      new RegExp(`VALUELESS[^)]*"${valueless}"`, "s").test(flags),
      `${valueless} takes no value and must be in VALUELESS, or it swallows the next token`,
    );
  }
});

Deno.test("dev: --max-scan-rows tunes the budget, and 0 means unbounded rather than nothing", async () => {
  // A resource limit with no knob is one an operator can neither raise for a legitimate large scan
  // nor lower on a small machine. `main.ts` passed an EMPTY SpaceContext, so none of these limits
  // was reachable from the CLI at all; this is the first one that is.
  //
  // The 0 case is the reason this test exists rather than being obvious. The adapters refuse once
  // `examined >= scanBudget`, so passing a literal 0 through would refuse every undecidable read
  // after its first chunk: the exact opposite of what someone disabling a limit is asking for. It is
  // translated to "no budget" in `Space.compile`, and that translation is invisible at both ends.
  const { Space } = await import("../src/core/space.ts");
  const { SqliteAdapter } = await import("../src/storage/sqlite.ts");
  const { RadiaError } = await import("../src/core/errors.ts");

  const bounded = async (maxScanRows: number | undefined) => {
    const adapter = new SqliteAdapter(":memory:");
    await adapter.init();
    try {
      const space = new Space(adapter, maxScanRows === undefined ? {} : { maxScanRows });
      space.registerKind({ kind: "task", indexedPaths: [{ path: "tags", type: "array" }] });
      for (let i = 0; i < 60; i++) await space.put({ kind: "task", body: { tags: ["a"] } });
      try {
        // `$each` is the unpushable one, so this walks the kind (see pushdown.ts).
        await space.query({ kind: "task", match: { tags: { $each: "zz" } } }, 5);
        return "served";
      } catch (e) {
        return e instanceof RadiaError ? e.code : `unexpected: ${(e as Error).message}`;
      }
    } finally {
      await adapter.close();
    }
  };

  assertEquals(await bounded(20), "scan_budget_exceeded", "a small budget refuses");
  assertEquals(await bounded(0), "served", "0 must DISABLE the budget, not refuse everything");
  assertEquals(await bounded(undefined), "served", "the 200k default is far above a 60-record kind");

  // And the flag reaches it. Reading the source, like the --auth default above: the alternative is
  // starting a server, and the assertion should fail when this literal stops being wired.
  const main = await Deno.readTextFile(new URL("../src/main.ts", import.meta.url));
  assert(/flag\(args, "--max-scan-rows"\)/.test(main), "--max-scan-rows is no longer parsed in main.ts");
  assert(/\.\.\.\(maxScanRows === undefined \? \{\} : \{ maxScanRows \}\)/.test(main), "…or no longer reaches the Space");
  assert(/\[--max-scan-rows <n>\]/.test(main), "…or is missing from the usage text");
});

Deno.test("dev: one writer per database, and the loser is told who holds it", async () => {
  // PGlite is a single-writer WASM Postgres with no locking of its own, so two `radia dev` on one
  // data directory both started, served private copies, both reported "chain OK" at different
  // heads, and the last to exit won the files (plan-startup-ergonomics.md item 1). Nothing could
  // detect it after the fact: each process's own chain is internally consistent.
  const { acquireDbLock, lockRefusal } = await import("../src/lock.ts");
  const dir = await Deno.makeTempDir({ prefix: "radia-dblock-" });
  const db = `${dir}/space-pg`;
  try {
    const first = await acquireDbLock(db, "http://127.0.0.1:7911", 50);
    assert(first.ok, "the first space could not take the lock");

    const second = await acquireDbLock(db, "http://127.0.0.1:7913", 50);
    assert(!second.ok, "a second space took a lock the first one holds");
    assertEquals(second.heldBy?.base, "http://127.0.0.1:7911", "the loser cannot name the holder");
    const refusal = lockRefusal(db, second.heldBy);
    assert(refusal.includes(db) && refusal.includes("--db"), `the refusal must name the database and the way out: ${refusal}`);

    // Releasing hands it over: a restart on the same directory must not need a cleanup step.
    if (first.ok) first.release();
    const third = await acquireDbLock(db, "http://127.0.0.1:7911", 50);
    assert(third.ok, "the lock outlived its holder; a restart would be refused forever");
    if (third.ok) third.release();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }

  // And dev takes it, for local backends only: postgres is a server (concurrency is what it is
  // for) and an in-memory space shares nothing. Source-read like the --auth default above.
  const main = await Deno.readTextFile(new URL("../src/main.ts", import.meta.url));
  const lock = main.indexOf("acquireDbLock(dbPath");
  assert(lock >= 0, "dev no longer takes the database lock");
  assert(lock < main.indexOf("await storage.init()"), "the lock is taken after the adapter opens the files it protects");
  assert(/backend !== "postgres" && dbPath/.test(main.slice(lock - 200, lock)), "…or is no longer skipped for postgres and in-memory");
});

Deno.test("dev: a taken port is a message, not a stack trace", async () => {
  // The most likely restart failure printed `AddrInUse` plus eight frames of `ext:deno_net` after
  // two successful-looking startup lines (plan-startup-ergonomics.md item 2). The bind throws
  // synchronously, so shaping it is a catch; the exit code and the untouched credential file were
  // already right.
  const { startServer } = await import("../src/server/http.ts");
  const { Space } = await import("../src/core/space.ts");
  const { SqliteAdapter } = await import("../src/storage/sqlite.ts");
  const { RadiaError } = await import("../src/core/errors.ts");
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const stopping = new AbortController();
  try {
    const space = new Space(adapter);
    const port = 7897;
    startServer({ port, space, artifactPort: undefined, signal: stopping.signal });
    let caught: unknown;
    try {
      startServer({ port, space, artifactPort: undefined, signal: stopping.signal });
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof RadiaError, `a taken port must be a typed refusal, got: ${caught}`);
    assertEquals((caught as InstanceType<typeof RadiaError>).code, "port_in_use");
    assert((caught as Error).message.includes(String(port)), "the message must name the port");
  } finally {
    stopping.abort();
    await adapter.close();
  }

  // dev turns it into advice and exit 1, the shape the unreachable-space message set.
  const main = await Deno.readTextFile(new URL("../src/main.ts", import.meta.url));
  assert(/e\.code === "port_in_use"/.test(main), "dev no longer shapes a taken port");
  assert(/--artifact-port/.test(main.slice(main.indexOf('e.code === "port_in_use"'))), "…or no longer names both ports");
});

Deno.test("cli: query reads NEWEST first, and a full page says so and hands over the cursor", async () => {
  // The default read. It returned the OLDEST rows and capped at 500 in silence, so on a space with
  // 818 records `radia query interest --limit 1000` answered with 500 records from six hours
  // earlier and nothing saying either thing (plan-startup-ergonomics.md item 3). The console's
  // Records browser had the same bug and was fixed; the CLI kept it. The server already returned
  // `nextAfter` and the explain notes: only the printing was missing.
  const { startServer } = await import("../src/server/http.ts");
  const { Space } = await import("../src/core/space.ts");
  const { SqliteAdapter } = await import("../src/storage/sqlite.ts");
  const { runCli } = await import("../src/surfaces/cli.ts");
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const stopping = new AbortController();
  const dir = await Deno.makeTempDir({ prefix: "radia-cliquery-" });
  Deno.env.set("RADIA_CREDENTIALS", `${dir}/credentials.json`);
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    const space = new Space(adapter);
    space.registerKind({ kind: "note", indexedPaths: [{ path: "i", type: "number" }], claimable: false });
    for (let i = 1; i <= 5; i++) await space.put({ kind: "note", body: { i } });
    const port = 7899;
    const url = `http://127.0.0.1:${port}`;
    startServer({ port, space, artifactPort: undefined, signal: stopping.signal }); // auth open: no credential in play

    assertEquals(await runCli("query", ["note", "--limit", "2", "--url", url]), 0);
    const out = lines.join("\n");
    lines.length = 0;
    assert(/\{"i":5\}[\s\S]*\{"i":4\}/.test(out), `newest first, or a limit answers with history: ${out}`);
    assert(/more \(newest first\): radia query note .*--limit 2 --after \S+/.test(out), `a full page must hand over its cursor: ${out}`);
    assert(/more \(newest first\): radia query note --url/.test(out), `…carrying the flags that shaped the page: ${out}`);
    assert(out.includes("PAGE and not a population"), `…and carry the explain note that says why: ${out}`);

    // The cursor continues the page it came from, and --oldest is the way back to the old order.
    const cursor = out.match(/--after (\S+)/)?.[1];
    assert(cursor, "no cursor to follow");
    assertEquals(await runCli("query", ["note", "--limit", "2", "--after", cursor!, "--url", url]), 0);
    assert(/\{"i":3\}[\s\S]*\{"i":2\}/.test(lines.join("\n")), `the cursor must continue, not restart: ${lines.join("\n")}`);
    lines.length = 0;

    assertEquals(await runCli("query", ["note", "--limit", "2", "--oldest", "--url", url]), 0);
    assert(/\{"i":1\}[\s\S]*\{"i":2\}/.test(lines.join("\n")), `--oldest must restore ascending id order: ${lines.join("\n")}`);
    lines.length = 0;

    // A last page is not a page: no cursor, nothing to follow.
    assertEquals(await runCli("query", ["note", "--limit", "50", "--url", url]), 0);
    assert(!lines.join("\n").includes("more ("), `a complete answer must not offer a next page: ${lines.join("\n")}`);
  } finally {
    console.log = log;
    stopping.abort();
    await adapter.close();
    Deno.env.delete("RADIA_CREDENTIALS");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cli: what a table prints can be fed back in, and the two kind verbs say which is which", async () => {
  // Three papercuts with one thing in common: the output was true and unusable
  // (plan-startup-ergonomics.md item 9). The table printed `id.slice(-8)`, so the obvious next
  // command answered "no record"; `kinds` and `stats` disagreed about what exists, both correct,
  // neither saying that one means DECLARED and the other PRESENT.
  const { startServer } = await import("../src/server/http.ts");
  const { Space } = await import("../src/core/space.ts");
  const { SqliteAdapter } = await import("../src/storage/sqlite.ts");
  const { runCli } = await import("../src/surfaces/cli.ts");
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const stopping = new AbortController();
  const dir = await Deno.makeTempDir({ prefix: "radia-cliprint-" });
  Deno.env.set("RADIA_CREDENTIALS", `${dir}/credentials.json`);
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    const space = new Space(adapter);
    // Declared the way every client declares: a `kind_def` RECORD, which is what a remote reader
    // can see. (`registerKind` is in-process and writes nothing.)
    await space.put({ kind: "kind_def", body: { kind: "note", indexedPaths: [{ path: "i", type: "number" }], claimable: false } });
    await space.put({ kind: "note", body: { i: 1 } });
    await space.put({ kind: "undeclared_kind", body: { i: 2 } }); // allowed: a put must not race a declaration
    const port = 7896;
    const url = `http://127.0.0.1:${port}`;
    startServer({ port, space, artifactPort: undefined, signal: stopping.signal });

    // The id in the table is the id `get` takes. This is the round trip, not a format assertion.
    assertEquals(await runCli("query", ["note", "--url", url]), 0);
    const id = lines.join("\n").match(/\b(01[0-9A-HJKMNP-TV-Z]{24})\b/)?.[1];
    assert(id, `no whole record id in the table: ${lines.join("\n")}`);
    lines.length = 0;
    assertEquals(await runCli("get", [id!, "--url", url]), 0, "the id the table printed was refused by get");
    assert(lines.join("").includes('"kind": "note"'), `get returned something else: ${lines.join("")}`);
    lines.length = 0;

    // DECLARED vs PRESENT, said by whichever verb the reader is holding.
    assertEquals(await runCli("kinds", ["--url", url]), 0);
    assert(/DECLARED/.test(lines.join("\n")), `kinds must say which question it answers: ${lines.join("\n")}`);
    lines.length = 0;

    assertEquals(await runCli("stats", ["--url", url]), 0);
    const stats = lines.join("\n");
    assert(stats.includes("undeclared_kind is not declared"), `stats must name the undeclared kind: ${stats}`);
    const named = stats.split("PRESENT kinds")[1] ?? "";
    assert(!named.includes("note,") && !named.includes(" note "), `a DECLARED kind was called undeclared: ${stats}`);
    assert(!named.includes("kind_def"), `a RESERVED kind was called undeclared: ${stats}`);
  } finally {
    console.log = log;
    stopping.abort();
    await adapter.close();
    Deno.env.delete("RADIA_CREDENTIALS");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cli: a version skew between this build and the space is named, not resolved", async () => {
  // `radia version` reports the CLI build and `health` the space's, and they differed (0.0.1
  // against 0.0.0) with nothing saying so, which turns every later surprise into a hunt. A stub
  // space, because the real one always answers with this build's own version.
  const { runCli } = await import("../src/surfaces/cli.ts");
  const { VERSION } = await import("../src/version.ts");
  const dir = await Deno.makeTempDir({ prefix: "radia-skew-" });
  Deno.env.set("RADIA_CREDENTIALS", `${dir}/credentials.json`);
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  let served = "9.9.9"; // what the stub space claims to be
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, () =>
    Response.json({ status: "ok", version: served, api: "v0", storage: "stub", now: new Date().toISOString(), principal: "human:local" }));
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try {
    assertEquals(await runCli("health", ["--url", base]), 0);
    assert(
      lines.join("\n").includes(`this CLI is ${VERSION} and the space is 9.9.9`),
      `a version skew must be named: ${lines.join("\n")}`,
    );
    lines.length = 0;

    // And silent when they match: a note on every call is a note nobody reads.
    served = VERSION;
    assertEquals(await runCli("health", ["--url", base]), 0);
    assert(!lines.join("\n").includes("this CLI is"), `matching versions must say nothing: ${lines.join("\n")}`);
  } finally {
    console.log = log;
    await server.shutdown();
    Deno.env.delete("RADIA_CREDENTIALS");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dev: a start hands over a LINK, and a stop says the credential is gone", async () => {
  // What a person meets at both ends of a space's life (plan-startup-ergonomics.md item 9). The
  // start printed a 48-character token to paste by hand, while `login --console` already built the
  // fragment link the page understands; the stop printed nothing at all, hiding the one step that
  // decides whether the next CLI call 401s. Source-read like the `--auth` default above, since
  // `main.ts` runs on import and cannot be driven in-process.
  const main = await Deno.readTextFile(new URL("../src/main.ts", import.meta.url));
  assert(/console sign-in \$\{base\}\/#token=\$\{encodeURIComponent\(operatorToken\)\}/.test(main), "dev no longer prints a console sign-in link");
  assert(/operator token \(curl/.test(main), "…or no longer prints the raw token curl needs");
  assert(/if \(served\) console\.log\(`radia dev: stopped/.test(main), "dev's shutdown is silent again");
  // Conditional on having served: the port-in-use path reaches the same `finally` having written
  // nothing, and must not claim it cleaned a credential up.
  const stop = main.indexOf("radia dev: stopped");
  const clear = main.indexOf("clearCredential(base, operatorToken)");
  assert(clear >= 0 && clear < stop, "the stop line is printed before the cleanup it reports");
});
