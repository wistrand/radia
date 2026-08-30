// Ephemeral liveness (`extensions/ts/presence.ts`).
//
//   deno task test:extensions
//
// Two things here can be wrong in ways nothing else would catch. The READ is bounded by relevance
// rather than page size, which is the shape a bounded read mistaken for a population always wears
// (agent_docs/plan-bounded-reads.md), so the walk is tested against a target sitting behind a full
// page of fresher records. And the WITHDRAWAL decision it feeds must fail toward stale-visible:
// a wrongly withdrawn advertisement makes a working tool invisible until its definition changes.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { RadiaClient } from "../../sdk/ts/client.ts";
import {
  announcePresence,
  livePresence,
  MIN_BEATS_PER_TTL,
  type PresenceBody,
  presenceKind,
  presenceSpec,
  retireIfLast,
} from "../ts/presence.ts";
import { bootSpace, uniq } from "./space.ts";

const PORT = 7845;
const KIND = "presence_test";

// The KIND is registered once, with a comfortable retention (4x fifteen minutes). Read-side specs
// below shorten only the TTL, which is a reader's parameter: registering a two-second retention
// would let the amortized sweep delete a test's records underneath it.
const shared = await bootSpace(PORT);
const spec = presenceSpec(KIND);
await shared.registerKind(presenceKind(spec));

/** A beat written directly, so a read-side test needs no timer and no sleep it did not ask for. */
const beat = (c: RadiaClient, subject: string, instance: string, retired?: true) =>
  c.put(
    { kind: KIND, body: { subject, instance, ...(retired ? { retired } : {}) } satisfies PresenceBody },
    `presence:${KIND}:${subject}:${instance}:${retired ? "retired" : crypto.randomUUID()}`,
  );

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One live instance hidden behind a FULL PAGE of fresher TOMBSTONES, built once and shared.
 *
 * The shape a long-running fleet actually reaches: many instances have come and gone, one is still
 * serving, and its beat is the oldest record of the three hundred. Every property that can only
 * fail on a truncated read needs it, and the tombstones are what make truncation LOOK like an
 * empty world instead of merely a shorter list.
 */
const hidden = (() => {
  let built: Promise<{ subject: string; target: string }> | undefined;
  return () =>
    built ??= (async () => {
      const subject = uniq("svc"), target = uniq("i");
      await beat(shared, subject, target); // first, so it is deepest
      const departed = Array.from({ length: 250 }, () => uniq("i"));
      for (let i = 0; i < departed.length; i += 25) {
        await Promise.all(departed.slice(i, i + 25).map((inst) => beat(shared, subject, inst, true)));
      }
      return { subject, target };
    })();
})();

Deno.test("[presence] a fresh beat is live, a silent instance ages out, a retirement is immediate", async () => {
  const subject = uniq("svc"), quiet = uniq("i"), loud = uniq("i"), gone = uniq("i");
  const short = presenceSpec(KIND, { ttlMs: 400, refreshMs: 100 });

  await beat(shared, subject, quiet);
  await beat(shared, subject, gone);
  await beat(shared, subject, gone, true);
  await sleep(500);
  await beat(shared, subject, loud);

  const view = await livePresence(shared, short, { subject });
  assert(view.complete, "the walk reached the TTL horizon");
  assertEquals([...(view.live.get(subject) ?? [])], [loud], "only the instance that beat inside the TTL");

  // The same records under a TTL that covers them all: silence is the only thing that killed it.
  const wide = await livePresence(shared, presenceSpec(KIND), { subject });
  assertEquals([...(wide.live.get(subject) ?? [])].sort(), [loud, quiet].sort(), "the quiet one was not deleted, just old");
  assert(!(wide.live.get(subject) ?? new Set()).has(gone), "a retirement is dead however fresh it is");
});

Deno.test("[presence] a repeat inside one refresh window writes no new record", async () => {
  const subject = uniq("svc");
  let clock = 1_000_000_000_000;
  const handle = await announcePresence(shared, spec, subject, { instance: uniq("i"), now: () => clock });
  try {
    await handle.beat();
    await handle.beat();
    assertEquals(
      (await shared.queryAll({ kind: KIND, match: { subject } })).length,
      1,
      "three beats in one window are one record",
    );

    clock += spec.refreshMs;
    await handle.beat();
    assertEquals(
      (await shared.queryAll({ kind: KIND, match: { subject } })).length,
      2,
      "the next window appends",
    );
  } finally {
    await handle.retire();
  }
});

