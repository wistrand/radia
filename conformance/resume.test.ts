// The sentinel rule, exercised through a real client: an SDK watch whose resume cursor falls
// below the event-GC horizon gets one 410, recovers by resetting to "0" (which the server clamps
// to the retained log), and keeps receiving wakeups. The hazard pinned here is the hot loop: a
// server that 410'd the sentinel too would spin every shipped client forever, and this test would
// hang on a wakeup that never arrives instead of passing.
//
// A real socket, like exchange.test.ts and for the same reason: the reconnect under test lives in
// the SDK's own SSE fetch loop, and a stubbed fetch would test a mock's idea of a 410.

import { assert, assertEquals } from "@std/assert";
import { makeHandler } from "../src/server/http.ts";
import { Space } from "../src/core/space.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";
import { RadiaClient } from "../sdk/ts/client.ts";
import type { SpaceEvent } from "../src/storage/adapter.ts";

/** An adapter whose next getEvents can be told to fail: the only way to end a live SSE stream
 *  server-side without revoking it (a `revoked` frame is terminal for the client), so the SDK's
 *  reconnect-with-cursor path actually runs. */
class DroppingAdapter extends SqliteAdapter {
  dropNext = false;
  override getEvents(afterCursor: string, limit: number): Promise<SpaceEvent[]> {
    // Only the SSE loop reads pages of 200; the notifier's change poll probes with limit 1 and
    // must not eat the induced failure (it swallows errors by design), or the stream never drops.
    if (this.dropNext && limit === 200) {
      this.dropNext = false;
      return Promise.reject(new Error("induced connection drop"));
    }
    return super.getEvents(afterCursor, limit);
  }
}

Deno.test("[resume] an SDK watch survives event GC under its resume cursor without spinning", async () => {
  const adapter = new DroppingAdapter(":memory:");
  await adapter.init();
  // Retention -1 puts the cutoff a second in the future, so everything already written is
  // eligible; see the gc suite for why a cutoff of "now" would flake on a millisecond clock.
  const space = new Space(adapter, { eventRetentionSeconds: -1 });
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  space.registerKind({ kind: "other", indexedPaths: [{ path: "tag", type: "keyword" }], claimable: false });
  const handler = makeHandler(space, "<html>console</html>", false);
  let refusals = 0;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
    const res = await handler(req);
    if (res.status === 410) refusals++;
    return res;
  });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const client = new RadiaClient(base);
  const ac = new AbortController();
  const watch = client.watch({ kind: "task" }, ac.signal);
  try {
    // The generator is LAZY: nothing connects until the first next(). Kick it, then nudge with
    // puts until a wakeup lands, because a put that commits before the watch exists is behind
    // its start cursor forever. Once one is heard, the client holds a real resume cursor.
    const p1 = watch.next();
    let heard = false;
    for (let i = 0; i < 100 && !heard; i++) {
      await space.put({ kind: "task", body: { tag: `first-${i}` } });
      heard = null !== await Promise.race([p1.then(() => true), new Promise<null>((r) => setTimeout(() => r(null), 120))]);
    }
    assert(heard, "the watch never delivered a first wakeup");
    const w1 = await p1;
    assert((w1.value as { recordId: string }).recordId.length > 0);

    // Advance the log with records the watch does NOT match, so no frames reach the client and
    // its cursor stays where it is, then truncate past it. `other` puts rather than sleeps: the
    // horizon must move beyond the held cursor, not merely time pass.
    for (const tag of ["b", "c", "d"]) await space.put({ kind: "other", body: { tag } });
    const gc = await space.gcEvents();
    assert(gc.swept > 0, "the sweep must have truncated the log");

    // End the live stream server-side. The client reconnects with its held cursor, which is now
    // below the horizon: 410, reset to "0", clamped reconnect, all inside the SDK.
    adapter.dropNext = true;
    await space.put({ kind: "other", body: { tag: "wake" } });

    // If the server 410'd the sentinel as well, the client would loop on 410 forever and this
    // next() would never resolve; the test hanging IS the failure mode.
    const last = await space.put({ kind: "task", body: { tag: "after" } });
    for (;;) {
      const w = await watch.next();
      if ((w.value as { recordId: string }).recordId === last.id) break;
    }
    assert(refusals >= 1, "the stale resume must have been refused with a 410 at least once");
  } finally {
    ac.abort();
    await watch.return(undefined);
    // A cancelled stream's server loop may still be parked on waitForEvents; one mutation wakes
    // and ends it, so no keepalive or poll timer outlives the test.
    await space.put({ kind: "other", body: { tag: "flush" } });
    await server.shutdown();
    await adapter.close();
  }
});
