// An exhaustive read must not be able to report a PREFIX as the whole set.
//
// `queryAll` is the call every registry projection rests on, and its contract is the strong one:
// it pages to exhaustion and THROWS rather than returning a plausible prefix. When it walked by
// `after` it decided it was done from the page's own size, which is evidence it computes itself.
// Rewriting it to walk by `nextCursor` moved that decision to a field the SPACE chooses to send,
// and a space that does not send one would have turned the refusing read into a silently
// truncating one, with the result still branded a `Population`.
//
// So the cursor says where to CONTINUE; a short page is the only thing that says STOP. The three
// walks with the same shape (`readAllManifests`, git's version walk) follow the same rule and
// report `complete: false` instead of throwing, because that is the signal their callers already
// have. Driven over a real socket, because the defect lives in what crosses it.

import { assert, assertRejects } from "@std/assert";
import { Space } from "../src/core/space.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";
import { makeHandler } from "../src/server/http.ts";
import { RadiaClient } from "../sdk/ts/client.ts";

/** A space whose query answers have been stripped of `nextCursor`, as an older one's would be. */
async function spaceWithout(field: string) {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  space.registerKind({ kind: "note", indexedPaths: [{ path: "i", type: "number" }], claimable: false });
  const handler = makeHandler(space, "<html>console</html>", false);
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
    const res = await handler(req);
    if (new URL(req.url).pathname !== "/v0/records/query") return res;
    const body = await res.json();
    delete body[field];
    return Response.json(body, { status: res.status });
  });
  return {
    space,
    base: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    close: async () => {
      await server.shutdown();
      await adapter.close();
    },
  };
}

Deno.test("[exhaustion] queryAll refuses a full page it cannot continue, rather than calling it the whole set", async () => {
  const { space, base, close } = await spaceWithout("nextCursor");
  try {
    // One full page and then some: 501 records over a page size of 500.
    for (let i = 0; i < 501; i++) await space.put({ kind: "note", body: { i } });
    const client = new RadiaClient(base);

    await assertRejects(
      () => client.queryAll({ kind: "note" }),
      Error,
      "no cursor to continue from",
      "a full page with no cursor must raise; returning it would report 500 of 501 as the whole kind",
    );

    // And the refusal is specific to being UNABLE TO CONTINUE, not to the field being absent: a
    // kind that fits in one page still answers, because a short page proves exhaustion by itself.
    const small = await client.queryAll({ kind: "note", match: { i: { $lt: 3 } } });
    assert(small.length === 3, `a short page is complete on its own evidence: got ${small.length}`);
  } finally {
    await close();
  }
});

Deno.test("[exhaustion] a workspace listing that cannot continue reports complete:false, never a short truth", async () => {
  const { space, base, close } = await spaceWithout("nextCursor");
  try {
    space.registerKind({
      kind: "workspace",
      indexedPaths: [{ path: "name", type: "keyword" }, { path: "owner", type: "keyword" }, { path: "treeDigest", type: "keyword" }],
      claimable: false,
    });
    for (let i = 0; i < 501; i++) {
      await space.put({ kind: "workspace", body: { name: `w${i}`, owner: "human:t", treeDigest: `d${i}`, files: [] } });
    }
    const { summarizeWorkspaces } = await import("../extensions/ts/workspace.ts");
    const out = await summarizeWorkspaces(new RadiaClient(base));
    // The whole point of the flag: a caller that cannot be given everything is TOLD, and
    // `radia workspaces` and the chat's `list_workspaces` both read this.
    assert(out.complete === false, "a listing that stopped early must not report itself complete");
  } finally {
    await close();
  }
});
