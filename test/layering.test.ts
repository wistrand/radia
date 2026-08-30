// Two rules that were prose in CLAUDE.md and enforced by nothing.
//
// Both are the same kind of rule: an invariant about the SHAPE of the source, which no type checker
// can see and no runtime test can fail on. A dependency edge added in the wrong direction compiles,
// passes every suite, and is discovered a year later when the thing it was protecting is gone. That
// is precisely the class of rule worth a grep.
//
// COMMENTS ARE STRIPPED FIRST, and that is not a detail. Structural greps in this repo have twice
// matched their own explanatory comments and reported a violation that did not exist; the second
// time, the comment describing the rule was the only thing breaking it.

import { assertEquals } from "@std/assert";
import { dirname, join, normalize } from "@std/path";

const SRC = new URL("../src/", import.meta.url);

async function tsFiles(root: URL, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory) out.push(...await tsFiles(new URL(`${entry.name}/`, root), `${path}/`));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out.sort();
}

/** Source with `//` and block comments removed, so a rule stated in prose cannot break itself. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
}

// ── 1. the runtime never depends on a surface or a convention ────────────────────────────────────

Deno.test("[layering] the runtime imports neither a surface nor an extension", async () => {
  // `src/core`, `src/server` and `src/storage` ARE the runtime. `src/surfaces` (the CLI, the MCP
  // adapter) are `/v0` clients that happen to ship in the same binary, and `extensions/` are
  // conventions built on the space. The runtime knowing about either is how a coordination
  // runtime acquires an opinion about files, tools, or how a person invokes it.
  //
  // The edge is allowed in exactly one direction, which is what makes a workspace verb in the CLI
  // an ordinary client feature rather than a tier violation.
  const violations: string[] = [];
  for (const dir of ["core", "server", "storage"]) {
    const root = new URL(`${dir}/`, SRC);
    for (const file of await tsFiles(root, `src/${dir}/`)) {
      const text = code(await Deno.readTextFile(new URL(file.replace(`src/${dir}/`, ""), root)));
      for (const [, spec] of text.matchAll(/from\s+"([^"]+)"/g)) {
        if (/(^|\/)extensions\//.test(spec) || /(^|\/)surfaces\//.test(spec)) {
          violations.push(`${file} -> ${spec}`);
        }
      }
    }
  }
  assertEquals(violations, [], "the runtime must not depend on a surface or an extension");
});

Deno.test("[layering] an extension never imports the runtime, nor an example", async () => {
  // The other half, and the one CLAUDE.md already states: an extension composes `/v0` through the
  // SDK. If it needs a runtime change it is not an extension. Stated for both directions here so
  // the pair is readable in one place.
  const root = new URL("../extensions/ts/", import.meta.url);
  const violations: string[] = [];
  for (const file of await tsFiles(root)) {
    const text = code(await Deno.readTextFile(new URL(file, root)));
    for (const [, spec] of text.matchAll(/from\s+"([^"]+)"/g)) {
      // `examples/` too, and that half was stated without being enforced: `workspace.ts` carries a
      // note explaining that it DUPLICATED a media-type table because "an extension may not import
      // an example". A rule with a workaround written beside it and no guard behind it is the one
      // to check, especially now that machinery has moved out of `examples/chat` into here — an
      // import pointing back would leave the layer nominal.
      if (/(^|\/)src\//.test(spec)) violations.push(`extensions/ts/${file} -> ${spec}`);
      if (/(^|\/)examples\//.test(spec)) violations.push(`extensions/ts/${file} -> ${spec}`);
    }
  }
  assertEquals(violations, [], "an extension imports the SDK, never src/ and never an example");
});

Deno.test("[layering] the SDK imports nothing from src/, so the package it ships in resolves", async () => {
  // NOT a purity rule, and it was not caught because this file did not look here. `build-release.sh`
  // stages `sdk/` and `extensions/` into the npm package and no `src/`, so any `../../src/` import
  // left in the SDK is a path that does not exist in the published artifact — the package's own
  // entry point (`"." : "./sdk/client.ts"`) was importing four such paths for runtime VALUES.
  //
  // TYPE imports count too. A type import is erased at run time, so it fails later and more
  // confusingly: the package runs and then fails to type-check, which is the same class of "works
  // until someone checks" the rest of this file exists to close.
  const root = new URL("../sdk/ts/", import.meta.url);
  const violations: string[] = [];
  for (const file of await tsFiles(root)) {
    const text = code(await Deno.readTextFile(new URL(file, root)));
    for (const [, spec] of text.matchAll(/from\s+"([^"]+)"/g)) {
      if (/(^|\/)src\//.test(spec)) violations.push(`sdk/ts/${file} -> ${spec}`);
    }
  }
  assertEquals(violations, [], "the SDK owns its wire vocabulary; src/ re-exports from it");
});

Deno.test("[layering] every valueless CLI switch is declared, or it eats the next argument", async () => {
  // An order-dependent, silent parse bug: `positional()` assumes an undeclared `--flag` consumes the
  // token after it, so `radia shred --shared <id>` lost the id while `radia shred <id> --shared`
  // worked. Derived from the source rather than listed here, because a hand-kept list is the thing
  // that fell out of date in the first place.
  const cli = code(await Deno.readTextFile(new URL("../src/surfaces/cli.ts", import.meta.url)));
  const flags = code(await Deno.readTextFile(new URL("../src/flags.ts", import.meta.url)));
  const declared = new Set([...flags.matchAll(/"(--?[a-z-]+)"/g)].map((m) => m[1]));
  // `has(argv, "--x")` is a switch by construction: it is read as a boolean and takes no value.
  const switches = [...cli.matchAll(/\bhas\(argv,\s*"(--[a-z-]+)"\)/g)].map((m) => m[1]);
  const undeclared = [...new Set(switches)].filter((f) => !declared.has(f)).sort();
  assertEquals(undeclared, [], "add these to VALUELESS in src/flags.ts");
});

// ── 2. the platform seam ─────────────────────────────────────────────────────────────────────────

Deno.test("[layering] nothing under src/ reaches for Deno.* outside the platform seam", async () => {
  // `src/platform.ts` is the one file that touches the host, so a port of this runtime to another
  // JS host is one file rather than a search. The rule has been in CLAUDE.md since M0 and has been
  // enforced by nobody, which means it has held by habit.
  //
  // ONE EXCEPTION, and it is documented rather than tolerated: `src/storage/postgres.ts` wraps
  // `Deno.connect` to set TCP_NODELAY, because the driver exposes no socket hook. Adding a second
  // exception is a decision to make deliberately, here, not a line to slip past review.
  const allowed = new Set(["platform.ts", "storage/postgres.ts"]);
  const violations: string[] = [];
  for (const file of await tsFiles(SRC)) {
    if (allowed.has(file)) continue;
    const text = code(await Deno.readTextFile(new URL(file, SRC)));
    const hits = [...text.matchAll(/\bDeno\.[A-Za-z]+/g)].map((m) => m[0]);
    if (hits.length > 0) violations.push(`src/${file}: ${[...new Set(hits)].join(", ")}`);
  }
  assertEquals(violations, [], "add the operation to src/platform.ts instead");
});

Deno.test("[layering] a surface is a /v0 client, so it takes no runtime VALUE from src", async () => {
  // The property that made moving these two out of `src/` cheap, kept honest now that it is
  // load-bearing. A surface may import shared host infrastructure (platform, flags, credentials)
  // and may import TYPES from anywhere, because a type is erased and creates no dependency at run
  // time. What it must not do is call into the runtime: the CLI and the MCP adapter reach a space
  // over `/v0` exactly as an external client does, and a shortcut through `Space` would make them
  // privileged in a way no other client can be.
  const root = new URL("surfaces/", SRC);
  // Host infrastructure a surface may take a VALUE from, because none of it is the runtime:
  // the platform seam, flag parsing, where a credential lives, where files go, what this build
  // calls itself, and where a diagnostic goes. Widening this list is the thing to think twice
  // about, so the test for membership is stated rather than assumed: `src/log.ts` qualifies
  // because it imports only `platform.ts`, holds no space state, and would be the FIRST thing a
  // port to another host had to provide. It is a destination, not a runtime.
  const infrastructure = /(^|\/)(platform|flags|credentials|paths|version|log)\.ts$/;
  const violations: string[] = [];
  for (const file of await tsFiles(root, "src/surfaces/")) {
    const text = code(await Deno.readTextFile(new URL(file.replace("src/surfaces/", ""), root)));
    // Group 1 is the import CLAUSE, group 2 is the path. Binding `[full, spec]` puts the clause in
    // `spec`, so every comparison below runs against `{ Space } ` instead of `../core/space.ts` and
    // the whole check passes by matching nothing. That is what this test is FOR, and it shipped
    // green until each guard was deliberately fed a violation. Assert that a guard fails when it
    // should; a structural test nobody has seen fail is a structural test nobody has tested.
    for (const [, clause, spec] of text.matchAll(/import\s+([\s\S]*?)from\s+"([^"]+)"/g)) {
      if (!spec.startsWith("../")) continue;
      // RESOLVED against the importing file, not by stripping `../` and hoping. Stripping loses
      // the depth, so `src/surfaces/mcp/server.ts -> ../media.ts` (a SIBLING surface file, one
      // level up and still inside this layer) read identically to `-> ../core/space.ts`, and the
      // guard reported a legitimate import as a layering violation.
      const resolved = normalize(join(dirname(file), spec));
      // Another SURFACE is not the runtime: this layer is a directory precisely so its parts can
      // share, and `media.ts` is a table both the CLI and the MCP adapter need on opposite sides
      // of the same transfer.
      if (resolved.startsWith("src/surfaces/")) continue;
      if (infrastructure.test(resolved) || resolved.startsWith("sdk/")) continue;
      // An EXTENSION is allowed, and is the reason this layer is a directory: a convention built on
      // `/v0` is exactly what a client may compose, and `workspace-git` is that. The rule being
      // enforced is "no runtime value", not "no imports"; an extension is not the runtime, and the
      // guard above already proves the runtime cannot reach back the other way.
      if (resolved.startsWith("extensions/")) continue;
      if (/^\s*type\b/.test(clause)) continue; // `import type { … }` is erased at run time
      violations.push(`${file} -> ${spec}`);
    }
  }
  assertEquals(violations, [], "a surface reaches a space over /v0, like any other client");
});

Deno.test("[layering] the RUNTIME logs; only a surface prints", async () => {
  // `console.log` had 40 call sites with no level, no source, no destination and no way to turn any
  // of it on or off (`src/log.ts`). The split this enforces is not "no printing": a CLI verb's
  // ANSWER is stdout and must stay there, and `radia mcp` must never print to stdout at all, since
  // that is its JSON-RPC channel. So the rule is about WHO: the runtime says things about itself
  // through the logger, and a surface prints what its user asked for.
  //
  // `src/main.ts` is exempt as the entry point, which owns the usage text, the startup summary and
  // the exit path. `src/log.ts` is exempt because it IS the destination.
  const runtime = ["core/", "server/", "storage/"];
  const allowed = new Set(["main.ts", "log.ts"]);
  const violations: string[] = [];
  for (const file of await tsFiles(SRC)) {
    if (allowed.has(file) || !runtime.some((d) => file.startsWith(d))) continue;
    const text = code(await Deno.readTextFile(new URL(file, SRC)));
    // A STATEMENT, so a line-start match: `src/core/seal.ts` and `src/storage/crypto.ts` both
    // advise the reader to run `deno eval 'console.log(btoa(…))'` to generate a key, and that
    // string is not a call. Stripping comments is not enough when the text is help output.
    const hits = [...text.matchAll(/^\s*console\.[a-z]+\(/gm)].map((m) => m[0].trim());
    if (hits.length > 0) violations.push(`src/${file}: ${[...new Set(hits)].join(", ")}`);
  }
  assertEquals(violations, [], "use getLogger(<component>) from src/log.ts; a bare console call has no level and no destination");
});

// ── the authorization seam: core verbs do not authorize themselves ───────────────────────────────
//
// Enforcement lives per VERB in different layers (`agent_docs/design-auth.md`, "Where each verb is
// enforced"): `put`/`take`/`query` in the handlers, `ack`'s result and a watch's scope in core. So
// a Space instance IS the unauthorized API, and nothing but convention stops a new caller from
// claiming records ungranted. Two guards, both proven to FAIL on a planted violation.

Deno.test("[layering] a Space is constructed only where the wire wraps it", async () => {
  // `new Space(` in src/ is allowed exactly where `makeHandler` (or `runCli`'s boot) takes custody
  // of it. Everyone else reaches the space through `/v0`, where the handlers enforce grants. Tests
  // and bench construct spaces too, deliberately (they test the unauthorized API); this scans src/.
  const violations: string[] = [];
  const allowed = new Set(["main.ts", "browser.ts"]);
  for (const file of await tsFiles(SRC, "src/")) {
    const text = code(await Deno.readTextFile(new URL(file.replace("src/", ""), SRC)));
    if (allowed.has(file.replace("src/", ""))) continue;
    if (/new Space\(/.test(text)) violations.push(`${file} constructs a Space`);
    if (/import\s*{[^}]*\bSpace\b[^}]*}\s*from/.test(text.replace(/import type[^;]+;/g, ""))) {
      violations.push(`${file} imports Space as a value`);
    }
  }
  assertEquals(violations, [], "construct a Space only in src/main.ts or src/browser.ts; anywhere else, be a /v0 client");
});

Deno.test("[layering] every coordination call on a Space is in the ledger, with its authorization named", async () => {
  // The LEDGER: file -> verb -> count, each entry naming where its authorization happens. A new
  // call site fails this test by design: either follow the file's authorize-then-call pattern and
  // bump the count, or write the reason a grant check is deliberately absent. The receiver is
  // matched by the conventional name `space`; the construction guard above is what keeps instances
  // from existing under other names outside the allowlisted births.
  // TWO ledgers since `Space.as(principal)` became the authorized API. RAW verbs are the
  // runtime's own, attribution-only doors; a handler holding a principal has no business calling
  // one, so the raw ledger is nearly empty and the handle ledger counts each handler's `as(`.
  const RAW: Record<string, Record<string, number>> = {
    // provisionObserver: a BOOT-TIME operator write, before any request principal exists. The one
    // raw coordination call in src/ outside core.
    "src/credentials.ts": { put: 1 },
  };
  const HANDLES: Record<string, number> = {
    "src/server/handlers/records.ts": 4, //  put, query, readOne, registryOf handlers
    "src/server/handlers/leases.ts": 5, //   take + the four settles
    "src/server/handlers/watches.ts": 1,
    "src/server/handlers/artifacts.ts": 6, // upload, three read gates, capability mint, redemption
  };
  const foundRaw: Record<string, Record<string, number>> = {};
  const foundAs: Record<string, number> = {};
  for (const file of await tsFiles(SRC, "src/")) {
    const text = code(await Deno.readTextFile(new URL(file.replace("src/", ""), SRC)));
    for (const [, verb] of text.matchAll(/\bspace\.(put|take|ack|nack|release|renew|query|readOne|registryOf|putArtifact|createWatch|registerKind)\(/g)) {
      foundRaw[file] = foundRaw[file] ?? {};
      foundRaw[file][verb] = (foundRaw[file][verb] ?? 0) + 1;
    }
    const asCount = [...text.matchAll(/\bspace\.as\(/g)].length;
    if (asCount) foundAs[file] = asCount;
  }
  assertEquals(foundRaw, RAW, "a RAW coordination call appeared outside the ledger; use space.as(principal), or ledger why not");
  assertEquals(foundAs, HANDLES, "a handle site appeared or moved; keep the count honest");
});

Deno.test("[layering] no doc comment is stranded above another doc comment", async () => {
  // The edit hazard: inserting a new symbol BETWEEN an existing doc comment and its subject
  // silently re-attaches the comment to the wrong thing, and nothing type-checks it. Nine stood in
  // the tree when this was written, each a doc separated from its symbol by a later insertion
  // (`kindDefKey`'s doc sat on `fnv1a`, `WorkspaceFile`'s on a kind declaration). A `*/` followed
  // by a `/**` with nothing but blank lines between means the first comment documents NOTHING:
  // reunite it with its symbol, fold it into the second, or make section prose `//` like a header.
  const violations: string[] = [];
  const roots: [URL, string][] = [
    [SRC, "src/"],
    [new URL("../sdk/ts/", import.meta.url), "sdk/ts/"],
    [new URL("../extensions/ts/", import.meta.url), "extensions/ts/"],
  ];
  for (const [root, prefix] of roots) {
    for (const file of await tsFiles(root, prefix)) {
      const lines = (await Deno.readTextFile(new URL(file.replace(prefix, ""), root))).split("\n");
      let prev = "";
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue; // blank lines between the pair do not reunite anything
        if (/\*\/\s*$/.test(prev) && /^\s*\/\*\*/.test(line)) violations.push(`${file}:${i + 1}`);
        prev = line;
      }
    }
  }
  assertEquals(violations, [], "a doc comment ends and another begins with no code between them; the first is orphaned");
});
