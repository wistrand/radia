// Fault matrix, the CONTENDED half: the cases that only exist when claims race across connections.
//
// `plan-validation.md` lists eleven fault cases; five are in `suites/faults.ts` and run everywhere,
// because a crash is expressible on one connection (take a lease, never ack, force it expired). The
// two here are not. They are properties of the claim path under CONCURRENCY, so the embedded
// adapters — PGlite single-connection, SQLite single-writer — cannot express them at all, and both
// were shipped by audit package S as code with no test that fails. This is that test.
//
// Skipped unless RADIA_PG_URL points at a real server, exactly as the `postgres` adapter row is.
// CI sets it in the `postgres` job (`.github/workflows/ci.yml`).
//
// Probabilistic, deliberately, and bounded: the interleaving cannot be forced without a hook inside
// the adapter's transaction, and a test-only hook in the claim path is a worse trade than a loop
// that runs the real thing many times. Each case is written so the ASSERTION is exact even though
// the schedule is not: a violation is a state that cannot occur under the fix, never a timing
// measurement. Both were then run against the pre-fix adapter planted back in, which is the only
// evidence that a guard guards anything — the backoff case failed on every planted run, the paging
// case on six of seven. Neither has failed on the fixed code.

import { assert, assertEquals } from "@std/assert";
import { PostgresAdapter } from "../src/storage/postgres.ts";
import { Space } from "../src/core/space.ts";
import { newUlid } from "../src/core/ids.ts";

const PG_URL = Deno.env.get("RADIA_PG_URL");
const needsPg = { ignore: !PG_URL };

/** A space on its own ephemeral schema, over a pool wide enough that claimers genuinely race. */
async function pgSpace(claimers: number) {
  const adapter = new PostgresAdapter(PG_URL!, {
    schema: `radia_conc_${newUlid()}`,
    ephemeral: true,
    poolSize: claimers + 2,
  });
  await adapter.init();
  const space = new Space(adapter);
  space.registerKind({
    kind: "task",
    indexedPaths: [{ path: "tag", type: "keyword" }, { path: "tags", type: "array" }],
  });
  return { space, close: () => adapter.close() };
}

Deno.test({
  name: "concurrency: a claim never lands inside another worker's nack backoff",
  ...needsPg,
  fn: async () => {
    // The race package S fixed: the available-branch CAS guarded only `state='available'`, so
    // between one claimer's candidate read and its update, another could take the record, nack it
    // with a backoff, and leave it available again — with a FUTURE `available_at` and a bumped
    // epoch. The first claimer's update matched anyway.
    //
    // The detector needs no timing: a claim does not rewrite `available_at`, so a record claimed
    // inside its backoff is observable afterwards as `state='leased'` with `available_at` in the
    // future. That state is impossible under the guard and was reachable without it.
    const CLAIMERS = 6;
    const ROUNDS = 40;
    const { space, close } = await pgSpace(CLAIMERS);
    try {
      for (let i = 0; i < 12; i++) await space.put({ kind: "task", body: { tag: "t" } });

      const violations: string[] = [];
      const claimer = async (who: number) => {
        for (let round = 0; round < ROUNDS; round++) {
          const claimed = await space.take({ pattern: { kind: "task" } }, { leaseSeconds: 30 }, `run:c${who}`);
          if (!claimed) continue;
          const env = await space.getEnvelope(claimed.record.id);
          const now = await space.now(); // the DB clock, the only one a claim is judged against
          if (env && env.availableAt > now) {
            violations.push(`${claimed.record.id} claimed at ${now} but available_at=${env.availableAt}`);
          }
          // Back into the queue behind a long backoff, which is what makes the window exist.
          await space.nack(claimed.lease, { backoffSeconds: 30 }, undefined, `run:c${who}`);
        }
      };
      await Promise.all(Array.from({ length: CLAIMERS }, (_, i) => claimer(i)));
      assertEquals(violations, [], "a record was claimed while its backoff had not elapsed");
    } finally {
      await close();
    }
  },
});

