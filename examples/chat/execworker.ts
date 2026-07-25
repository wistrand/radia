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
// Roots the sandboxed program may READ, given by the launcher (repeatable `--dir`). Empty = no
// filesystem, which is the default. Deliberately a SEPARATE setting from the file tools' roots:
// widening what `read_file` can see must not silently widen what executed code can see.
function argAll(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < Deno.args.length; i++) if (Deno.args[i] === name) out.push(Deno.args[i + 1]);
  return out;
}
const readRoots = argAll("--dir").filter(Boolean);
// Denied even if a root would otherwise cover them: the space's blob key and its operator
// credential. `--deny-read` beats `--allow-read`, so pointing `--dir` at a directory containing
// them still does not expose them.
const denyRead = argAll("--deny-dir").filter(Boolean);
const client = new RadiaClient(url, token ? { token } : {});

/** Stdout longer than this is stored rather than inlined: a large payload in a `tool_result` lands
 *  in the message thread and is re-sent on every later turn. The reference costs ~40 characters. */
const INLINE_MAX = 4096;

// The description is the documentation: the model learns the dialect and the limits from here,
// never from the chat's system prompt. Saying what is DENIED matters as much as what is allowed —
// a model that knows there is no network will not waste a turn discovering it.
const RUN_CODE: ToolDef = {
  type: "function",
  function: {
    name: "run_code",
    description:
      `Run JavaScript in a sandbox and get its output back. Use it for calculation, parsing, ` +
      `data transformation, generating file content, and checking your own reasoning — anything ` +
      `where running beats guessing. Print results with console.log; stdout is what you get back. ` +
      `Pass save_as to STORE stdout as an artifact instead of only returning it — that is how you ` +
      `save a file (SVG, JSON, CSV, Markdown, code) for the user: write the content with ` +
      `console.log and give save_as a filename. For binary formats, print base64 and set ` +
      `encoding:"base64". Output larger than ${INLINE_MAX} characters is stored as an artifact ` +
      `automatically and you get a preview plus its id. The sandbox has NO network, NO filesystem, ` +
      `NO environment variables and cannot start processes, so do not attempt ` +
      `fetch/Deno.env — they fail. ` +
      (readRoots.length
        ? `It CAN read files under: ${readRoots.join(", ")} (read-only, with Deno.readTextFileSync/` +
          `Deno.readDirSync); anything outside those paths is denied. `
        : `It has NO filesystem access either. `) +
      `It cannot see the conversation or the space: pass any other data you need INSIDE the code ` +
      `as literals. Modern JS is available (no ` +
      `imports, no npm). Runs for at most ${Math.round(timeoutMs / 1000)}s, so avoid unbounded ` +
      `loops. Returns {ok, stdout, stderr, exitCode, timedOut, ms} plus {artifactId, mediaType, ` +
      `size} when something was stored.`,
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "The JavaScript program. Use console.log to return anything." },
        save_as: { type: "string", description: "Filename to store stdout under as an artifact, e.g. 'koala.svg'. The media type is taken from the extension unless media_type says otherwise." },
        media_type: { type: "string", description: "Override the stored artifact's media type, e.g. 'text/csv'." },
        encoding: { type: "string", enum: ["utf8", "base64"], description: "How stdout encodes the artifact's bytes. Use 'base64' for binary formats (PNG, zip)." },
      },
      required: ["code"],
    },
  },
};

/** Media type from a filename, for the common things code writes. Unknown extensions stay
 *  text/plain — the server validates the type, and anything scriptable downloads rather than
 *  rendering inline (see design-data-model §2.4). */
function mediaTypeFor(filename: string | undefined): string {
  const ext = (filename ?? "").toLowerCase().split(".").pop() ?? "";
  return ({
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    json: "application/json",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    md: "text/markdown",
    txt: "text/plain",
    html: "text/html",
    js: "text/javascript",
    ts: "text/plain",
    xml: "application/xml",
    pdf: "application/pdf",
    zip: "application/zip",
  } as Record<string, string>)[ext] ?? "text/plain";
}

function toBytes(text: string, encoding: string | undefined): Uint8Array {
  if (encoding !== "base64") return new TextEncoder().encode(text);
  const binary = atob(text.trim().replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

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
    const r = await runCode(code, { timeoutMs, readRoots, denyRead });

    // Store stdout when asked to, or when it is too big to belong in the thread. The bytes come
    // from the SANDBOX, not from the model's tokens: content generated by code never round-trips
    // through the context to be saved.
    const args = b.args as { save_as?: string; media_type?: string; encoding?: string } | undefined;
    const wantSave = Boolean(args?.save_as);
    let stored: { artifactId: string; mediaType: string; size: number } | undefined;
    if (r.stdout.length > 0 && (wantSave || r.stdout.length > INLINE_MAX)) {
      try {
        const mediaType = args?.media_type ?? mediaTypeFor(args?.save_as);
        const a = await c.putArtifact(toBytes(r.stdout, args?.encoding), {
          mediaType,
          filename: args?.save_as,
          parentIds: [callId], // lineage: conversation -> tool_call -> artifact
          taint: true, // bytes produced by model-written code
        });
        stored = { artifactId: a.id, mediaType, size: a.size };
      } catch (e) {
        // Storing is best-effort: a bad media type or an oversized payload must not swallow the
        // output the model actually asked for.
        stored = undefined;
        r.stderr += `\n[artifact not stored: ${e}]`;
      }
    }

    return {
      kind: "tool_result",
      body: {
        callId,
        ok: r.ok,
        output: {
          // When it was stored, send a preview rather than the payload: the artifact is the copy.
          stdout: stored ? r.stdout.slice(0, 400) + (r.stdout.length > 400 ? " …[stored as artifact]" : "") : r.stdout,
          stderr: r.stderr,
          exitCode: r.exitCode,
          timedOut: r.timedOut,
          truncated: r.truncated,
          ms: r.ms,
          ...(stored ?? {}),
        },
      },
      taint: true, // executed-code output is untrusted by construction
    };
  },
});
