// Code-execution worker. Claims `tool_call{tool:"run_code"}` and runs the model's program in a
// permissionless subprocess (sandbox.ts), then acks the output as a TAINTED `tool_result`.
//
// Three processes, three blast radii — the worker never executes, the executor never holds
// anything:
//
//   execworker.ts   run token + space access + --allow-run     claims work, acks results
//     └── deno run -   NO permissions, program on stdin        the actual execution
//
// This is why it is a separate worker rather than a tool in `toolworker.ts`: spawning needs
// `--allow-run` (which that process deliberately lacks), and it holds a run token that model-written
// code must never reach. Code running inside a process with a credential could `put`/`take` records
// as that agent — the local space is a more attractive target than the internet.
//
// The result is TAINTED, always. Output of model-written code operating on possibly-injected input
// is untrusted by construction, and taint is exactly the machinery for that: it propagates through
// `ack`, and a sensitive consumer can refuse it with `requireUntainted`. Clearing it needs a
// privileged declassify.
//
// A note on retries: `tool_call` is claimable work, so a lease that expires is retried. That is
// only sound because the sandbox has no side effects to double — a permissionless child cannot
// write, post, or spend. Granting the sandbox any capability would break the at-least-once
// guarantee as well as the security story.

import { agentLoop } from "../../sdk/ts/loop.ts";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { runCode } from "./sandbox.ts";
import { progress } from "./progress.ts";
import type { ToolDef } from "./openrouter.ts";

const ME = "agent:chat-exec";

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

const url = arg("--url") ?? "http://127.0.0.1:7788";
const token = arg("--token"); // agent:chat-exec run token
const timeoutMs = Number(arg("--timeout-ms") ?? "5000");
const client = new RadiaClient(url, token ? { token } : {});

// The description is the documentation: the model learns the dialect and the limits from here,
// never from the chat's system prompt. Saying what is DENIED matters as much as what is allowed —
// a model that knows there is no network will not waste a turn discovering it.
const RUN_CODE: ToolDef = {
  type: "function",
  function: {
    name: "run_code",
    description:
      `Run JavaScript in a sandbox and get its output back. Use it for calculation, parsing, ` +
      `data transformation, and checking your own reasoning — anything where running beats ` +
      `guessing. Print results with console.log; stdout is what you get back (capped, and ` +
      `truncated if huge). The sandbox has NO network, NO filesystem, NO environment variables ` +
      `and cannot start processes, so do not attempt fetch/Deno.readTextFile/Deno.env — they fail. ` +
      `It cannot see the conversation or the space either: pass any data you need INSIDE the code ` +
      `as literals. Modern JS is available (no imports, no npm). Runs for at most ${Math.round(timeoutMs / 1000)}s, ` +
      `so avoid unbounded loops. Returns {ok, stdout, stderr, exitCode, timedOut, ms}.`,
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "The JavaScript program. Use console.log to return anything." },
      },
      required: ["code"],
    },
  },
};

async function defHash(def: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(def)));
  return [...new Uint8Array(bytes)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
await client.put({ kind: "capability", body: { tool: "run_code", def: RUN_CODE } }, `capability:run_code:${await defHash(RUN_CODE)}`);

await agentLoop(client, {
  name: "exec",
  templates: [{ kind: "tool_call", match: { tool: "run_code" } }],
  leaseSeconds: 60,
  handle: async (rec, c) => {
    const callId = rec.id;
    const b = rec.body as { args?: { code?: string }; conversationId?: string };
    const code = String(b.args?.code ?? "");
    // The source is already in the tool_call record, so every program the model ever ran is
    // auditable by query — `{kind: tool_call, tool: "run_code"}` is the execution log, with the
    // result and any artifact as its children.
    await progress(c, { conversationId: b.conversationId, callId, stage: "executing", by: ME, note: `${code.length} chars` }, [callId]);
    if (!code.trim()) {
      return { kind: "tool_result", body: { callId, ok: false, output: "run_code needs a `code` argument" }, taint: true };
    }
    const r = await runCode(code, { timeoutMs });
    return {
      kind: "tool_result",
      body: {
        callId,
        ok: r.ok,
        output: {
          stdout: r.stdout,
          stderr: r.stderr,
          exitCode: r.exitCode,
          timedOut: r.timedOut,
          truncated: r.truncated,
          ms: r.ms,
        },
      },
      taint: true, // executed-code output is untrusted by construction
    };
  },
});
