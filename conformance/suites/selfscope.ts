// Self-scoped ops: an agent observing its OWN process state without operator privilege.
//
// The asymmetry this closes is that every reflexive capability used to be reserved to the outside
// — a participant could be observed but could not observe itself (research-self-modeling.md).
//
// The thing to test hardest is the AGGREGATE. A scoped list that leaks is obvious: a foreign
// record shows up and someone notices. A scoped count that leaks is invisible — the number just
// looks plausible. So every case here puts ANOTHER principal's records in the same space and
// asserts on what the scoped caller is told, not merely on what it can reach.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import { Space } from "../../src/core/space.ts";
import type { StatsScope } from "../../src/storage/adapter.ts";
import { handleQuery } from "../../src/server/handlers/records.ts";

/** A space holding two principals' records of two kinds. */
async function twoAuthors(adapter: Parameters<Suite["run"]>[0]) {
  const mine = new Space(adapter, { principal: "run:mine" });
  const theirs = new Space(adapter, { principal: "run:theirs" });
  for (const s of [mine, theirs]) {
    s.registerKind({ kind: "note", indexedPaths: [{ path: "n", type: "integer" }] });
    s.registerKind({ kind: "secret", indexedPaths: [{ path: "n", type: "integer" }] });
  }
  for (let i = 0; i < 3; i++) await mine.put({ kind: "note", body: { n: i } });
  for (let i = 0; i < 5; i++) await theirs.put({ kind: "note", body: { n: i } });
  await mine.put({ kind: "secret", body: { n: 0 } });
  await theirs.put({ kind: "secret", body: { n: 0 } });
  const scope: StatsScope = { createdBy: ["run:mine"], kinds: ["note"] };
  return { mine, theirs, scope };
}

const countOf = (rows: { kind: string; count: number }[], kind: string) =>
  rows.filter((r) => r.kind === kind).reduce((a, r) => a + r.count, 0);