Deno.test("[presence] the walk is bounded by relevance, not by page size", async () => {
  // A walk that stopped at one page would report the target dead while it is beating; the horizon
  // is the only stopping rule.
  const { subject, target } = await hidden();

  const view = await livePresence(shared, spec, { subject });
  assert(view.complete, "the kind was exhausted rather than truncated");
  assert(view.scanned > 200, `the walk paged past the first page (scanned ${view.scanned})`);
  assertEquals([...(view.live.get(subject) ?? [])], [target], "an instance behind a full page of tombstones is still live");
});

Deno.test("[presence] the scan ceiling reports rather than answering a prefix", async () => {
  const { subject } = await hidden();

  const view = await livePresence(shared, spec, { subject, maxScan: 1 });
  assertEquals(view.complete, false, "a walk stopped by the ceiling says so");
  assertEquals(view.live.get(subject), undefined, "the prefix is all tombstones, so it looks like nobody is serving");
});

Deno.test("[presence] a refresh that does not fit three times in the TTL is refused", () => {
  assertThrows(
    () => presenceSpec(KIND, { ttlMs: 300, refreshMs: 200 }),
    Error,
    "at most a third",
  );
  // The boundary is allowed: exactly MIN_BEATS_PER_TTL beats inside the TTL.
  const ok = presenceSpec(KIND, { ttlMs: 300, refreshMs: 300 / MIN_BEATS_PER_TTL });
  assertEquals(ok.refreshMs, 100);
  assertEquals(presenceSpec(KIND, { ttlMs: 900 }).refreshMs, 300, "the default refresh is the TTL over three");
  assertThrows(() => presenceSpec(KIND, { ttlMs: 0 }), Error, "positive");
});

Deno.test("[presence] the withdrawal runs for the last instance out, and never for the others", async () => {
  const subject = uniq("svc"), first = uniq("i"), second = uniq("i");
  await beat(shared, subject, first);
  await beat(shared, subject, second);

  let withdrawals = 0;
  const withdraw = () => {
    withdrawals++;
    return Promise.resolve();
  };

  const leaving = await retireIfLast(shared, spec, { subject, instance: first }, withdraw);
  assertEquals(leaving.withdrew, false);
  assertEquals([...leaving.others], [second], "the decline NAMES who is still serving");
  assertEquals(withdrawals, 0, "a fleet leaving while another serves withdraws nothing");

  const last = await retireIfLast(shared, spec, { subject, instance: second }, withdraw);
  assertEquals(last.withdrew, true);
  assertEquals(withdrawals, 1, "the last one out withdraws");

  // The tombstone is keyed, so a repeat writes nothing new and the answer must not change.
  assertEquals((await retireIfLast(shared, spec, { subject, instance: second }, withdraw)).withdrew, true);
  assertEquals(withdrawals, 2, "a repeated retirement is a repeated withdrawal, not a contradiction");
});

Deno.test("[presence] an incomplete view is never the last one out", async () => {
  // The direction this must fail in: the truncated read is a page of tombstones, so it reports an
  // empty world while an instance is still serving underneath it. Treating that as zero withdraws
  // a live fleet's advertisements, and nothing downstream could tell that had happened.
  const { subject, target } = await hidden();
  const mine = uniq("i");

  let withdrawn = false;
  const truncated = await retireIfLast(shared, spec, { subject, instance: mine }, () => {
    withdrawn = true;
    return Promise.resolve();
  }, { maxScan: 1 });

  assertEquals(truncated.withdrew, false, "an answer that admits it is a prefix is not evidence of being alone");
  assertEquals(withdrawn, false, `${target} is still beating below the ceiling`);
  assertEquals(truncated.complete, false, "and the caller can tell this decline from an ordinary one");
  assertEquals([...truncated.others], [], "an empty `others` on an incomplete view means NOTHING");

  // The same call on a COMPLETE view sees it and still declines, which is what proves the guard
  // above is doing the work rather than the emptiness of the prefix.
  const whole = await retireIfLast(shared, spec, { subject, instance: mine }, () => Promise.resolve(), {});
  assertEquals(whole.withdrew, false);
  assertEquals([...whole.others], [target], "the complete view names the instance the prefix hid");
});

