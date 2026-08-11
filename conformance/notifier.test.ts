// The watch wakeup primitive (`src/core/notifier.ts`), driven directly.
//
// A unit test, not an adapter suite: what matters here is the STATE MACHINE around waiting (who
// gets woken, when the poll runs, what happens when it fails), and driving it through a Space and
// a storage adapter would only make the timing harder to pin. The cross-instance behaviour it
// exists for is pinned end to end in `suites/watches.ts`.

import { assert, assertEquals } from "@std/assert";
import { CHANGE_POLL_MS, Notifier } from "../src/core/notifier.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

Deno.test("notifier: a timed-out waiter removes itself, so a quiet space does not accumulate them", async () => {
  // As an array, waiters were only cleared by the next notify(). A stream that reconnects on a
  // keepalive against a space nobody writes to therefore grew the list forever, from an ordinary
  // authenticated call. The Set plus self-removal is what bounds it.
  const n = new Notifier();
  await Promise.all([n.wait(5), n.wait(5), n.wait(5)]);
  assertEquals(n.waiting, 0, "timed-out waiters are gone before any notify()");

  const pending = n.wait(5_000);
  assertEquals(n.waiting, 1);
  n.notify();
  await pending;
  assertEquals(n.waiting, 0, "and a notified waiter is gone too");
});

Deno.test("notifier: notify(kind) wakes that kind and the any-set, not foreign kinds", async () => {
  // The fan-out fix (bench/suites/fanout.ts): a write of kind K must wake only streams watching
  // K (a watch matches only its own kind), plus any kind-less waiter. Kind-blind wakeup was the
  // O(U) term behind the chat's quadratic — every write woke every stream.
  const n = new Notifier();
  const woke = { a: false, b: false, any: false };
  const wa = n.wait(10_000, "a").then(() => (woke.a = true));
  const wb = n.wait(10_000, "b").then(() => (woke.b = true));
  const wany = n.wait(10_000).then(() => (woke.any = true));
  assertEquals(n.waiting, 3);

  n.notify("a");
  await wa;
  await sleep(5); // give b/any a chance to (wrongly) resolve
  assertEquals(woke, { a: true, b: false, any: true }, "kind 'a' and the any-waiter woke; 'b' did not");
  assertEquals(n.waiting, 1, "only the 'b' waiter is still parked");

  // undefined wakes EVERYONE — the conservative wake for authorization changes and foreign polls.
  const wb2woken = wb; // the original 'b' waiter
  n.notify();
  await wb2woken;
  assertEquals(woke.b, true, "notify() with no kind wakes the remaining 'b' waiter");
  assertEquals(n.waiting, 0);
  await wany;
});

Deno.test("notifier: a same-kind waiter re-registered after a wake is woken again", async () => {
  // The SSE loop re-parks on the same kind every lap. A stale Set left in #byKind, or one deleted
  // while a sibling still waits, would drop that stream's next wakeup — a stall until keepalive.
  const n = new Notifier();
  let woke = 0;
  const first = n.wait(10_000, "feed").then(() => woke++);
  n.notify("feed");
  await first;
  assertEquals(n.waiting, 0, "the kind's set is cleaned up when its last waiter leaves");
  const second = n.wait(10_000, "feed").then(() => woke++);
  assertEquals(n.waiting, 1);
  n.notify("feed");
  await second;
  assertEquals(woke, 2, "a re-registered same-kind waiter wakes on the next write");
});

Deno.test("notifier: the change poll wakes a waiter, and only while someone is waiting", async () => {
  let polls = 0;
  let changed = false;
  const n = new Notifier(() => {
    polls++;
    return Promise.resolve(changed);
  });

  // Nobody waiting: no timer, no queries. This is what keeps an idle space idle.
  await sleep(CHANGE_POLL_MS * 3);
  assertEquals(polls, 0, "an idle space polls nothing");

  const started = performance.now();
  const woke = n.wait(10_000);
  await sleep(CHANGE_POLL_MS * 2);
  assert(polls > 0, "a waiting stream drives the poll");
  assertEquals(n.waiting, 1, "…and a poll that reports no change does not wake it");

  changed = true;
  await woke;
  const elapsed = performance.now() - started;
  assert(elapsed < 5_000, `woke via the poll, not the keepalive (${elapsed.toFixed(0)}ms)`);

  const after = polls;
  await sleep(CHANGE_POLL_MS * 3);
  assertEquals(polls, after, "the poll stops again once the last waiter leaves");
});

Deno.test("notifier: a failing poll never reaches the stream", async () => {
  // The poll is a hint. A database hiccup must cost a wakeup, not an SSE connection: the caller
  // still has its keepalive, and the event log is still the truth.
  let polls = 0;
  const n = new Notifier(() => {
    polls++;
    return Promise.reject(new Error("connection reset"));
  });
  const woke = n.wait(CHANGE_POLL_MS * 4);
  await woke; // resolves by keepalive rather than rejecting
  assert(polls > 0, "it kept polling through the failures");
  assertEquals(n.waiting, 0);
});
