// The tool-worker harness (`extensions/ts/tool-worker.ts`).
//
//   deno task test:extensions
//
// The cases are about the ENVELOPE, because that is what this exists to stop being copied: a reply
// missing `callId` leaves the caller waiting out its deadline for an answer that already exists, and
// the field was hand-written at sixteen sites before this. Plus the two behaviours a tool worker
// must have: a failure is an ANSWER rather than a nack, and one pattern per tool name rather than
// the kind wholesale.

import { assert, assertEquals } from "@std/assert";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { CAPABILITY_KIND, type ToolDef } from "../ts/capability.ts";
import { PROGRESS_KIND } from "../ts/progress.ts";
import { answer, serveTools, toolResult } from "../ts/tool-worker.ts";
import { ENC_V1, encryptText, newFleetKeyPair, openBody, sealConversation } from "../ts/encrypted.ts";
import { parseArgs } from "../ts/turn.ts";
import { bootSpace } from "./space.ts";

const PORT = 7827;

const def = (name: string): ToolDef => ({
  type: "function",
  function: { name, description: `the ${name} tool`, parameters: { type: "object", properties: {} } },
});

const shared = await bootSpace(PORT);
await shared.registerKind(CAPABILITY_KIND);
await shared.registerKind(PROGRESS_KIND);
await shared.registerKind({
  kind: "tool_call",
  indexedPaths: [{ path: "tool", type: "keyword" }, { path: "conversationId", type: "keyword" }],
});
await shared.registerKind({
  kind: "tool_result",
  indexedPaths: [{ path: "callId", type: "keyword" }],
  claimable: false,
});

async function withSpace<T>(fn: (c: RadiaClient) => Promise<T>): Promise<T> {
  return await fn(shared);
}