// A stub client, because this is about what the SERVER did not send. `nextCursor` says where to
// continue and never that it is safe to stop, so a space that omits it must not turn a one-page
// prefix into `complete: true` — `retireIfLast` trusts that flag to decide it is the last one out.
function pagedClient(pages: { records: unknown[]; nextCursor?: string }[]): RadiaClient {
  let n = 0;
  return { queryPage: () => Promise.resolve(pages[Math.min(n++, pages.length - 1)]) } as unknown as RadiaClient;
}

const freshBeat = (instance: string) => ({
  body: { subject: "s", instance },
  runtimeMeta: { createdAt: new Date().toISOString() },
});

Deno.test("[presence] a full page with no cursor is a PREFIX, not the end of the walk", async () => {
  const full = Array.from({ length: 200 }, (_, i) => freshBeat(`i${i}`));
  const view = await livePresence(pagedClient([{ records: full }]), spec);

  assertEquals(view.complete, false, "a full page that names no continuation cannot be the whole set");
  assertEquals(view.scanned, 200, "and the walk stopped rather than looping on the same page");
});

Deno.test("[presence] a SHORT page ends the walk even with no cursor", async () => {
  const view = await livePresence(pagedClient([{ records: [freshBeat("only")] }]), spec);
  assertEquals(view.complete, true, "a short page is the evidence of exhaustion that cannot go missing");
  assertEquals([...(view.live.get("s") ?? [])], ["only"]);
});

Deno.test("[presence] an already-aborted signal stops the beat instead of leaking it", async () => {
  // `addEventListener("abort")` on a signal that has ALREADY aborted never fires, so registering and
  // walking away leaves the interval running for the life of the process — and a launcher that shut
  // down during startup then reads LIVE forever, blocking every other launcher's withdrawal.
  //
  // Tested against a MOVED clock, because a beat inside the window the announce already used
  // replays whether the handle is stopped or not, which makes the obvious version of this test
  // pass on the broken code.
  const subject = uniq("svc"), instance = uniq("i");
  let clock = 7_000_000_000_000;
  const ac = new AbortController();
  ac.abort();
  const handle = await announcePresence(shared, spec, subject, { instance, signal: ac.signal, now: () => clock });

  const count = async () => (await shared.queryAll({ kind: KIND, match: { subject } })).length;
  assertEquals(await count(), 0, "an announce on an aborted signal writes nothing at all");

  clock += spec.refreshMs; // a window nothing has used, so a live handle WOULD write here
  await handle.beat();
  assertEquals(await count(), 0, "and the handle stays stopped rather than beating on");
});

Deno.test("[presence] a clock that steps BACKWARDS costs one beat, not every beat", async () => {
  // The window comes from the wall clock, so a backward step lands on a window that already has a
  // record: the write replays and `put` reports success. Left alone, an instance that is beating
  // fine reads dead once the step passes the TTL.
  const subject = uniq("svc"), instance = uniq("i");
  let clock = 5_000_000_000_000;
  const handle = await announcePresence(shared, spec, instance ? subject : subject, { instance, now: () => clock });
  try {
    clock += spec.refreshMs;
    await handle.beat();
    const afterTwo = (await shared.queryAll({ kind: KIND, match: { subject } })).length;
    assertEquals(afterTwo, 2, "two windows, two records");

    clock -= spec.refreshMs * 10; // an NTP correction dragging the clock ten windows back
    await handle.beat(); // the spent window: replays, and is noticed
    await handle.beat();
    await handle.beat();
    assert(
      (await shared.queryAll({ kind: KIND, match: { subject } })).length > afterTwo,
      "beats resume rather than replaying until the clock catches up",
    );
  } finally {
    await handle.retire();
  }
});

Deno.test("[presence] a re-announced instance can be retired a second time", async () => {
  // A CONSTANT retirement key replays the first tombstone, so an instance id that comes back could
  // never be withdrawn again and would read live for a full TTL after leaving.
  const subject = uniq("svc"), instance = uniq("i");
  let clock = 6_000_000_000_000;
  const first = await announcePresence(shared, spec, subject, { instance, now: () => clock });
  await first.retire();
  assertEquals([...(await livePresence(shared, spec, { subject })).live.get(subject) ?? []], [], "retired");

  clock += spec.refreshMs * 3;
  const again = await announcePresence(shared, spec, subject, { instance, now: () => clock });
  assertEquals([...(await livePresence(shared, spec, { subject })).live.get(subject) ?? []], [instance], "back");

  await again.retire();
  assertEquals(
    [...(await livePresence(shared, spec, { subject })).live.get(subject) ?? []],
    [],
    "and the SECOND retirement lands rather than replaying the first",
  );
});
