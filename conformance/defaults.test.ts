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