const awaitOne = async (c: RadiaClient, pattern: { kind: string; match?: Record<string, unknown> }) => {
  for (let i = 0; i < 100; i++) {
    const r = await c.readOne(pattern);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  return null;
};

Deno.test("[tool-worker] the envelope always carries callId, and the answer's shape is one place", () => {
  // A unit case on purpose: this is the field whose absence is invisible at the call site and only
  // shows up as the caller's deadline expiring.
  const b = { tool: "calc", conversationId: "c1", owner: "human:t" };
  const r = toolResult("call1", b, answer({ value: 42 }));
  assertEquals(r.body.callId, "call1");
  assertEquals(r.body.conversationId, "c1");
  assertEquals(r.body.owner, "human:t");
  assertEquals(r.body.ok, true);
  assertEquals(r.kind, "tool_result");
  assertEquals(r.parentIds, undefined, "no parents unless the answer names them");
  assertEquals(r.taint, undefined, "ABSENT is not the same as an empty raise");

  const rich = toolResult("call2", b, answer("x", { ok: false, parentIds: ["a1"], taint: [], meta: { procedure: "p1" } }));
  assertEquals(rich.body.ok, false);
  assertEquals(rich.parentIds, ["a1"]);
  assertEquals(rich.taint, [], "an explicit empty raise is preserved");
  assertEquals(rich.body.procedure, "p1", "meta lands on the record, beside output rather than inside it");
});

Deno.test("[tool-worker] a long argument that switches to raw newlines is repaired, not lost", () => {
  // The live shape: correctly escaped for thousands of characters, then raw. Structurally complete
  // JSON, so nothing downstream notices except `JSON.parse`.
  const raw = `{"workspace":"ws","edits":[{"path":"a.js","replacement":"good\\nlines\\nhere\nthen raw\nones"}]}`;
  const args = parseArgs(raw);
  assertEquals(args._unparsed, undefined, "an unambiguous lexical error must not cost the turn");
  const edit = (args.edits as { replacement: string }[])[0];
  assertEquals(edit.replacement, "good\nlines\nhere\nthen raw\nones", "both halves decode to the same thing");

  // A control character OUTSIDE a string is legal whitespace and must survive untouched.
  assertEquals(parseArgs('{"a":\n1}').a, 1);
  // A quote that is itself escaped must not be read as ending the string; if it were, the repair
  // would treat the rest of the payload as being outside a string and leave its newlines raw.
  assertEquals(parseArgs('{"a":"say \\" then\nmore"}').a, 'say " then\nmore');
  assertEquals(parseArgs("").constructor, Object, "no arguments is an empty object, not a failure");

  // Truly broken: the REASON travels, because the refusal is built from it.
  const hopeless = parseArgs('{"workspace":"ws",');
  assertEquals(hopeless._unparsed, '{"workspace":"ws",');
  assert(typeof hopeless._parseError === "string" && hopeless._parseError.length > 0);
});

Deno.test("[tool-worker] unparseable arguments are refused as a PARSE error, before the tool runs", async () => {
  await withSpace(async (c) => {
    const stop = new AbortController();
    let ran = 0;
    const serving = serveTools(c, {
      provider: "w1",
      tools: { edit: () => { ran++; return Promise.resolve("ok"); } },
      schemas: [def("edit")],
      signal: stop.signal,
    });
    try {
      // What `parseArgs` produces for a payload it cannot repair. The tool would report the first
      // required field it misses ("needs a `workspace`") for a workspace the model DID send.
      const call = await c.put({
        kind: "tool_call",
        body: { tool: "edit", args: { _unparsed: '{"workspace":"ws",', _parseError: "Unexpected end of JSON input" }, conversationId: "c1" },
      });
      const reply = await awaitOne(c, { kind: "tool_result", match: { callId: call.id } });
      const body = reply?.body as { ok: boolean; output: string };
      assertEquals(body.ok, false);
      assert(body.output.includes("not valid JSON"), body.output);
      assert(body.output.includes("Unexpected end of JSON input"), "the parse error is what makes it actionable");
      assertEquals(ran, 0, "the tool must not see arguments that did not parse");
    } finally {
      stop.abort();
      await serving.catch(() => {});
    }
  });
});

Deno.test("[tool-worker] serves what it advertises, and a THROWN failure is an answer not a nack", async () => {
  await withSpace(async (c) => {
    const stop = new AbortController();
    const serving = serveTools(c, {
      provider: "w1",
      tools: {
        good: (a) => Promise.resolve({ echoed: a.x }),
        bad: () => Promise.reject(new Error("nope")),
      },
      schemas: [def("good"), def("bad")],
      signal: stop.signal,
    });
    try {
      // Advertised, so an agent can discover them.
      const caps = await awaitOne(c, { kind: "capability", match: { tool: "good", provider: "w1" } });
      assert(caps, "each tool is advertised under its provider");

      const ok = await c.put({ kind: "tool_call", body: { tool: "good", args: { x: 7 }, conversationId: "c1" } });
      const okReply = await awaitOne(c, { kind: "tool_result", match: { callId: ok.id } });
      assertEquals((okReply?.body as { ok: boolean; output: { echoed: number } }).output.echoed, 7);

      const bad = await c.put({ kind: "tool_call", body: { tool: "bad", conversationId: "c1" } });
      const badReply = await awaitOne(c, { kind: "tool_result", match: { callId: bad.id } });
      // The whole point: the model sees WHY and can try something else. A nack would retry the same
      // doomed call at cost and tell nobody.
      assertEquals((badReply?.body as { ok: boolean; output: string }).ok, false);
      assertEquals((badReply?.body as { output: string }).output, "nope");
    } finally {
      stop.abort();
      await serving.catch(() => {});
    }
  });
});

Deno.test("[tool-worker] an undecryptable call is ANSWERED, not run and not nacked", async () => {
  await withSpace(async (c) => {
    const stop = new AbortController();
    let ran = 0;
    const serving = serveTools(c, {
      provider: "w1",
      tools: { edit: () => { ran++; return Promise.resolve("ok"); } },
      schemas: [def("edit")],
      signal: stop.signal,
    });
    try {
      // A tool ACTS on its arguments, so ciphertext reaching one writes a file or calls a service
      // with bytes nobody meant (plan-encryption.md phase 1). An ANSWER rather than a nack, because
      // this body will not become decryptable on redelivery: raising would replay it forever.
      const call = await c.put({
        kind: "tool_call",
        body: { tool: "edit", args: { path: "Y2lwaGVy" }, enc: "v1", conversationId: "c1" },
      });
      const reply = await awaitOne(c, { kind: "tool_result", match: { callId: call.id } });
      const body = reply?.body as { ok: boolean; output: string };
      assertEquals(body.ok, false);
      assert(body.output.includes("encrypted"), body.output);
      assert(body.output.includes("tool edit"), "the refusal names the reader");
      assertEquals(ran, 0, "the tool must not see arguments it cannot read");
    } finally {
      stop.abort();
      await serving.catch(() => {});
    }
  });
});

Deno.test("[tool-worker] an encrypted call opens for the tool and seals on the way back", async () => {
  await withSpace(async (c) => {
    const { key } = await sealConversation(await newFleetKeyPair(), []);
    const stop = new AbortController();
    let saw: Record<string, unknown> | undefined;
    const serving = serveTools(c, {
      provider: "w1",
      tools: { edit: (a) => { saw = a; return Promise.resolve({ wrote: a.path }); } },
      schemas: [def("edit")],
      keys: () => Promise.resolve(key),
      signal: stop.signal,
    });
    try {
      // EXACTLY what the turn worker writes for an encrypted conversation: `args` is the model's
      // raw argument string, still sealed, copied from the assistant message without being read
      // (extensions/ts/turn.ts). The marker rides along so this worker knows to open it.
      const call = await c.put({
        kind: "tool_call",
        body: {
          tool: "edit",
          args: await encryptText(key, JSON.stringify({ path: "/secret" })),
          enc: ENC_V1,
          conversationId: "c1",
        },
      });
      const reply = await awaitOne(c, { kind: "tool_result", match: { callId: call.id } });
      assertEquals(saw?.path, "/secret", "the tool ran on PARSED plaintext, not on a blob");

      const body = reply?.body as { enc?: string; output?: unknown };
      assertEquals(body.enc, ENC_V1, "the answer is sealed under the same key");
      assert(!JSON.stringify(body).includes("/secret"), "…so the tool's output does not undo the thread");
      const opened = await openBody(body as Record<string, unknown>, "tool_result", key);
      assertEquals(opened.output, { wrote: "/secret" });
    } finally {
      stop.abort();
      await serving.catch(() => {});
    }
  });
});

Deno.test("[tool-worker] a tool it does not serve is left for whoever does", async () => {
  await withSpace(async (c) => {
    const stop = new AbortController();
    const serving = serveTools(c, {
      provider: "w1",
      tools: { mine: () => Promise.resolve("ok") },
      schemas: [def("mine")],
      signal: stop.signal,
    });
    try {
      const theirs = await c.put({ kind: "tool_call", body: { tool: "not_mine", conversationId: "c1" } });
      await new Promise((r) => setTimeout(r, 1500));
      assertEquals(
        await c.readOne({ kind: "tool_result", match: { callId: theirs.id } }),
        null,
        "claiming `tool_call` wholesale would steal another worker's work",
      );
      const env = await c.queryEnvelopes({ state: "available", limit: 50 });
      assert(env.some((r) => r.record?.id === theirs.id), "and it stays available for them");
    } finally {
      stop.abort();
      await serving.catch(() => {});
    }
  });
});
