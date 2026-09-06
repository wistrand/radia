// The MCP adapter's coverage of the WIRE, driven as a model drives it: real `radia mcp` over
// stdio against a real space, because a schema that advertises a field the handler drops is
// exactly the bug this guards and a schema-only assertion would pass anyway.
//
// Both fields here were unreachable from a model until 2026-09-06, and each made a whole shape
// impossible rather than merely awkward: without `availableAt` a model cannot write work that
// becomes claimable later, so a bidding window is claimable the instant it exists; without result
// parents it can answer but cannot record what its answer rested on.

import { assert, assertEquals } from "@std/assert";
import { RadiaClient } from "../sdk/ts/client.ts";
import { resolveToken } from "../src/credentials.ts";
import { declareMarketKinds, requesterGrants } from "../extensions/ts/marketplace.ts";

const PORT = 7898;
const url = `http://127.0.0.1:${PORT}`;
const enc = new TextEncoder();

/** One `radia mcp` process, spoken to the way a harness speaks to it. */
class Adapter {
  #child: Deno.ChildProcess;
  #w: WritableStreamDefaultWriter<Uint8Array>;
  #buf = "";
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #id = 0;

  constructor(env: Record<string, string>, port = PORT) {
    this.#child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "src/main.ts", "mcp", "--url", `http://127.0.0.1:${port}`],
      env,
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    this.#w = this.#child.stdin.getWriter();
    this.#reader = this.#child.stdout.getReader();
  }

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    const id = ++this.#id;
    await this.#w.write(enc.encode(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } })}\n`));
    for (;;) {
      const nl = this.#buf.indexOf("\n");
      if (nl < 0) {
        const { value, done } = await this.#reader.read();
        if (done) throw new Error("the adapter closed before answering");
        this.#buf += new TextDecoder().decode(value);
        continue;
      }
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      let msg: { id?: number; result?: { content?: { text?: string }[] } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== id) continue;
      return msg.result?.content?.[0]?.text ?? "";
    }
  }

  async close(): Promise<void> {
    try {
      await this.#w.close();
    } catch { /* already closed */ }
    try {
      this.#child.kill("SIGTERM");
      await this.#child.status;
    } catch { /* already gone */ }
  }
}

