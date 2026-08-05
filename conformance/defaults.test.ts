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
  assert(/new Space\(storage, maxScanRows === undefined \? \{\} : \{ maxScanRows \}/.test(main), "…or no longer reaches the Space");
  assert(/\[--max-scan-rows <n>\]/.test(main), "…or is missing from the usage text");
});