Deno.test({
  name: "concurrency: a claim never steps over a record in a shifting candidate window",
  ...needsPg,
  fn: async () => {
    // The other race package S fixed: candidate windows paged by OFFSET. The rows before the cursor
    // are exactly the ones other claimers are removing, so each departure shifted the rest forward
    // and the next window stepped over them — `take` answering "nothing claimable" over a kind that
    // still held work.
    //
    // FOUR things have to line up for that to be observable, and the first draft of this test had
    // none of them, so it passed against the pre-fix adapter and proved nothing:
    //
    //   1. The pattern must NOT be pushable. A pushed predicate filters the window in SQL, so a
    //      selective take sees a window of pure matches and never pages — `{tag: "rare"}` was one
    //      query, no boundary, no bug. `$any` is not pushed (`pushdown.ts`, "quant"), so the window
    //      is the head of the QUEUE and the ranker rejects most of it, which forces the paging.
    //   2. Rows must be LEAVING the prefix while a claimer pages it, so a second population eats
    //      the noise concurrently. An offset counts positions in a set shrinking underneath it.
    //   3. The matches must sit in the MIDDLE. Removals shift later rows toward the front, so
    //      matches parked at the tail move *into* the claimer's next window instead of past it,
    //      which is why the first draft's geometry could not fail. Behind a prefix that is being
    //      eaten, they cross the boundary the claimer has already stepped over.
    //   4. Exactly ONE claimer competes for the matches, which is what makes the detector EXACT
    //      rather than statistical. A single claimer must receive the matches in claim order
    //      (`CLAIM_ORDER`: equal priority, so ascending id), because the earliest window holding a
    //      claimable record wins. So a take that returns a LATER match while an earlier one is
    //      still available proves the scan stepped over it — unreachable under the fix, and one
    //      trial per take instead of the single trial an "empty queue" assertion would give. With
    //      several match-claimers neither signal is decisive: another may hold the earlier one.
    const EATERS = 8;
    const HEAD = 2000; // CANDIDATE_WINDOW is 64, so every take pages ~31 windows while rows leave
    const TAIL = 200;
    const MATCHES = 20;
    const { space, close } = await pgSpace(EATERS + 2);
    const noiseBody = { tags: ["noise"] };
    // Setup is the slow part; put concurrently, in groups, so the id ORDER between groups still
    // holds (a group is awaited to completion before the next is minted).
    const putMany = async (n: number) => {
      for (let i = 0; i < n; i += 50) {
        const size = Math.min(50, n - i);
        await Promise.all(
          Array.from({ length: size }, () => space.put({ kind: "task", body: noiseBody })),
        );
      }
    };
    try {
      await putMany(HEAD);
      const wanted = new Set<string>();
      for (let i = 0; i < MATCHES; i++) {
        wanted.add((await space.put({ kind: "task", body: { tags: ["rare"] } })).id);
      }
      await putMany(TAIL);

      let stop = false;
      const eat = async (who: string) => {
        while (!stop) {
          const got = await space.take(
            { pattern: { kind: "task", match: { tags: { $any: "noise" } } } },
            { leaseSeconds: 60 },
            who,
          );
          if (!got) return;
          await space.ack(got.lease, undefined, undefined, who);
        }
      };
      const eaters = Array.from({ length: EATERS }, (_, i) => eat(`run:noise${i}`).catch(() => {}));

      const expected = [...wanted].sort();
      const served: string[] = [];
      try {
        while (served.length < MATCHES) {
          const got = await space.take(
            { pattern: { kind: "task", match: { tags: { $any: "rare" } } } },
            { leaseSeconds: 60 },
            "run:rare",
          );
          if (!got) break; // the queue looks empty; the unserved remainder says otherwise
          served.push(got.record.id);
          await space.ack(got.lease, undefined, undefined, "run:rare");
        }
      } finally {
        stop = true;
        await Promise.all(eaters);
      }

      // One assertion covers both failures: a skipped record shows up as an order break, and one
      // never reached shows up as a short list.
      assertEquals(served, expected, "a claim stepped over an available record, or missed it");
    } finally {
      await close();
    }
  },
});