Deno.test("[mcp] a model can defer a record and can parent what it answers with", async () => {
  const dir = await Deno.makeTempDir({ prefix: "radia-mcpwire-" });
  const env = { RADIA_CREDENTIALS: `${dir}/credentials.json`, RADIA_DIR: `${dir}/radia`, RADIA_TOKEN: "", RADIA_DEFINITION_TOKEN: "" };
  const space = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
    env,
    stdout: "null",
    stderr: "null",
  }).spawn();
  let mcp: Adapter | undefined;
  try {
    const probe = new RadiaClient(url);
    for (let i = 0; i < 400; i++) {
      try {
        await probe.health();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    Deno.env.set("RADIA_CREDENTIALS", env.RADIA_CREDENTIALS);
    const admin = new RadiaClient(url, { token: resolveToken(url)! });
    // A put needs no declaration; a MATCH does, so the two kinds are declared with the one path
    // each that this exercises.
    await admin.registerKind({ kind: "task", indexedPaths: [{ path: "title", type: "keyword" }], claimable: true });
    await admin.registerKind({ kind: "note", indexedPaths: [{ path: "topic", type: "keyword" }], claimable: false });

    // The adapter runs as an ordinary agent, the way a harness member does: its own definition and
    // the grants for the two kinds this exercises, and nothing else.
    const agent = "agent:mcpwire";
    const def = await admin.createAgentDefinition(agent, [
      { principal: agent, kind: "task", operations: ["put", "take", "query", "read_one"] },
      { principal: agent, kind: "note", operations: ["put", "query", "read_one"] },
    ]);
    mcp = new Adapter({ ...env, RADIA_DEFINITION_TOKEN: def.definitionToken });

    // DELAYED VISIBILITY. The record is written now and claimable later, which is the whole of
    // what a window is here: readable throughout, not a take candidate yet.
    const closesAt = new Date(Date.now() + 1500).toISOString();
    const putRaw = await mcp.call("space_put", { kind: "task", body: { title: "later" }, availableAt: closesAt });
    assert(putRaw.startsWith("{"), `space_put refused: ${putRaw}`);
    const put = JSON.parse(putRaw);
    assert(put.id, putRaw);
    const env1 = await admin.getEnvelope(put.id);
    assertEquals(env1!.state, "available");
    assertEquals(env1!.availableAt, closesAt, "the adapter forwarded it, rather than advertising a field it drops");
    assertEquals(await admin.take({ pattern: { kind: "task", match: {} } }), null, "and nobody may claim it yet");

    // Readable the whole time, which is what makes a window a window rather than a hidden record.
    // Through `space_query`, the coordination plane: `space_get` is an ops read this agent has no
    // power for, and a deferred record's visibility is a data-plane property.
    const seen = JSON.parse(await mcp.call("space_query", { kind: "task", match: { title: "later" } }));
    assertEquals(seen.count, 1, JSON.stringify(seen).slice(0, 200));

    await new Promise((r) => setTimeout(r, 1600));

    // RESULT LINEAGE. The claimed record is always a parent; these are the others the answer rests
    // on, and a model could not say them at all before.
    const evidence = await admin.put({ kind: "note", body: { topic: "evidence" } });
    const claim = JSON.parse(await mcp.call("space_take", { kind: "task", match: {} }));
    assert(claim.claimId, claim);
    const acked = JSON.parse(await mcp.call("space_ack", {
      claimId: claim.claimId,
      resultKind: "note",
      resultBody: { topic: "answer" },
      resultParentIds: [evidence.id],
    }));
    assertEquals(acked.status, "ok", JSON.stringify(acked));
    const result = (await admin.getRecord(acked.resultId))!;
    assert(result.runtimeMeta.parentIds.includes(put.id), "the claimed record is prepended, as always");
    assert(result.runtimeMeta.parentIds.includes(evidence.id), "and the evidence the model named is kept");
  } finally {
    await mcp?.close();
    try {
      space.kill();
      await space.status;
    } catch { /* already gone */ }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("[mcp] a model can run an auction end to end with the two marketplace tools", async () => {
  const dir = await Deno.makeTempDir({ prefix: "radia-mcpmarket-" });
  const env = { RADIA_CREDENTIALS: `${dir}/credentials.json`, RADIA_DIR: `${dir}/radia`, RADIA_TOKEN: "", RADIA_DEFINITION_TOKEN: "" };
  const space = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT + 1), "--artifact-port", "0"],
    env,
    stdout: "null",
    stderr: "null",
  }).spawn();
  let mcp: Adapter | undefined;
  try {
    const marketUrl = `http://127.0.0.1:${PORT + 1}`;
    const probe = new RadiaClient(marketUrl);
    for (let i = 0; i < 400; i++) {
      try {
        await probe.health();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    Deno.env.set("RADIA_CREDENTIALS", env.RADIA_CREDENTIALS);
    const admin = new RadiaClient(marketUrl, { token: resolveToken(marketUrl)! });
    await declareMarketKinds(admin);

    const agent = "agent:mcpbuyer";
    const def = await admin.createAgentDefinition(agent, requesterGrants(agent) as { principal: string; kind: string; operations: string[] }[]);
    mcp = new Adapter({ ...env, RADIA_DEFINITION_TOKEN: def.definitionToken }, PORT + 1);

    // The model opens the auction with a plain put, because that is all opening one is: a record
    // whose availableAt is its own close. No tool for it, and none needed now that the field exists.
    const closesAt = new Date(Date.now() + 1200).toISOString();
    const opened = JSON.parse(await mcp.call("space_put", {
      kind: "request",
      body: { topic: "translate", closesAt },
      availableAt: closesAt,
    }));
    assert(opened.id, JSON.stringify(opened));

    for (const [bidder, price] of [["agent:x", 40], ["agent:y", 15], ["agent:z", 25]] as const) {
      await admin.put({ kind: "bid", body: { request: opened.id, bidder, price }, parentIds: [opened.id] });
    }

    // Awarding before the close is refused, and the refusal is a sentence rather than a stack.
    const early = await mcp.call("space_award", { request: opened.id, bid: "x" });
    assert(early.includes("no bid") || early.includes("not awarded"), early);

    await new Promise((r) => setTimeout(r, 1300));

    // The fold: every bid, and the model picks. A late bid is reported rather than silently dropped.
    await admin.put({ kind: "bid", body: { request: opened.id, bidder: "agent:late", price: 1 }, parentIds: [opened.id] });
    const listed = JSON.parse(await mcp.call("space_auction_bids", { request: opened.id, closesAt }));
    assertEquals(listed.count, 3, JSON.stringify(listed).slice(0, 300));
    assert(JSON.stringify(listed.notes ?? []).includes("held over"), JSON.stringify(listed.notes));

    const cheapest = listed.bids.slice().sort((a: { body: { price: number } }, b: { body: { price: number } }) => a.body.price - b.body.price)[0];
    assertEquals(cheapest.body.bidder, "agent:y");

    const awarded = JSON.parse(await mcp.call("space_award", {
      request: opened.id,
      bid: cheapest.id,
      body: { title: "translate it" },
    }));
    assertEquals(awarded.status, "ok", JSON.stringify(awarded));
    assertEquals(awarded.winner, "agent:y");

    // One step: the request is consumed and the work names both the auction and the bid.
    assertEquals((await admin.getEnvelope(opened.id))!.state, "consumed");
    const task = (await admin.getRecord<{ assignee: string; request: string }>(awarded.resultId))!;
    assertEquals(task.body.assignee, "agent:y");
    assertEquals(task.body.request, opened.id);
    assert(task.runtimeMeta.parentIds.includes(cheapest.id), "the winning bid is a parent of the award");

    // And the right to award is spent, so a second attempt is refused rather than assigning twice.
    const again = await mcp.call("space_award", { request: opened.id, bid: cheapest.id });
    assert(again.includes("not awarded"), again);
  } finally {
    await mcp?.close();
    try {
      space.kill();
      await space.status;
    } catch { /* already gone */ }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
