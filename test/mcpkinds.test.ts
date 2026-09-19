// `space_kinds` joined with the caller's own permissions (src/surfaces/mcp/kinds.ts). Each kind says
// what the caller may do with it; a kind it cannot use is listed by NAME only, never hidden and never
// described, since its usage text is what drew policy-bound agents into stalling on it.

import { assert, assertEquals } from "@std/assert";
import { withAccess } from "../src/surfaces/mcp/kinds.ts";
import type { EffectivePermissions, KindDef } from "../sdk/ts/wire.ts";

const def = (kind: string): KindDef => ({ kind, indexedPaths: [{ path: "case", type: "keyword" }], usage: `${kind} usage` });
const defs = [def("board"), def("change_request"), def("attestation"), def("kind_def"), def("grant")];
const perms = (over: Partial<EffectivePermissions> = {}): EffectivePermissions => ({
  principal: "run:x",
  subject: "agent:m",
  privileged: false,
  kinds: [
    { kind: "attestation", operations: ["put"], readsScopedToSelf: false, patterns: [{ check: "integrity" }], unpatterned: false },
    { kind: "board", operations: ["query", "read_one"], readsScopedToSelf: true, patterns: [], unpatterned: true },
    { kind: "kind_def", operations: ["query"], readsScopedToSelf: false, patterns: [], unpatterned: true },
  ],
  ops: { reachable: false, kinds: [] },
  opsPowers: [],
  complete: true,
  ...over,
});

Deno.test("[mcp kinds] each kind says what the caller may do, and a closed kind is a name only", () => {
  const { kinds, notes } = withAccess(defs, perms());
  const by = new Map(kinds.map((k) => [k.kind, k]));
  assertEquals(by.get("attestation")!.you, { operations: ["put"], patterns: [{ check: "integrity" }] }, "the pattern IS the displayed authority");
  assertEquals(by.get("board")!.you, { operations: ["query", "read_one"], readsScopedToSelf: true }, "an unpatterned grant bounds nothing, so no patterns");
  assertEquals(by.get("change_request"), { kind: "change_request", you: "no access" }, "no usage, no paths: listed by name only");
  assertEquals(notes, []);
});

Deno.test("[mcp kinds] a pattern is shown as exact only when every grant on the kind carries it", () => {
  // The union `EffectivePermissions` reports is across ALL grants on a kind; enforcement asks only
  // the grants for the operation. A patterned put beside an unpatterned query is not an unbounded put.
  const row = (patterns: Record<string, unknown>[], unpatterned: boolean) =>
    withAccess([def("attestation")], perms({ kinds: [{ kind: "attestation", operations: ["put", "query"], readsScopedToSelf: false, patterns, unpatterned }] }));
  const mixed = row([{ check: "integrity" }], true);
  assertEquals(mixed.kinds[0].you, { operations: ["put", "query"], patterns: [{ check: "integrity" }], patternsPartial: true });
  assertEquals(mixed.notes.length, 1, "the partial flag is explained, once");
  assertEquals(row([{ check: "a" }, { check: "b" }], false).kinds[0].you, { operations: ["put", "query"], patterns: [{ check: "a" }, { check: "b" }], patternsPartial: true });
  assertEquals(row([{ check: "a" }, { check: "a" }], false).kinds[0].you, { operations: ["put", "query"], patterns: [{ check: "a" }] }, "one pattern on every grant IS exact");
});

Deno.test("[mcp kinds] usable first, reserved after, closed last", () => {
  const order = withAccess(defs, perms()).kinds.map((k) => k.kind);
  assertEquals(order, ["board", "attestation", "kind_def", "change_request", "grant"]);
});

Deno.test("[mcp kinds] privileged sees every declaration whole; the caveats are said, not implied", () => {
  const all = withAccess(defs, perms({ privileged: true }));
  assert(all.kinds.every((k) => k.you === "all" && "usage" in k));
  const notes = withAccess(defs, perms({ complete: false, opsPowers: ["observe"], actingFor: "agent:caller", delegable: [{ kind: "grant", operations: ["put"] }] })).notes;
  assertEquals(notes.length, 4, notes.join(" | "));
});
