// A population must not be built from a page.
//
// The most repeated bug in this codebase (CLAUDE.md says so, and three audits found instances). The
// grep is narrow on purpose, because the general form is not checkable: whether a bounded read is a
// PAGE or a POPULATION is a question about intent, and `query(kind, 500)` looks careful either way.
//
// What IS checkable is the one shape where the intent is written down. Feeding a `query()` result
// into `activeByKey` / `newestByKey` / `activeSet` says "this is the current set", and those
// projections are only correct over the whole history: a bounded read hands them a prefix and they
// answer confidently about it. The safe inputs (`queryAll`, `readExhaustively`, `query_all`) page to
// exhaustion and refuse rather than truncate, so the rule is simply which call feeds the projection.
//
// It found two real defects when first written, both in the chat's procedure lookup, and both worse
// than the shape suggests: `query` with a limit and no `dir` returns the OLDEST matches, so a
// procedure re-saved past the limit resolved to a stale version while looking correct.
//
// COMMENTS ARE STRIPPED FIRST, the lesson `layering.test.ts` records twice: a structural grep that
// matches its own explanation reports a violation that is not there. This file's own prose names
// every symbol it forbids.

import { assertEquals } from "@std/assert";

const ROOTS = ["src", "sdk", "extensions", "examples"];

/** The projections that answer "what is the current set". Correct only over a whole history. */
const PROJECTIONS = ["activeByKey", "newestByKey", "activeSet"];