export const selfScopeSuites: Suite[] = [
  {
    name: "a scoped aggregate counts only the caller's records, not the space's",
    run: async (adapter) => {
      const { mine, scope } = await twoAuthors(adapter);

      const all = await mine.stats();
      assertEquals(countOf(all, "note"), 8, "unscoped sees both authors");

      const scoped = await mine.stats(scope);
      assertEquals(countOf(scoped, "note"), 3, "scoped counts ONLY my three — not 8, and not a trimmed 8");
      assertEquals(countOf(scoped, "secret"), 0, "a kind outside the scope contributes nothing");
      assert(!scoped.some((r) => r.kind === "secret"), "and does not appear at all, so the shape leaks nothing");
    },
  },
  {
    name: "the scope is applied before the cap, so a page is not silently short",
    run: async (adapter) => {
      const mine = new Space(adapter, { principal: "run:mine" });
      const theirs = new Space(adapter, { principal: "run:theirs" });
      for (const s of [mine, theirs]) s.registerKind({ kind: "note", indexedPaths: [] });
      // Their records are written FIRST, so they own the low ids: a limit applied before the
      // scope would fill the page with theirs and return nothing of mine.
      for (let i = 0; i < 20; i++) await theirs.put({ kind: "note", body: { i } });
      for (let i = 0; i < 4; i++) await mine.put({ kind: "note", body: { i } });

      const rows = await mine.queryEnvelopes({
        state: "available",
        limit: 5,
        scope: { createdBy: ["run:mine"] },
      });
      assertEquals(rows.length, 4, "all four of mine, none of theirs");
      assert(rows.every((r) => r.record?.runtimeMeta.createdBy === "run:mine"));
    },
  },
  {
    name: "a scoped diagnostics report is computed over the scope, component by component",
    run: async (adapter) => {
      const mine = new Space(adapter, { principal: "run:mine" });
      const theirs = new Space(adapter, { principal: "run:theirs" });
      for (const s of [mine, theirs]) s.registerKind({ kind: "note", indexedPaths: [] });
      for (let i = 0; i < 3; i++) await mine.put({ kind: "note", body: { i } });
      for (let i = 0; i < 7; i++) await theirs.put({ kind: "note", body: { i } });

      const full = await mine.diagnostics();
      const scoped = await mine.diagnostics({ createdBy: ["run:mine"], kinds: ["note"] });
      assertEquals(full.counts.available, 10, "the operator sees everything");
      assertEquals(scoped.counts.available, 3, "the scoped caller sees its own, counted — not filtered after");
    },
  },
  {
    name: "another agent's dead-lettered work never appears in my report",
    run: async (adapter) => {
      const mine = new Space(adapter, { principal: "run:mine" });
      const theirs = new Space(adapter, { principal: "run:theirs" });
      for (const s of [mine, theirs]) s.registerKind({ kind: "note", indexedPaths: [] });
      const { id } = await theirs.put({ kind: "note", body: {} });
      await theirs.forceDeadLetter(id);
      await mine.put({ kind: "note", body: {} });

      const scoped = await mine.diagnostics({ createdBy: ["run:mine"], kinds: ["note"] });
      assertEquals(scoped.deadLetter.count, 0, "their failure is not my failure");
      const full = await mine.diagnostics();
      assertEquals(full.deadLetter.count, 1, "…but it is real, and an operator sees it");
    },
  },
  {
    name: "ops access needs a grant that is BOTH self-scoped and a query grant",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "note", indexedPaths: [] });

      const denied = async (p: string) => {
        try {
          await space.opsScope(p);
          return false;
        } catch {
          return true;
        }
      };
      assert(await denied("agent:w"), "no grant at all: denied");

      // An ordinary query grant is not enough — it authorizes the coordination plane, not
      // introspection of the envelope.
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "note", operations: ["query"] } });
      assert(await denied("agent:w"), "a plain query grant does not open the ops plane");

      await space.put({
        kind: "grant",
        body: { principal: "agent:w", kind: "note", operations: ["query"], scope: { createdBy: "self" } },
      });
      const scope = await space.opsScope("agent:w");
      assertEquals(scope?.kinds, ["note"], "scoped to exactly the granted kind");
      assert(scope?.createdBy?.includes("agent:w"), "and to the caller's own records");
    },
  },
  {
    name: "a self-scoped grant narrows the COORDINATION plane, not only the ops plane",
    run: async (adapter) => {
      // The WRITER is configured as agent:w so its records carry that author; the CHECKER is a
      // separate Space, because a space treats its own configured identity as privileged — and a
      // privileged caller is unrestricted by definition.
      const mine = new Space(adapter, { principal: "agent:w" });
      const theirs = new Space(adapter, { principal: "run:someone-else" });
      const space = new Space(adapter);
      for (const sp of [mine, theirs, space]) sp.registerKind({ kind: "note", indexedPaths: [{ path: "n", type: "integer" }] });
      for (let i = 0; i < 3; i++) await mine.put({ kind: "note", body: { n: i } });
      for (let i = 0; i < 5; i++) await theirs.put({ kind: "note", body: { n: i } });

      await space.put({
        kind: "grant",
        body: { principal: "agent:w", kind: "note", operations: ["query", "read_one"], scope: { createdBy: "self" } },
      });

      // The bug this pins: the ops aggregate was scoped while `query` returned everything, so an
      // approval that promised "only its own records" handed over every record of the kind.
      const authors = await space.authorScope("agent:w", "query", "note");
      assert(authors, "a self-scoped grant yields an author restriction");
      const scoped = await space.query({ kind: "note" }, 100, undefined, { createdBy: authors });
      assertEquals(scoped.length, 3, "query sees only the caller's own records");
      assert(scoped.every((r) => r.runtimeMeta.createdBy === "agent:w"));
      assertEquals((await space.query({ kind: "note" }, 100)).length, 8, "unscoped still sees both authors");

      const one = await space.readOne({ kind: "note" }, { createdBy: authors });
      assertEquals(one?.runtimeMeta.createdBy, "agent:w", "read_one is narrowed the same way");
    },
  },
  {
    name: "an UNSCOPED grant on the same kind lifts the author restriction",
    run: async (adapter) => {
      const space = new Space(adapter); // not agent:w — a space's own identity is privileged
      space.registerKind({ kind: "note", indexedPaths: [] });
      await space.put({
        kind: "grant",
        body: { principal: "agent:w", kind: "note", operations: ["query"], scope: { createdBy: "self" } },
      });
      assert(await space.authorScope("agent:w", "query", "note"), "self-scoped alone: restricted");
      // A grant for a DIFFERENT operation is irrelevant to read scoping — narrowing reads while
      // keeping a write grant must not lift the restriction.
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "note", operations: ["put"] } });
      assert(await space.authorScope("agent:w", "query", "note"), "an unscoped PUT grant does not widen reads");

      // Grants UNION — a record is readable if any grant permits it — so one unscoped grant already
      // permits other authors, and filtering by author would deny something granted.
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "note", operations: ["query"] } });
      assertEquals(
        await space.authorScope("agent:w", "query", "note"),
        undefined,
        "mixed with an unscoped grant: no author restriction",
      );
    },
  },
  {
    name: "an operator has no scope at all, which is what unrestricted means",
    run: async (adapter) => {
      const space = new Space(adapter);
      assertEquals(await space.opsScope("human:local"), null, "null is unrestricted, not empty");
    },
  },
  {
    name: "revoking the self-scoped grant closes the ops plane again",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "note", indexedPaths: [] });
      const grant = { principal: "agent:w", kind: "note", operations: ["query"], scope: { createdBy: "self" } };
      await space.put({ kind: "grant", body: grant });
      assert(await space.opsScope("agent:w"));

      // Retirement is the same successor-record mechanism as any other registry entry.
      await space.put({ kind: "grant", body: { ...grant, retired: true } });
      let denied = false;
      try {
        await space.opsScope("agent:w");
      } catch {
        denied = true;
      }
      assert(denied, "a revoked self-scope closes the plane");
    },
  },
  {
    name: "an aggregate that covers less than the caller can read says so",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "message", indexedPaths: [{ path: "role", type: "keyword" }] });
      space.registerKind({ kind: "note", indexedPaths: [] });

      const { definitionToken } = await space.createAgentDefinition("agent:w", []);
      const { runToken } = await space.mintRun(definitionToken);
      const resolved = await space.resolveToken(runToken);
      const principal = resolved.ok && resolved.kind === "run" ? resolved.principal : "";

      for (let i = 0; i < 5; i++) await space.put({ kind: "message", body: { role: "user", i } });
      for (let i = 0; i < 2; i++) await space.put({ kind: "message", body: { role: "user", i } }, undefined, principal);
      for (let i = 0; i < 4; i++) await space.put({ kind: "note", body: { i } });
      await space.put({ kind: "note", body: { i: 99 } }, undefined, principal);

      // The state that produced a wrong number in a live session: an unscoped {put, query} grant
      // (written by the fleet's bootstrap) beside a self-scoped {query} one (a human narrowing it
      // once). Different operation sets means different grant identities, so BOTH are in force —
      // and the union rule says reads are therefore NOT narrowed.
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "message", operations: ["put", "query"] } });
      await space.put({
        kind: "grant",
        body: { principal: "agent:w", kind: "message", operations: ["query"], scope: { createdBy: "self" } },
      });
      // …and a kind where the self-scoped grant is the only one, which IS narrowed.
      await space.put({
        kind: "grant",
        body: { principal: "agent:w", kind: "note", operations: ["query"], scope: { createdBy: "self" } },
      });

      const scope = await space.opsScope(principal);
      const stats = await space.stats(scope ?? undefined);
      const count = (kind: string) => stats.filter((s) => s.kind === kind).reduce((n, s) => n + s.count, 0);

      // The ops plane is self-scoped BY DESIGN, so both counts are the caller's own records — that
      // part is deliberate and stays. What must not happen is the number quietly disagreeing with
      // the caller's own `query` on the same kind with nothing to signal it: reads on `message` are
      // NOT narrowed (an unscoped grant permits them), so the caller can list 7 while this counts
      // 2, and the scope has to say so.
      assertEquals(await space.authorScope(principal, "query", "message"), undefined, "reads on message are not narrowed");
      assertEquals(count("message"), 2, "the aggregate still covers only the caller's own records");
      assert((scope?.alsoReadable ?? []).includes("message"), "and the scope flags the kind it can read in full");

      assert(await space.authorScope(principal, "query", "note") !== undefined, "reads on note ARE narrowed");
      assertEquals(count("note"), 1, "own notes only");
      assert(!(scope?.alsoReadable ?? []).includes("note"), "a genuinely narrowed kind is not flagged");
    },
  },
  {
    name: "a kind the caller can list in full is reported, not silently widened",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "message", indexedPaths: [{ path: "role", type: "keyword" }] });
      const { definitionToken } = await space.createAgentDefinition("agent:w", []);
      const { runToken } = await space.mintRun(definitionToken);
      const resolved = await space.resolveToken(runToken);
      const principal = resolved.ok && resolved.kind === "run" ? resolved.principal : "";

      const { id: theirs } = await space.put({ kind: "message", body: { role: "user" } });
      // Unscoped {put, query} beside a self-scoped {query}: the plane is reachable (something is
      // self-scoped) and message reads are NOT narrowed (the union includes an unscoped grant).
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "message", operations: ["put", "query"] } });
      await space.put({
        kind: "grant",
        body: { principal: "agent:w", kind: "message", operations: ["query"], scope: { createdBy: "self" } },
      });

      const scope = await space.opsScope(principal);
      // The per-record ops reads stay self-scoped along with the aggregate — a caller that can LIST
      // another author's record still gets 404 for it here. That is the deliberate posture; what
      // the scope owes the caller is to say the two planes differ, not to quietly widen one.
      assert((scope?.alsoReadable ?? []).includes("message"), "the discrepancy is reported");
      assert(await space.getRecord(theirs), "the record exists and the caller can list it");
    },
  },
  {
    name: "a narrowed coordination read reports the constraint that narrowed it",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "message", indexedPaths: [{ path: "conversationId", type: "keyword" }] });
      const { definitionToken } = await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "message", operations: ["query"], template: { conversationId: "mine" } },
      ]);
      const { runToken } = await space.mintRun(definitionToken);
      const resolved = await space.resolveToken(runToken);
      const principal = resolved.ok && resolved.kind === "run" ? resolved.principal : "";

      for (let i = 0; i < 4; i++) await space.put({ kind: "message", body: { conversationId: "theirs", i } });
      await space.put({ kind: "message", body: { conversationId: "mine", i: 0 } });

      const ask = (p: string) =>
        handleQuery(
          space,
          new Request("http://t/v0/records/query", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind: "message", limit: 50 }),
          }),
          p,
        );

      // The whole point: a caller cannot tell a narrowed read from a complete one unless the answer
      // says so, and it will report its slice as the population. The ops plane always described its
      // scope; this is the plane records are actually read through.
      const scopedBody = await (await ask(principal)).json();
      assertEquals(scopedBody.records.length, 1, "only its own conversation");
      assertEquals(scopedBody.scope.narrowedBy, [{ conversationId: "mine" }]);
      assert(String(scopedBody.scope.note).includes("slice"), "and says what that means");

      // An unrestricted caller's answer is unchanged — no scope to explain away.
      const openBody = await (await ask("human:local")).json();
      assertEquals(openBody.records.length, 5);
      assertEquals(openBody.scope, undefined, "nothing narrowed, nothing reported");
    },
  },
];
