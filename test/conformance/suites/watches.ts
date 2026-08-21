// M1 conformance: the Space-level watch primitives that back the SSE endpoint.
// createWatch (validates the pattern), matchesEvent (wakeup semantics: available records
// matching the pattern), and latestCursor (the starting cursor). The SSE transport and
// resumption are covered by an HTTP smoke, not here. Runs on every adapter.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { SpaceEvent, StorageAdapter } from "../../../src/storage/adapter.ts";
import { Space } from "../../../src/core/space.ts";
import type { RadiaError } from "../../../src/core/errors.ts";

async function forbidden(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return (e as RadiaError).code === "forbidden";
  }
}

function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  return space;
}

async function eventsOf(space: Space): Promise<SpaceEvent[]> {
  return await space.getEvents("0", 500);
}

/** The suite drives the Space directly as the local operator. */
const OWNER = "human:local";

export const watchSuites: Suite[] = [
  {
    name: "createWatch validates the pattern; undeclared path is rejected",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { watchId } = await space.createWatch({ kind: "task", match: { tag: "x" } }, OWNER);
      assert(watchId.length > 0);
      assert(space.getWatch(watchId, OWNER), "watch not stored");

      let code: string | undefined;
      try {
        await space.createWatch({ kind: "task", match: { nope: 1 } }, OWNER);
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      assertEquals(code, "undeclared_path");
    },
  },
  {
    name: "matchesEvent: available matching records wake; consumed do not",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const kindOnly = space.getWatch((await space.createWatch({ kind: "task" }, OWNER)).watchId, OWNER)!;

      await space.put({ kind: "task", body: { tag: "x" } });
      const putEvent = (await eventsOf(space)).find((e) => e.operation === "put")!;
      assert(putEvent.state === "available");
      assertEquals(await space.matchesEvent(kindOnly, putEvent), true);

      // a different kind's event never matches
      assertEquals(
        await space.matchesEvent(
          { request: { kind: "other" }, match: { kind: "other" }, cursor0: "0", owner: OWNER, lastSeenAt: Date.now() },
          putEvent,
        ),
        false,
      );

      // consume it; the ack event (state consumed) is not a wakeup
      const t = await space.take({ pattern: { kind: "task" } });
      assert(t);
      await space.ack(t!.lease);
      const ackEvent = (await eventsOf(space)).find((e) => e.operation === "ack")!;
      assertEquals(await space.matchesEvent(kindOnly, ackEvent), false);
    },
  },
  {
    name: "matchesEvent honors predicates (fetches the record)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const wantX = space.getWatch((await space.createWatch({ kind: "task", match: { tag: "x" } }, OWNER)).watchId, OWNER)!;
      const wantY = space.getWatch((await space.createWatch({ kind: "task", match: { tag: "y" } }, OWNER)).watchId, OWNER)!;

      await space.put({ kind: "task", body: { tag: "x" } });
      const putEvent = (await eventsOf(space)).find((e) => e.operation === "put")!;
      assertEquals(await space.matchesEvent(wantX, putEvent), true);
      assertEquals(await space.matchesEvent(wantY, putEvent), false);
    },
  },
  {
    name: "a record created by ack wakes a watch on the RESULT's kind",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const wantResult = space.getWatch((await space.createWatch({ kind: "result" }, OWNER)).watchId, OWNER)!;

      await space.put({ kind: "task", body: { tag: "x" } });
      const t = await space.take({ pattern: { kind: "task" } });
      assert(t);
      const acked = await space.ack(t!.lease, { kind: "result", body: { ok: true } });
      assert(acked.status === "ok");

      // The ack event is `consumed` and carries the parent's kind, so it can never be the
      // wakeup: the result needs a `put` event of its own or the watcher sleeps forever.
      const wakeups: SpaceEvent[] = [];
      for (const e of await eventsOf(space)) {
        if (await space.matchesEvent(wantResult, e)) wakeups.push(e);
      }
      assertEquals(wakeups.length, 1, "expected exactly one wakeup for the result record");
      assertEquals(wakeups[0].operation, "put");
      assertEquals(wakeups[0].recordId, acked.resultId);
    },
  },
  {
    name: "a fresh watch starts after existing events (cursor from now)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "old" } });
      const before = (await eventsOf(space)).length;
      assert(before >= 1);
      // createWatch records the current seq as its start cursor; new events come after it.
      await space.createWatch({ kind: "task" }, OWNER);
      await space.put({ kind: "task", body: { tag: "new" } });
      assert((await eventsOf(space)).length > before);
    },
  },
  {
    // Audit package O. The in-process Notifier only knows this Space's own mutations, so a watch
    // used to sleep on a record another instance wrote until its caller's keepalive (15s in the
    // SSE loop) — self-healing, never a lost event, but felt directly in every cross-instance hop
    // of an interactive turn. Two Space objects over one database is exactly that arrangement:
    // separate notifiers, one event log.
    name: "a watch wakes for a record written through ANOTHER instance, not on its keepalive",
    run: async (adapter) => {
      const a = newSpace(adapter);
      const b = newSpace(adapter); // second instance, same database, its own Notifier

      // Drain the baseline: the first poll of a Space's life reports a change unconditionally
      // (it has no cursor yet and must not swallow a write from before it took one). Without
      // this the rest of the case would pass whether or not anything was ever written.
      await a.waitForEvents(2_000);

      let woke = false;
      const waiting = a.waitForEvents(20_000).then(() => {
        woke = true;
      });
      await new Promise((r) => setTimeout(r, 800));
      assertEquals(woke, false, "nothing was written, so nothing may claim a wakeup");

      const started = performance.now();
      await b.put({ kind: "task", body: { tag: "from-b" } });
      await waiting;
      const elapsed = performance.now() - started;
      assert(elapsed < 10_000, `woke via the log, not the keepalive (${elapsed.toFixed(0)}ms)`);

      // And the wakeup is real: A can see B's record, which is what the stream would deliver.
      const seen = await a.query({ kind: "task", match: { tag: "from-b" } });
      assertEquals(seen.length, 1, "the instance that woke can read what the other wrote");
    },
  },
  {
    name: "an abandoned watch is dropped; one somebody is still reading is not",
    run: async (adapter) => {
      // The map was never pruned: every `POST /v0/watches` allocated an entry that outlived the
      // process's interest in it, from a cheap authenticated call. The inspection backlog named
      // this its one prerequisite, because an inspection console is exactly the workload that opens
      // many short-lived watches.
      const space = new Space(adapter, { watchIdleSeconds: 0.05 }); // 50ms, so the window is testable
      space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });

      const live = (await space.createWatch({ kind: "task" }, OWNER)).watchId;
      const abandoned = (await space.createWatch({ kind: "task" }, OWNER)).watchId;
      assertEquals(space.liveWatches(), 2);

      await new Promise((r) => setTimeout(r, 80)); // both are now past the idle window
      // Reading one is what a live stream does every lap (at most a keepalive apart), and that is
      // what keeps it: "idle" means nobody is asking, not "disconnected". Deleting on DISCONNECT
      // would have been the wrong rule — a client that drops reconnects to the same id with
      // Last-Event-ID, and the cursor is the whole point of that.
      assert(space.getWatch(live, OWNER), "the attached one is still readable");

      // The next create sweeps. The touched watch survives; the one nobody ever attached to does
      // not, which is the growth this closes.
      await space.createWatch({ kind: "task" }, OWNER);
      assert(space.getWatch(live, OWNER), "a watch somebody is reading survives its own idle window");
      assertEquals(space.getWatch(abandoned, OWNER), undefined, "the untouched one is gone");
      assertEquals(space.liveWatches(), 2, "the map holds the live one and the new one, not three");
    },
  },
  {
    name: "a principal cannot hold watches without limit, and is told how to get one back",
    run: async (adapter) => {
      // A ceiling, not an eviction: dropping somebody's oldest watch to make room kills a live
      // stream to serve a new one, and the loser is told nothing.
      // Two operators, so the second principal can watch without a grant of its own: the subject
      // here is the ceiling, not authorization.
      const space = new Space(adapter, {
        maxWatchesPerPrincipal: 2,
        watchIdleSeconds: 3600,
        operators: [OWNER, "human:other"],
      });
      space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
      await space.createWatch({ kind: "task" }, OWNER);
      await space.createWatch({ kind: "task" }, OWNER);

      let code: string | undefined;
      let message = "";
      try {
        await space.createWatch({ kind: "task" }, OWNER);
      } catch (e) {
        code = (e as RadiaError).code;
        message = (e as Error).message;
      }
      assertEquals(code, "too_many_watches");
      assert(/Last-Event-ID|close streams/.test(message), `the refusal says what to do: ${message}`);

      // The limit is PER PRINCIPAL: another one is unaffected by this one's leak.
      assert(await space.createWatch({ kind: "task" }, "human:other"), "another principal is unaffected");
    },
  },
  {
    name: "interest: a dry run reports who would receive a record, before it is written",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { definitionToken } = await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "interest", operations: ["put", "query"] },
      ]);
      const { run, runToken: _t } = await space.mintRun(definitionToken);

      // The run declares what it listens for. Authorship is server-assigned, so the body never
      // claims which run it belongs to.
      await space.put({ kind: "interest", body: { kind: "task", match: { tag: "x" } } }, undefined, run);

      const hit = await space.matchingInterests("task", { tag: "x" });
      assertEquals(hit.interests.length, 1, "the interest matches a record it would claim");
      assertEquals(hit.interests[0].run, run);
      assertEquals(hit.interests[0].agent, "agent:w", "the agent is resolved, not taken from the body");

      // The candidate need not exist: that is the point of asking before the write.
      const miss = await space.matchingInterests("task", { tag: "y" });
      assertEquals(miss.interests.length, 0, "a record outside the pattern reaches nobody");
      assertEquals((await space.matchingInterests("other", { tag: "x" })).interests.length, 0, "wrong kind");
    },
  },
  {
    name: "interest: liveness comes from the RUN, so a stopped worker stops appearing",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { definitionToken } = await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "interest", operations: ["put", "query"] },
      ]);
      const { run } = await space.mintRun(definitionToken);
      await space.put({ kind: "interest", body: { kind: "task" } }, undefined, run);
      assertEquals((await space.matchingInterests("task", {})).interests.length, 1);

      // A crashed worker never retires its interest, so the record outlives the process. Presence
      // must never be read as "someone is listening"; the run is the fact.
      await space.stopRun(run);
      assertEquals(
        (await space.matchingInterests("task", {})).interests.length,
        0,
        "a stopped run's interest is dead even though the record is still there",
      );
    },
  },
  {
    name: "interest: retiring withdraws exactly one pattern and leaves the others",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { definitionToken } = await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "interest", operations: ["put", "query"] },
      ]);
      const { run } = await space.mintRun(definitionToken);
      await space.put({ kind: "interest", body: { kind: "task", match: { tag: "x" } } }, undefined, run);
      await space.put({ kind: "interest", body: { kind: "task", match: { tag: "y" } } }, undefined, run);
      assertEquals((await space.matchingInterests("task", { tag: "x" })).interests.length, 1);
      assertEquals((await space.matchingInterests("task", { tag: "y" })).interests.length, 1);

      // One entry per (author, kind, pattern), so a retirement targets one of them.
      await space.put({ kind: "interest", body: { kind: "task", match: { tag: "x" }, retired: true } }, undefined, run);
      assertEquals((await space.matchingInterests("task", { tag: "x" })).interests.length, 0, "withdrawn");
      assertEquals((await space.matchingInterests("task", { tag: "y" })).interests.length, 1, "the sibling stands");
    },
  },
  {
    name: "interest: an unpatterned interest takes everything of its kind",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { definitionToken } = await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "interest", operations: ["put", "query"] },
      ]);
      const { run } = await space.mintRun(definitionToken);
      await space.put({ kind: "interest", body: { kind: "task" } }, undefined, run);
      assertEquals((await space.matchingInterests("task", { anything: 1 })).interests.length, 1);
      assertEquals((await space.matchingInterests("task", {})).interests.length, 1);
    },
  },
  {
    name: "revalidateWatch: a revoked grant ends a watch that already exists",
    run: async (adapter) => {
      // The defect this closes: a watch compiled its scope ONCE, at creation, and then streamed
      // under it until the client disconnected. Revocation is a successor record, so `authorizeWatch`
      // saw it immediately and every future watch was refused; the one already streaming was not.
      const space = newSpace(adapter);
      const grant = { principal: "agent:w", kind: "task", operations: ["take"] };
      await space.put({ kind: "grant", body: grant });
      const { watchId } = await space.createWatch({ kind: "task" }, "agent:w");

      await space.put({ kind: "grant", body: { ...grant, retired: true } });
      assert(
        await forbidden(() => space.revalidateWatch(watchId, "agent:w")),
        "the live watch must lose its scope when the grant is revoked, not at disconnect",
      );
    },
  },
  {
    name: "revalidateWatch: a NARROWED grant narrows the live watch, and does not ratchet",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const wide = { principal: "agent:w", kind: "task", operations: ["take"] };
      await space.put({ kind: "grant", body: wide });
      const { watchId } = await space.createWatch({ kind: "task" }, "agent:w");
      assertEquals(space.getWatch(watchId, "agent:w")!.match.where, undefined, "unrestricted to start");

      // Replace the unscoped grant with a pattern-scoped one: the stream must pick up the narrower
      // scope, not keep the one it compiled at creation.
      await space.put({ kind: "grant", body: { ...wide, retired: true } });
      await space.put({ kind: "grant", body: { ...wide, pattern: { tag: "a" } } });
      const narrowed = await space.revalidateWatch(watchId, "agent:w");
      assert(narrowed.match.where, "the live watch did not pick up the grant's pattern");

      // Re-deriving from the ORIGINAL request, not from the already-narrowed match: widening the
      // grant back must restore the wide scope. Recombining the compiled match instead would
      // ratchet it tighter on every check and never let go.
      await space.put({ kind: "grant", body: { ...wide, pattern: { tag: "a" }, retired: true } });
      await space.put({ kind: "grant", body: wide });
      assertEquals(
        (await space.revalidateWatch(watchId, "agent:w")).match.where,
        undefined,
        "scope must be re-derived from the client's original pattern, not the narrowed one",
      );
    },
  },
];