/** Reads that page to exhaustion, or that are already a complete view. */
const EXHAUSTIVE = /\b(queryAll|query_all|readExhaustively|registry|liveInterests|readBindings|readRegistryOf)\s*(<[^>]*>)?\s*\(/;

/** Source with `//` and block comments removed. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
}

async function tsFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: URL, prefix: string) => {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory) await walk(new URL(`${entry.name}/`, dir), `${path}/`);
      else if (entry.name.endsWith(".ts")) out.push(path);
    }
  };
  await walk(new URL(`../${root}/`, import.meta.url), `${root}/`);
  return out.sort();
}

Deno.test("[registry-cost] a latest-wins projection is never fed a bounded read", async () => {
  const violations: string[] = [];
  for (const root of ROOTS) {
    for (const file of await tsFiles(root)) {
      // `registry.ts` DEFINES the projections, and this test names them to forbid them elsewhere.
      if (file.endsWith("sdk/ts/registry.ts") || file.endsWith("src/core/registry.ts")) continue;
      const text = code(await Deno.readTextFile(new URL(`../${file}`, import.meta.url)));
      const lines = text.split("\n");
      for (const [i, line] of lines.entries()) {
        const used = PROJECTIONS.find((p) => new RegExp(`\\b${p}\\s*(<[^>]*>)?\\s*\\(`).test(line));
        if (!used) continue;
        // BOTH DIRECTIONS. It looked only backward, and that missed the inline form entirely, where
        // the read is an ARGUMENT on the following lines: two live defects sat in
        // `examples/chat/client/` the whole time this guard was green. The `Population` brand is
        // what actually caught them and is the primary rule now; this grep survives for its
        // message, and for the window either side of a call that a type cannot explain.
        const window = lines.slice(Math.max(0, i - 6), i + 5).join("\n");
        if (EXHAUSTIVE.test(window)) continue;
        // A projection over records the caller already holds (a parameter, a literal, a variable
        // built elsewhere) is not this bug: the bounded read, if any, is somewhere else and the
        // rule cannot see it. Only flag when a bounded READ is visibly the input.
        if (!/\.\s*(query|getEvents|getChildren)\s*\(/.test(window)) continue;
        violations.push(`${file}:${i + 1}  ${used} over a bounded read`);
      }
    }
  }
  assertEquals(
    violations,
    [],
    "a latest-wins projection over a bounded read answers confidently about a PREFIX. " +
      "Use queryAll/readExhaustively, which page to exhaustion and report an incomplete view.",
  );
});

Deno.test("[registry-cost] no readExhaustively caller states a page direction", async () => {
  // `readExhaustively` builds the whole `Page` and hands it over, so a caller passes it through and
  // never names a direction. Before that the contract was prose ("must return records
  // NEWEST-FIRST") and FIVE call sites in this repo paged ascending against it: correct only
  // because the function exhausts, and on the incomplete path they would have kept the OLDEST
  // records, the half missing every retirement, while `complete: false` said only that something
  // was missing. A caller that reaches for `dir` here has reconstructed the rule it cannot own.
  const violations: string[] = [];
  for (const root of ROOTS) {
    for (const file of await tsFiles(root)) {
      if (file.endsWith("sdk/ts/registry.ts")) continue; // where the direction is decided
      const text = code(await Deno.readTextFile(new URL(`../${file}`, import.meta.url)));
      const lines = text.split("\n");
      for (const [i, line] of lines.entries()) {
        if (!/\breadExhaustively\s*(<[^>]*>)?\s*\(/.test(line)) continue;
        // The reader is the first argument, so it is within a few lines of the call.
        const window = lines.slice(i, i + 8).join("\n");
        if (/\bdir\s*:/.test(window)) violations.push(`${file}:${i + 1}  names a direction`);
      }
    }
  }
  assertEquals(
    violations,
    [],
    "readExhaustively builds the Page; a caller passes it through rather than restating the direction",
  );
});

Deno.test("[registry-cost] the page direction is decided in one place", async () => {
  // It was decided in FIVE, in three forms: twice per dialect (records and children) plus
  // `pageRecords`. The SQL paths derive the cursor comparison from the direction; the oracle path
  // reverses a sorted array and never sees a cursor. Changing four of the five produced not a test
  // failure but a SILENTLY BROKEN CURSOR: a 25-record kind paged 139 records with repeats and never
  // terminated, because SQL walked one way while the oracle ordered the other, so `after` pointed
  // backwards. `pageClause` emits the whole clause so there is nothing left to mismatch, and this
  // is what stops a sixth site being written from scratch.
  const violations: string[] = [];
  for (const file of await tsFiles("src")) {
    if (file.endsWith("core/matching.ts")) continue; // where it is decided
    const text = code(await Deno.readTextFile(new URL(`../${file}`, import.meta.url)));
    for (const [i, line] of text.split("\n").entries()) {
      // The DECISION is a comparison against a direction literal. Asking whether a caller SUPPLIED
      // one is a different question and stays legal: `space.ts` refuses a cursor combined with
      // `orderBy`, and `inspection.ts` reports "no dir was given" in an explain note. Neither
      // resolves a default, and rewriting them to the resolved value would make both wrong.
      // Two forms, because the second slipped past the first. Comparing (`page.dir === "desc"`) was
      // the shape the five original sites used; DEFAULTING (`page?.dir ?? "asc"`) is the same
      // decision written the other way round, and the query handler grew one building `nextCursor`
      // while this guard stayed green. `pageIsDescending` is the export that exists to be used
      // instead.
      if (
        /page\??\.dir\s*===\s*"(asc|desc)"/.test(line) ||
        /page\??\.dir\s*(\?\?|\|\|)\s*"(asc|desc)"/.test(line)
      ) {
        violations.push(`${file}:${i + 1}  ${line.trim().slice(0, 70)}`);
      }
    }
  }
  assertEquals(
    violations,
    [],
    "the page direction and its cursor comparison come from `pageClause` in core/matching.ts, together",
  );
});

Deno.test("[registry-cost] every escape from the Population brand is accounted for", async () => {
  // `Population` (sdk/ts/registry.ts) is what the two greps above could not be: a latest-wins
  // projection now takes only records from a read that exhausted or said it could not. It found two
  // live defects the moment it compiled, both invisible to the first grep because its window looks
  // BACKWARD from the projection and both reads were inline arguments AFTER it: the chat's grant
  // review paged the newest 50 `grant_request` records, and its tool list the newest 200
  // `procedure` records. Neither drops stale versions, which is what `dir: "desc"` suggests; both
  // drop whole KEYS, so the oldest pending request and the earliest-saved procedure disappeared.
  //
  // `unsafeAsPopulation` is the legal way out, and this test is the ledger. A new entry is a
  // deliberate edit here, and a GROWING count is the signal that the brand is being routed around.
  const allowed = new Map([
    ["sdk/ts/registry.ts", 1], // readExhaustively, where paging to exhaustion earns it
    ["sdk/ts/client.ts", 1], // queryAll, same
    ["extensions/ts/workspace.ts", 1], // readAllManifests: its own budget (maxPages), same exhaustion rule
    ["src/surfaces/cli.ts", 1], // two queryAll halves concatenated; the type cannot see that
    ["test/conformance/suites/gc.ts", 3], // sets the test itself wrote, small and known
    ["test/registry.test.ts", 1], // one `pop()` helper: a unit test for a projection builds its own
  ]);
  const found = new Map<string, number>();
  for (const root of ROOTS.concat("test")) {
    for (const file of await tsFiles(root)) {
      const text = code(await Deno.readTextFile(new URL(`../${file}`, import.meta.url)));
      // The definition is not a use. Counted by call, so two escapes in one file cannot hide as one.
      const uses = text.split(/\bunsafeAsPopulation\s*\(/).length - 1 -
        (/export function unsafeAsPopulation/.test(text) ? 1 : 0);
      if (uses > 0) found.set(file, uses);
    }
  }
  assertEquals(
    Object.fromEntries([...found].sort()),
    Object.fromEntries([...allowed].sort()),
    "an escape from the Population brand is legal, but it is listed here with the reason it holds",
  );
});

Deno.test("[registry-cost] a relayed pattern's own order_by is honoured, not overridden", async () => {
  // `queryNewest`/`queryOldest` name a direction of the natural id order, which the space refuses
  // combined with `order_by` (a pattern that already states its order). At a call site with a
  // LITERAL pattern that is a programmer error and the SDK throws. At a RELAY it is not: the
  // pattern belongs to whoever called in, `order_by` is data, and hard-coding a direction turns
  // every ordered query they make into an error.
  //
  // Both relays in this repo were broken exactly that way when the SDK's `query(p, n)` was split
  // and the call sites rewritten mechanically: the MCP adapter's `space_query` and the broker's
  // query proposal, the second a NORMATIVE surface. Neither had coverage, so the whole suite
  // stayed green. The rule is structural because the trigger is: a pattern the call site did not
  // write is one it cannot make assumptions about.
  const dispatches = /orderBy\?\.length|orderBy\s*&&|queryOrdered/;
  const allowed = new Set([
    // The pattern is the CALLER'S OWN and `readNewest` is its explicit request for newest-first.
    // Asking for both is a contradiction the caller wrote, so throwing is the answer, not relaying.
    "sdk/ts/client.ts",
  ]);
  const violations: string[] = [];
  for (const root of ROOTS) {
    for (const file of await tsFiles(root)) {
      if (allowed.has(file)) continue;
      const text = code(await Deno.readTextFile(new URL(`../${file}`, import.meta.url)));
      const lines = text.split("\n");
      for (const m of text.matchAll(/\.query(?:Oldest|Newest)\(\s*([^\s{])/g)) {
        // A first argument that is not an object literal is a pattern from somewhere else.
        const i = text.slice(0, m.index).split("\n").length - 1;
        const window = lines.slice(Math.max(0, i - 8), i + 3).join("\n");
        if (dispatches.test(window)) continue;
        violations.push(`${file}:${i + 1}  ${lines[i].trim().slice(0, 72)}`);
      }
    }
  }
  assertEquals(
    violations,
    [],
    "a relayed pattern may carry order_by: dispatch to queryOrdered instead of imposing a direction",
  );
});
