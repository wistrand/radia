// The tool-worker harness (`extensions/ts/tool-worker.ts`).
//
//   deno task extensions
//
// The cases are about the ENVELOPE, because that is what this exists to stop being copied: a reply
// missing `callId` leaves the caller waiting out its deadline for an answer that already exists, and
// the field was hand-written at sixteen sites before this. Plus the two behaviours a tool worker
// must have: a failure is an ANSWER rather than a nack, and one pattern per tool name rather than
// the kind wholesale.

import { assert, assertEquals } from "@std/assert";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../../examples/operator.ts";
import { CAPABILITY_KIND, type ToolDef } from "../ts/capability.ts";
import { PROGRESS_KIND } from "../ts/progress.ts";
import { answer, serveTools, toolResult } from "../ts/tool-worker.ts";
import { parseArgs } from "../ts/turn.ts";

const PORT = 7827;
const url = `http://127.0.0.1:${PORT}`;

const def = (name: string): ToolDef => ({
  type: "function",
  function: { name, description: `the ${name} tool`, parameters: { type: "object", properties: {} } },
});

async function withSpace<T>(fn: (c: RadiaClient) => Promise<T>): Promise<T> {
  const space = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  const probe = new RadiaClient(url);
  for (let i = 0; i < 100; i++) {
    try {
      await probe.health();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const c = new RadiaClient(url, { token: operatorToken(url) });
  await c.registerKind(CAPABILITY_KIND);
  await c.registerKind(PROGRESS_KIND);
  await c.registerKind({
    kind: "tool_call",
    indexedPaths: [{ path: "tool", type: "keyword" }, { path: "conversationId", type: "keyword" }],
  });
  await c.registerKind({
    kind: "tool_result",
    indexedPaths: [{ path: "callId", type: "keyword" }],
    claimable: false,
  });
  try {
    return await fn(c);
  } finally {
    space.kill("SIGTERM");
    await space.status;
  }
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
