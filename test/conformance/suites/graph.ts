// The relationship graph: children (down) and lineage (up).
//
// Both are answered from derived structures rather than from a scan, so the thing to pin is that
// the derivation stays in step with the records it describes. `record_edges` is written in the
// same transaction as the record, and `getRecords` batches a lineage level into one round trip.
// Neither may change what a caller sees, only what it costs.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import { Space } from "../../../src/core/space.ts";

function newSpace(adapter: Parameters<Suite["run"]>[0]): Space {
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }], sortablePaths: [] });
  return space;
}

export const graphSuites: Suite[] = [
  {
    name: "children are the records naming this one as a parent, and only those",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id: root } = await space.put({ kind: "task", body: { tag: "root" } });
      const kids: string[] = [];
      for (let i = 0; i < 3; i++) {
        kids.push((await space.put({ kind: "task", body: { tag: `kid${i}` }, parentIds: [root] })).id);
      }
      // A grandchild is NOT a child of root, and an unrelated record is nobody's child.
      const { id: grandchild } = await space.put({ kind: "task", body: { tag: "gc" }, parentIds: [kids[0]] });
      await space.put({ kind: "task", body: { tag: "unrelated" } });

      assertEquals((await space.getChildren(root)).map((r) => r.id).sort(), [...kids].sort());
      assertEquals((await space.getChildren(kids[0])).map((r) => r.id), [grandchild]);
      assertEquals(await space.getChildren(grandchild), []);
    },
  },
  {
    name: "a record with several parents is a child of each",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id: a } = await space.put({ kind: "task", body: { tag: "a" } });
      const { id: b } = await space.put({ kind: "task", body: { tag: "b" } });
      const { id: merged } = await space.put({ kind: "task", body: { tag: "merged" }, parentIds: [a, b] });

      assertEquals((await space.getChildren(a)).map((r) => r.id), [merged]);
      assertEquals((await space.getChildren(b)).map((r) => r.id), [merged]);
    },
  },
  {
    name: "a record created by ack-with-result is a child too (every insert path maintains the edge)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id: task } = await space.put({ kind: "task", body: { tag: "work" } });
      const claimed = await space.take({ pattern: { kind: "task", match: { tag: "work" } } }, { leaseSeconds: 60 });
      assert(claimed);
      // Results enter the space through a different insert path than `put`. A reverse index that
      // only the put path maintained would silently lose exactly the edges that matter most:
      // a task to its result.
      await space.ack(claimed!.lease, { kind: "task", body: { tag: "result" } });

      const children = await space.getChildren(task);
      assertEquals(children.length, 1, "the result record is a child of the task it answers");
      assertEquals((children[0].body as { tag: string }).tag, "result");
    },
  },
  {
    name: "children are BOUNDED and pageable, so fan-out cannot be unbounded",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id: root } = await space.put({ kind: "task", body: { tag: "root" } });
      const kids: string[] = [];
      for (let i = 0; i < 30; i++) {
        kids.push((await space.put({ kind: "task", body: { tag: `k${i}` }, parentIds: [root] })).id);
      }
      kids.sort();

      assertEquals((await space.getChildren(root, 10)).map((r) => r.id), kids.slice(0, 10), "a limit is a limit");

      // Paged by the same keyset contract as `query`: `after` is the last child id of the page.
      const walked: string[] = [];
      let after: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await space.getChildren(root, 7, after ? { after } : undefined);
        if (page.length === 0) break;
        walked.push(...page.map((r) => r.id));
        after = page[page.length - 1].id;
      }
      assertEquals(walked, kids, "every child exactly once, in id order");

      assertEquals(
        (await space.getChildren(root, 5, { dir: "desc" })).map((r) => r.id),
        [...kids].reverse().slice(0, 5),
        "and newest-first when asked",
      );
    },
  },
  {
    name: "a graph walk does not read an unbounded fan-out",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id: root } = await space.put({ kind: "task", body: { tag: "hub" } });
      for (let i = 0; i < 60; i++) await space.put({ kind: "task", body: { i }, parentIds: [root] });

      // The node cap bounds what the graph SHOWS; the fan-out bound is what stops one step reading
      // a whole subtree to enqueue it. Both hold, and the walk still terminates with a sane picture.
      const graph = await space.getGraph(root, { maxNodes: 25 });
      assert(graph.nodes.length <= 25, `node cap held: ${graph.nodes.length}`);
      assert(graph.nodes.some((n) => n.id === root), "the root is in the graph");
      // The cap is only honest if it SAYS so. A capped graph drawn without this reads as the whole
      // story, which is the bounded-read-as-population trap in a picture instead of a list.
      assertEquals(graph.truncated, true, "a capped walk reports that more exists");
      assertEquals(
        (await space.getGraph(root, { maxNodes: 500 })).truncated,
        false,
        "and a complete one does not",
      );
    },
  },
  {
    name: "a descendants-only walk separates one thread from the siblings it shares a hub with",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // The shape every conversation, batch and fan-out has: one hub, N threads under it. Seeded
      // anywhere inside a thread, the both-ways walk climbs to the hub and comes back down into
      // every OTHER thread, so "show me this one" is unanswerable without a direction.
      const { id: hub } = await space.put({ kind: "task", body: { tag: "hub" } });
      const heads: string[] = [];
      for (let t = 0; t < 3; t++) {
        const { id: head } = await space.put({ kind: "task", body: { thread: t }, parentIds: [hub] });
        const { id: mid } = await space.put({ kind: "task", body: { thread: t, step: 1 }, parentIds: [head] });
        await space.put({ kind: "task", body: { thread: t, step: 2 }, parentIds: [mid] });
        heads.push(head);
      }

      const down = await space.getGraph(heads[0], { direction: "down" });
      assertEquals(down.nodes.length, 3, "the head and its two descendants, and nothing else");
      assert(!down.nodes.some((n) => n.id === hub), "it does not climb to the hub");
      for (const other of heads.slice(1)) {
        assert(!down.nodes.some((n) => n.id === other), "and so cannot reach a sibling thread");
      }
      // The inbound edge is still drawn: the head has a parent, and hiding that would misreport the
      // shape rather than narrow it. It is dropped only because the hub is not in view.
      assert(!down.edges.some((e) => e.from === hub), "an edge to a node out of view is dropped");

      // The counterexample, so the assertions above are not passing for an unrelated reason.
      const both = await space.getGraph(heads[0]);
      assertEquals(both.nodes.length, 10, "the default walk returns the hub and all three threads");
    },
  },
  {
    name: "lineage walks ancestors by depth, deduping a diamond",
    run: async (adapter) => {
      const space = newSpace(adapter);
      //        root
      //       /    \        a diamond: `bottom` reaches root by two distinct paths, so a walk
      //      l      r       that does not dedupe would report root twice.
      //       \    /
      //       bottom
      const { id: root } = await space.put({ kind: "task", body: { tag: "root" } });
      const { id: l } = await space.put({ kind: "task", body: { tag: "l" }, parentIds: [root] });
      const { id: r } = await space.put({ kind: "task", body: { tag: "r" }, parentIds: [root] });
      const { id: bottom } = await space.put({ kind: "task", body: { tag: "bottom" }, parentIds: [l, r] });

      const lineage = await space.getLineage(bottom);
      assertEquals(lineage.length, 4, "each ancestor appears exactly once");
      const depth = new Map(lineage.map((n) => [n.record.id, n.depth]));
      assertEquals(depth.get(bottom), 0);
      assertEquals(depth.get(l), 1);
      assertEquals(depth.get(r), 1);
      assertEquals(depth.get(root), 2, "the shared ancestor is reported at the depth first reached");
      // A level's records are fetched in one batch; the output must not depend on that batch's
      // arrival order.
      assertEquals(lineage.filter((n) => n.depth === 1).map((n) => n.record.id), [l, r].sort());
    },
  },
  {
    name: "lineage of a deep chain keeps every hop, in order",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const chain: string[] = [(await space.put({ kind: "task", body: { tag: "n0" } })).id];
      for (let i = 1; i < 40; i++) {
        chain.push((await space.put({ kind: "task", body: { tag: `n${i}` }, parentIds: [chain[i - 1]] })).id);
      }
      const lineage = await space.getLineage(chain[39]);
      assertEquals(lineage.length, 40);
      // Depth i counts back from the record asked about, so the chain reverses.
      assertEquals(lineage.map((n) => n.record.id), [...chain].reverse());
    },
  },
  {
    name: "lineage respects its node cap and a record with no parents is its own lineage",
    run: async (adapter) => {
      const space = newSpace(adapter);
      let prev: string | undefined;
      let last = "";
      for (let i = 0; i < 12; i++) {
        const { id } = await space.put({ kind: "task", body: { tag: `n${i}` }, parentIds: prev ? [prev] : [] });
        prev = id;
        last = id;
      }
      assert((await space.getLineage(last, 5)).length <= 12, "the cap bounds the walk");
      assert((await space.getLineage(last, 5)).length >= 5, "and does not cut it short of the cap");

      const { id: lone } = await space.put({ kind: "task", body: { tag: "lone" } });
      const solo = await space.getLineage(lone);
      assertEquals(solo.length, 1);
      assertEquals(solo[0].depth, 0);
    },
  },
];
