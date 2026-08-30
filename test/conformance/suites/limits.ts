// Resource limits (design-data-model §2), on every adapter.
//
// Each of these bounds a cost that BYTES do not. A pattern is stored and then evaluated against
// every candidate record, so its cost is paid per record rather than once; a body's depth and
// fan-out are walked by the matcher, the event chain and every reader, and 1 KiB of `[[[[…]]]]` is
// small and unbounded to all of them; an interest registry is read per candidate by the dry-run
// matcher and per kind by the starvation split, so its size is somebody else's cost.
//
// The rejections matter more than the acceptances: a limit nobody has seen refuse anything is a
// number in a constant.

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../../src/storage/adapter.ts";
import { Space } from "../../../src/core/space.ts";
import { RadiaError } from "../../../src/core/errors.ts";

function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter);
  space.registerKind({
    kind: "task",
    indexedPaths: [{ path: "op", type: "keyword" }, { path: "n", type: "integer" }, { path: "tags", type: "array" }],
  });
  return space;
}

/** The error code a call throws, or "" when it does not throw. */
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (e) {
    return e instanceof RadiaError ? e.code : `unexpected: ${(e as Error).message}`;
  }
}

export const limitSuites: Suite[] = [
  {
    // `kind_def` is uncompactable like the two below and gets NO ceiling, because neither shape
    // fits: a cap per kind NAME would not bound what `loadKinds` pays (that read is over the whole
    // kind), and a cap on the TOTAL would refuse declaring a new kind, which is the one thing here
    // that legitimately grows. The absorb is the whole fix, and it is enough because the growth has
    // exactly one source: `registerKind` is content-keyed, so a re-declaration dedupes for the
    // idempotency window and appends past it, and a fleet declaring its kinds on every start
    // appends one record per kind per start forever.
    name: "an identical re-declaration is absorbed, and a real schema change still writes",
    run: async (adapter) => {
      const space = new Space(adapter, { idempotencyRetentionSeconds: 0 });
      const def = (paths: { path: string; type: string }[]) => ({
        kind: "kind_def",
        body: { kind: "memo", indexedPaths: paths, claimable: false },
      });

      // A fleet restarting past the idempotency window, in fast motion.
      for (let i = 0; i < 25; i++) await space.put(def([{ path: "tag", type: "keyword" }]));
      assertEquals(
        (await space.query({ kind: "kind_def", match: { kind: "memo" } }, 100)).length,
        1,
        "25 identical declarations are one record",
      );

      // A REAL change still writes, which is what keeps the declaration history this kind is
      // excluded from compaction for.
      await space.put(def([{ path: "tag", type: "keyword" }, { path: "seq", type: "integer" }]));
      const rows = await space.query({ kind: "kind_def", match: { kind: "memo" } }, 100, { dir: "desc" });
      assertEquals(rows.length, 2, "a changed declaration is a successor, not an absorbed duplicate");
      // And it is the one in force: the newest declaration wins.
      assertEquals((rows[0].body as { indexedPaths: unknown[] }).indexedPaths.length, 2);
      await space.put({ kind: "memo", body: { tag: "t", seq: 1 } });
      assertEquals((await space.query({ kind: "memo", match: { seq: 1 } }, 5)).length, 1, "the new path matches");

      // Declaring a DIFFERENT kind is never refused: there is no ceiling on variety.
      for (let i = 0; i < 30; i++) {
        await space.put({ kind: "kind_def", body: { kind: `k${i}`, indexedPaths: [], claimable: false } });
      }
      assert((await space.query({ kind: "kind_def" }, 200)).length >= 31);
    },
  },
  {
    // The SAME rule on the registry the OPS-PLANE GATE reads. `Space.opsPowers` walks a principal's
    // whole `ops_grant` history on every `/v0/ops/*` request and the kind is never compacted, so an
    // unbounded history is a permanent tax on every ops call. A registry is either compactable or
    // capped, never neither (agent_docs/plan-bounded-reads.md).
    //
    // What reaches it is assigning powers ON A SCHEDULE, which a shipped example does:
    // `examples/analysis/run.ts` calls `grantObserve` for every enrolled principal on every launch.
    name: "a principal's ops-power HISTORY is capped, because the ops gate re-reads it",
    run: async (adapter) => {
      const space = new Space(adapter, { maxOpsGrantRecordsPerPrincipal: 8, idempotencyRetentionSeconds: 0 });
      const power = (ops: string[]) => ({ kind: "ops_grant", body: { principal: "human:ops", operations: ops } });

      // A launcher republishing the same power, past the idempotency window: the analysis example's
      // shape in fast motion. It must keep working AND must not grow the history AT ALL. Content
      // keying dedupes for the window and not past it, so before the absorb this appended a record
      // per launch forever, on a kind nothing can sweep.
      for (let i = 0; i < 30; i++) await space.put(power(["observe"]));
      const kept = await space.query({ kind: "ops_grant", match: { principal: "human:ops" } }, 100);
      assertEquals(kept.length, 1, "an identical re-put is answered with the record already carrying the power");
      // And the power is still in force, which is the postcondition that must hold.
      assert((await space.opsPowers("human:ops")).has("observe"));

      // A WITHDRAWAL is never refused: it is how a caller reduces what the reader projects. Checked
      // here, while `["observe"]` is the only identity holding that power, or a later identity
      // carrying it would mask the retirement and this would pass for the wrong reason.
      await space.put({ kind: "ops_grant", body: { principal: "human:ops", operations: ["observe"], retired: true } });
      assert(!(await space.opsPowers("human:ops")).has("observe"), "and it takes effect");

      // A NEW identity is refused once the ceiling is REACHED, which now takes distinct identities
      // rather than repetition: the absorb means repetition never gets there. An identity is
      // (principal, sorted operations) over a closed five-power vocabulary, so this walks distinct
      // subsets until the ceiling of 8 is met.
      // Two records exist already (the grant and its retirement), so six more distinct identities
      // meet the ceiling of 8 and the seventh is refused.
      const subsets = [["sweep"], ["purge"], ["declassify"], ["remediate"], ["sweep", "purge"], ["sweep", "declassify"]];
      for (const ops of subsets) await space.put(power(ops));
      assertEquals((await space.query({ kind: "ops_grant", match: { principal: "human:ops" } }, 100)).length, 8);
      const e = await assertRejects(() => space.put(power(["declassify", "remediate"])), RadiaError);
      assertEquals((e as RadiaError).code, "too_many_ops_grants");

      // Another principal is unaffected: the ceiling is per principal, the granularity the
      // expensive read uses.
      await space.put({ kind: "ops_grant", body: { principal: "human:other", operations: ["observe"] } });
      assert((await space.opsPowers("human:other")).has("observe"));
    },
  },
  {
    // `Space.access` re-reads a (principal, kind)'s whole grant history on EVERY authorized
    // request, and `GRANT` is in NEVER_COMPACT so nothing sweeps it: measured, `authorize()` goes
    // from 1.72ms at one record to 93.57ms at 5,000 on Postgres. The ceiling refuses the write that
    // would make the hot path slower, at the site of the bug (a fleet republishing grants), rather
    // than degrading the space forever. See agent_docs/plan-registry-cost.md.
    name: "a principal's grant HISTORY is capped per kind, because every authorize re-reads it",
    run: async (adapter) => {
      const space = new Space(adapter, { maxGrantRecordsPerPrincipalKind: 8 });
      space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
      const write = (i: number) =>
        space.put({
          kind: "grant",
          body: { principal: "agent:w", kind: "task", operations: ["put"], pattern: { tag: `t${i}` } },
        });
      for (let i = 0; i < 8; i++) await write(i);

      const e = await assertRejects(() => write(99), RadiaError);
      assertEquals((e as RadiaError).code, "too_many_grants");

      // A WITHDRAWAL is always allowed: it is how a caller shrinks what the reader projects, and
      // refusing it would trap exactly the state the ceiling exists to prevent.
      await space.put({
        kind: "grant",
        body: { principal: "agent:w", kind: "task", operations: ["put"], pattern: { tag: "t0" }, retired: true },
      });

      // A re-put of a LIVE identity must keep working (a fleet at the ceiling has to restart) and
      // must NOT grow the history. Content-keying dedupes only inside the idempotency window, so
      // this exercises the case past it, which is a weekly-restarting fleet in fast motion: the
      // first version of this ceiling exempted such a re-put and 40 of them sailed past a ceiling
      // of 10, leaving it unable to bound the very case it was built for.
      {
        const past = new Space(adapter, { maxGrantRecordsPerPrincipalKind: 8, idempotencyRetentionSeconds: 0 });
        past.registerKind({ kind: "note", indexedPaths: [] });
        const body = { principal: "agent:r", kind: "note", operations: ["put"] };
        for (let i = 0; i < 30; i++) await past.put({ kind: "grant", body });
        const kept = await past.query({ kind: "grant", match: { principal: "agent:r", kind: "note" } }, 100);
        assertEquals(kept.length, 1, "an identical re-put never grows the history, ceiling or not");
        await past.authorize("agent:r", "put", "note"); // and the grant is still in force
      }
      // A ceiling must never block a write that REDUCES authority. `grantKey` excludes `scope`, so
      // a narrowing carries the SAME identity with a different body; absorbing it on identity alone
      // dropped it silently and left the wider grant standing, and refusing it would trap a
      // maxed-out pair as un-tightenable. It is a replacement, so it writes.
      {
        const tight = new Space(adapter, { maxGrantRecordsPerPrincipalKind: 4, idempotencyRetentionSeconds: 0 });
        tight.registerKind({ kind: "memo", indexedPaths: [] });
        const base = { principal: "agent:n", kind: "memo", operations: ["query"] };
        for (let i = 0; i < 6; i++) await tight.put({ kind: "grant", body: base });
        await tight.put({ kind: "grant", body: { ...base, scope: { createdBy: "self" } } });
        const perms = await tight.effectivePermissions("agent:n") as { kinds: { kind: string; readsScopedToSelf?: boolean }[] };
        assertEquals(
          perms.kinds.find((k) => k.kind === "memo")?.readsScopedToSelf,
          true,
          "narrowing at the ceiling must take effect, not be absorbed as a duplicate",
        );
      }
      await write(1);

      // Another principal is unaffected, and so is another kind: the ceiling is per pair, which is
      // the granularity the expensive read uses.
      await space.put({ kind: "grant", body: { principal: "agent:other", kind: "task", operations: ["put"] } });
      space.registerKind({ kind: "job", indexedPaths: [] });
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "job", operations: ["put"] } });

      // And the grant that was refused never landed.
      const rows = await space.query({ kind: "grant", match: { principal: "agent:w", kind: "task" } }, 100);
      assert(!rows.some((r) => (r.body as { pattern?: { tag?: string } }).pattern?.tag === "t99"));
    },
  },
  {
    name: "a pattern too large to evaluate cheaply is refused",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const huge = { op: { $in: [] as string[] } };
      // Under the value cap but over the byte cap: the two limits catch different shapes, and a
      // pattern can be small in count and enormous in size.
      huge.op.$in = Array.from({ length: 200 }, (_, i) => `${"x".repeat(64)}${i}`);
      assertEquals(await codeOf(() => space.query({ kind: "task", match: huge })), "pattern_too_large");

      // The ordinary pattern beside it still compiles: a limit that refuses normal work is a bug.
      assertEquals(await codeOf(() => space.query({ kind: "task", match: { op: "upper" } })), "");
    },
  },
  {
    name: "a flat pattern with thousands of predicates is refused, though its DEPTH is 1",
    run: async (adapter) => {
      // Depth alone does not bound evaluation cost, which is the reason this limit exists beside
      // the nesting one: every branch here is a comparison run per candidate record.
      const space = newSpace(adapter);
      const wide = { $or: Array.from({ length: 40 }, (_, i) => ({ n: i })) };
      assertEquals(await codeOf(() => space.query({ kind: "task", match: wide })), "too_many_branches");

      const nested = {
        $and: [{ $or: Array.from({ length: 12 }, (_, i) => ({ n: i })) }, { $or: Array.from({ length: 12 }, (_, i) => ({ n: i + 100 })) }],
      };
      // Each $or is under the branch cap; together they are over the predicate cap. The two limits
      // are not the same limit spelled twice.
      assertEquals(await codeOf(() => space.query({ kind: "task", match: nested })), "");
      const deeper = {
        $and: [
          { $or: Array.from({ length: 16 }, (_, i) => ({ n: i })) },
          { $or: Array.from({ length: 16 }, (_, i) => ({ n: i + 100 })) },
          { $or: Array.from({ length: 16 }, (_, i) => ({ n: i + 200 })) },
          { $or: Array.from({ length: 16 }, (_, i) => ({ n: i + 300 })) },
        ],
      };
      assertEquals(await codeOf(() => space.query({ kind: "task", match: deeper })), "too_many_predicates");
    },
  },
  {
    name: "an oversized $in is refused",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const many = { op: { $in: Array.from({ length: 500 }, (_, i) => `v${i}`) } };
      assertEquals(await codeOf(() => space.query({ kind: "task", match: many })), "too_many_values");
    },
  },
  {
    name: "a body nested deeper than the limit is refused, and the check does not itself recurse",
    run: async (adapter) => {
      // The guard has to survive the input it exists to reject. A recursive checker overflows the
      // stack on a deeply nested body, which is the bug rather than the defence, so this builds one
      // far past the limit and expects an ERROR rather than a crash.
      const space = newSpace(adapter);
      let deep: unknown = "bottom";
      for (let i = 0; i < 5000; i++) deep = { next: deep };
      assertEquals(await codeOf(() => space.put({ kind: "task", body: { op: "x", deep } })), "body_too_deep");

      // Ordinary nesting is untouched.
      assertEquals(await codeOf(() => space.put({ kind: "task", body: { op: "x", a: { b: { c: 1 } } } })), "");
    },
  },
  {
    name: "an oversized array in a body is refused wherever it sits",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const long = Array.from({ length: 5000 }, (_, i) => i);
      assertEquals(await codeOf(() => space.put({ kind: "task", body: { op: "x", tags: long } })), "array_too_long");
      // Nested inside an object, not just at the top: the walk covers the whole shape.
      assertEquals(await codeOf(() => space.put({ kind: "task", body: { op: "x", a: { b: long } } })), "array_too_long");
    },
  },
  {
    name: "a principal cannot register unbounded interests, and re-publishing is always allowed",
    run: async (adapter) => {
      const space = new Space(adapter, { maxInterestsPerPrincipal: 3 });
      space.registerKind({ kind: "task", indexedPaths: [{ path: "op", type: "keyword" }] });
      const { definitionToken } = await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "interest", operations: ["put", "query"] },
        { principal: "agent:w", kind: "task", operations: ["take"] },
      ]);
      const { run } = await space.mintRun(definitionToken);

      for (let i = 0; i < 3; i++) {
        await space.put({ kind: "interest", body: { kind: "task", match: { op: `op${i}` } } }, undefined, { author: run });
      }
      assertEquals(
        await codeOf(() => space.put({ kind: "interest", body: { kind: "task", match: { op: "op9" } } }, undefined, { author: run })),
        "too_many_interests",
      );

      // A restart republishes what it already declared. Refusing that would leave a worker at the
      // ceiling unable to come back, which is a worse failure than the one being prevented.
      assertEquals(
        await codeOf(() => space.put({ kind: "interest", body: { kind: "task", match: { op: "op0" } } }, undefined, { author: run })),
        "",
      );
      // And a withdrawal is never refused, or the ceiling would be a trap with no way down.
      assertEquals(
        await codeOf(() =>
          space.put({ kind: "interest", body: { kind: "task", match: { op: "op9" }, retired: true } }, undefined, { author: run })
        ),
        "",
      );

      // The budget is per principal, not global: another worker is unaffected.
      const { definitionToken: other } = await space.createAgentDefinition("agent:b", [
        { principal: "agent:b", kind: "interest", operations: ["put", "query"] },
      ]);
      const { run: otherRun } = await space.mintRun(other);
      assertEquals(
        await codeOf(() => space.put({ kind: "interest", body: { kind: "task", match: { op: "x" } } }, undefined, { author: otherRun })),
        "",
      );
    },
  },
  {
    name: "the limits are enforced in the RUNTIME, not only at the HTTP boundary",
    run: async (adapter) => {
      // Every one of these calls is in-process: the SDK, the MCP adapter, the examples and the
      // runtime itself never pass through a handler, and a limit that lives in a handler is a limit
      // half the callers do not have. Same reason `compilePattern` validates its own input.
      const space = newSpace(adapter);
      let deep: unknown = 1;
      for (let i = 0; i < 100; i++) deep = [deep];
      const codes = [
        await codeOf(() => space.put({ kind: "task", body: { op: "x", deep } })),
        await codeOf(() => space.query({ kind: "task", match: { op: { $in: Array.from({ length: 300 }, (_, i) => `${i}`) } } })),
      ];
      assert(codes.every((c) => c !== ""), `a limit was not enforced in-process: ${JSON.stringify(codes)}`);
    },
  },
  {
    // The measured shape (`bench/deployment.ts`): an unpushable pattern pulls the whole kind through
    // the oracle, 13.6s at a million records in a single-threaded process, so one principal's
    // pattern is everyone else's outage. The budget bounds the rows one read may EXAMINE. It fires
    // on candidates, never on results, which is what keeps it invisible to a pattern SQL can decide.
    name: "a scan budget bounds what one read may push through the oracle",
    run: async (adapter) => {
      // The budget is under the kind's size and over the claim window, so both paths have to page
      // more than once to reach it: a budget below one window would prove only that the first fetch
      // overshot.
      const space = new Space(adapter, { maxScanRows: 150 });
      space.registerKind({
        kind: "task",
        indexedPaths: [{ path: "op", type: "keyword" }, { path: "n", type: "integer" }, { path: "tags", type: "array" }],
      });
      for (let i = 0; i < 400; i++) {
        await space.put({ kind: "task", body: { op: i === 399 ? "rare" : "common", n: i, tags: [`t${i % 5}`] } });
      }

      // `$each` is not pushable (`pushdown.ts`), so every record of the kind reaches `matchesRecord`,
      // and nothing satisfies this one, so nothing stops the walk before the budget does. That
      // combination — undecidable in SQL, and few or no matches — is the whole shape of the problem:
      // it is exactly what the deployment benchmark measured at 13.6s.
      assertEquals(await codeOf(() => space.query({ kind: "task", match: { tags: { $each: "zz" } } }, 10)), "scan_budget_exceeded");
      assertEquals(await codeOf(() => space.readOne({ kind: "task", match: { tags: { $each: "zz" } } })), "scan_budget_exceeded");
      // A claim pages in windows instead of fetching the kind, and pays the same cost for the same
      // reason: each window is a window of the queue, not of the matches.
      assertEquals(
        await codeOf(() => space.take({ pattern: { kind: "task", match: { tags: { $each: "zz" } } } })),
        "scan_budget_exceeded",
      );

      // Every pushable predicate is decided in SQL, so it returns matches rather than candidates and
      // cannot reach the budget however large the kind grows. This is the line the whole design
      // rests on: the limit is invisible to patterns the database can answer.
      assertEquals(await codeOf(() => space.query({ kind: "task", match: { op: "rare" } }, 10)), "");
      assertEquals(await codeOf(() => space.query({ kind: "task", match: { n: { $gte: 0 } } }, 10)), "");
      assertEquals(await codeOf(() => space.query({ kind: "task", match: { tags: { $any: "t3" } } }, 10)), "");
      assertEquals(await codeOf(() => space.take({ pattern: { kind: "task", match: { op: "rare" } } })), "");

      // And an inexact scan that finds what it needs early stops there rather than walking the kind,
      // so the budget is a bound on WORK and not a cap on how large a kind may be while an
      // unpushable pattern is in use. Matches are dense here, so the first chunk satisfies the limit.
      const hits = await space.query({ kind: "task", match: { tags: { $each: { $in: ["t0", "t1", "t2", "t3", "t4"] } } } }, 5);
      assertEquals(hits.length, 5);
    },
  },
  {
    // An unbudgeted scan is also an unbounded ALLOCATION: both adapters used to materialise every
    // row of the kind before the oracle saw the first one. The chunked walk is what makes the
    // budget enforceable partway rather than after the damage, and this pins its two edges, since
    // an off-by-one at the chunk boundary is invisible in the common case.
    name: "the chunked scan agrees with the whole-kind scan at every boundary",
    run: async (adapter) => {
      const space = new Space(adapter, { maxScanRows: 100_000 });
      space.registerKind({
        kind: "task",
        indexedPaths: [{ path: "n", type: "integer" }, { path: "tags", type: "array" }],
        sortablePaths: ["n"],
      });
      const ids: string[] = [];
      for (let i = 0; i < 2500; i++) { // more than two chunks, and not a multiple of one
        ids.push((await space.put({ kind: "task", body: { n: i, tags: i % 250 === 0 ? ["hit"] : ["miss"] } })).id);
      }
      const sorted = [...ids].sort();
      const each = { tags: { $each: "hit" } };

      const all = await space.query({ kind: "task", match: each }, 100);
      assertEquals(all.length, 10, "every match across the chunk boundaries, none twice");
      assertEquals(all.map((r) => r.id), all.map((r) => r.id).sort(), "in id order, the oracle tie-break");

      // A limit smaller than the match count stops the walk early, and must still return the FIRST
      // matches rather than whichever chunk happened to be in hand.
      assertEquals((await space.query({ kind: "task", match: each }, 3)).map((r) => r.id), all.slice(0, 3).map((r) => r.id));
      assertEquals((await space.readOne({ kind: "task", match: each }))?.id, all[0].id);

      // A cursor into the middle resumes the walk rather than restarting it.
      const after = await space.query({ kind: "task", match: each }, 100, { after: all[4].id });
      assertEquals(after.map((r) => r.id), all.slice(5).map((r) => r.id));

      // Descending, where the chunk cursor has to walk the other way.
      const desc = await space.query({ kind: "task", match: each }, 100, { dir: "desc" });
      assertEquals(desc.map((r) => r.id), [...all].reverse().map((r) => r.id));

      // An order_by cannot stop early (the sort needs every match), so it exercises the full walk.
      const ordered = await space.query({ kind: "task", match: each, orderBy: [{ path: "n", dir: "desc" }] }, 100);
      assertEquals((ordered[0].body as { n: number }).n, 2250);
      assertEquals(ordered.length, 10);
      assertEquals(sorted.length, 2500);
    },
  },
  {
    name: "an ack result is a write, so it meets the registry ceilings a put does",
    run: async (adapter) => {
      // A SECOND WRITE PATH that grew after the first learned a rule, which is the class
      // `validateReservedBody` names. The budgets live in `putRaw`; an ack result is built in
      // `settle` and written by the adapter, so it reached none of them. Measured before the fix:
      // a cap of 3, six interests emitted as ack results, ZERO refused and nine entries standing.
      const space = new Space(adapter, { maxInterestsPerPrincipal: 3 });
      space.registerKind({ kind: "job", indexedPaths: [{ path: "n", type: "integer" }] });
      let refused = 0;
      for (let i = 0; i < 6; i++) {
        await space.put({ kind: "job", body: { n: i } });
        const t = await space.take({ pattern: { kind: "job", match: { n: i } } });
        assert(t);
        try {
          await space.ack(t!.lease, { kind: "interest", body: { kind: "job", match: { n: i } } });
        } catch {
          refused++;
        }
      }
      assertEquals(refused, 3, "the cap must bind on the ack path too");
      assertEquals((await space.query({ kind: "interest" }, 100)).length, 3);
    },
  },
];
