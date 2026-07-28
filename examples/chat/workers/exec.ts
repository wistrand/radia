// Code-execution worker. Claims `tool_call{tool:"run_code"}` and runs the model's program in a
// permissionless subprocess (tools/exec-sandbox.ts), then acks the output as a TAINTED `tool_result`.
//
// Three processes, three blast radii. The worker never executes, the executor never holds
// anything:
//
//   workers/exec.ts   run token + space access + --allow-run   claims work, acks results
//     └── deno run -    NO permissions, program on stdin       the actual execution (tools/exec-sandbox.ts)
//
// This is why it is a separate worker rather than a tool in `workers/tools.ts`: spawning needs
// `--allow-run` (which that process deliberately lacks), and it holds a run token that model-written
// code must never reach. Code running inside a process with a credential could `put`/`take` records
// as that agent; the local space is a more attractive target than the internet.
//
// The result is TAINTED, always. Output of model-written code operating on possibly-injected input
// is untrusted by construction, and taint is exactly the machinery for that: it propagates through
// `ack`, and a sensitive consumer can refuse it with `requireUntainted`. Clearing it needs a
// privileged declassify.
//
// A note on retries: `tool_call` is claimable work, so a lease that expires is retried. That is
// only sound because the sandbox has no side effects to double: a permissionless child cannot
// write, post, or spend. Granting the sandbox any capability would break the at-least-once
// guarantee as well as the security story.

import { agentLoop } from "../../../sdk/ts/loop.ts";
import { activeByKey, newestByKey, RadiaClient, type RadiaRecord } from "../../../sdk/ts/client.ts";
import { runCode } from "../tools/exec-sandbox.ts";
import { progress } from "../space/progress.ts";
import { arg, argAll } from "../util.ts";
import { publishCapability } from "../space/capability.ts";
import { bytesFrom, mediaTypeFor } from "../util.ts";
import type { ToolDef } from "../provider/openrouter.ts";

const ME = "agent:chat-exec";


const url = arg("--url") ?? "http://127.0.0.1:7788";
const token = arg("--token"); // agent:chat-exec run token
const timeoutMs = Number(arg("--timeout-ms") ?? "5000");
// Roots the sandboxed program may READ, given by the launcher (repeatable `--dir`). Empty = no
// filesystem, which is the default. Deliberately a SEPARATE setting from the file tools' roots:
// widening what `read_file` can see must not silently widen what executed code can see.
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
// never from the chat's system prompt. Saying what is DENIED matters as much as what is allowed.
// A model that knows there is no network will not waste a turn discovering it.
const RUN_CODE: ToolDef = {
  type: "function",
  function: {
    name: "run_code",
    description:
      `Run JavaScript in a sandbox and get its output back. Use it for calculation, parsing, ` +
      `data transformation, generating file content, and checking your own reasoning (anything ` +
      `where running beats guessing). Print results with console.log; stdout is what you get back. ` +
      `Pass save_as to STORE stdout as an artifact instead of only returning it. That is how you ` +
      `save a file (SVG, JSON, CSV, Markdown, code) for the user: write the content with ` +
      `console.log and give save_as a filename. For binary formats, print base64 and set ` +
      `encoding:"base64". Output larger than ${INLINE_MAX} characters is stored as an artifact ` +
      `automatically and you get a preview plus its id. The sandbox has NO network, NO filesystem, ` +
      `NO environment variables and cannot start processes, so do not attempt ` +
      `fetch/Deno.env; they fail. ` +
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

const SAVE_PROCEDURE: ToolDef = {
  type: "function",
  function: {
    name: "save_procedure",
    description:
      "Save a program under a NAME so it can be run again later without you re-typing it. The " +
      "saved procedure becomes one of your tools in this conversation: call it by name, and the " +
      "object you pass is available inside the code as `args`. Use this when you have written " +
      "code you expect to run more than once: a calculation you will repeat with different " +
      "inputs, a parser, a checker. Saving costs one call; re-pasting the same program every " +
      "time costs its full length in every message that follows. The code runs in the SAME " +
      "sandbox as run_code, with the same limits. Re-saving the same name replaces it. Returns " +
      "{name, artifactId, size}.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tool name to save it under: lowercase letters, digits and underscores, e.g. 'hash_text'." },
        description: { type: "string", description: "What it does and what `args` it expects. This becomes the tool description you will see later, so write it for your future self." },
        code: { type: "string", description: "The JavaScript program. Read inputs from the `args` object; print results with console.log." },
        parameters: { type: "object", description: "Optional JSON Schema for `args`, same shape as any tool's parameters. Omit for a procedure that takes no input." },
      },
      required: ["name", "description", "code"],
    },
  },
};

const READ_PROCEDURE: ToolDef = {
  type: "function",
  function: {
    name: "read_procedure",
    description:
      "Read back the source of a procedure you saved earlier. Use this BEFORE changing one: the " +
      "code is not in your context once the turn that wrote it has scrolled away, and rewriting " +
      "from memory risks losing behaviour you had already got right. To fix or extend a " +
      "procedure, read it, edit the text, and save_procedure under the SAME name, which replaces " +
      "it. Returns {name, description, code, versions}, where versions counts how many times it " +
      "has been saved.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "The saved procedure's name." } },
      required: ["name"],
    },
  },
};

const RETIRE_PROCEDURE: ToolDef = {
  type: "function",
  function: {
    name: "retire_procedure",
    description:
      "Stop offering a procedure you saved. Use it when one turned out to be wrong, was a bad " +
      "idea, or is no longer worth its place in your tool list. Every tool you carry costs " +
      "tokens on every request, so a procedure you will not call again is worth retiring. This " +
      "does not erase anything: the code stays readable with read_procedure and saving the same " +
      "name again brings it back. Returns {name, retired}.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The saved procedure's name." },
        reason: { type: "string", description: "Optional note on why, kept with the record." },
      },
      required: ["name"],
    },
  },
};

await publishCapability(client, RUN_CODE);
await publishCapability(client, SAVE_PROCEDURE);
await publishCapability(client, READ_PROCEDURE);
await publishCapability(client, RETIRE_PROCEDURE);

// EVERYTHING the handler reads must be declared above `agentLoop`, which never returns: a `const`
// placed after it is never evaluated, so it stays in the temporal dead zone for the life of the
// process and the first handler that touches it throws `Cannot access '<name>' before
// initialization` (silently, since a handler that throws just nacks and retries).

/** This worker's own tools. A fallback for the check below, for the moment before capabilities
 *  have been read (or if this run has no grant to read them). */
const RESERVED = new Set(["run_code", "save_procedure", "read_procedure", "retire_procedure"]);

/**
 * Tool names a procedure must not take: every tool ANY worker advertises, discovered rather than
 * listed.
 *
 * A hardcoded list would only ever cover this worker's own tools, and the names that matter most
 * belong to others: `read_file`, `generate_image`, `save_content`, `space_query`. Letting a
 * procedure take one of those is not a naming annoyance, it is a HIJACK. This worker would add a
 * claim pattern for `tool_call{tool:"read_file"}` alongside the tools-worker's, both would race
 * for each call, and whichever claimed first would answer. The model would meanwhile see the real
 * tool's description in its list, because the chat prefers a capability over a procedure of the
 * same name. Wrong behaviour, non-deterministically, invisibly.
 */
async function capabilityNames(c: RadiaClient): Promise<Set<string>> {
  try {
    const caps = await c.queryAll({ kind: "capability" });
    return new Set([...activeByKey<{ tool?: string }>(caps, (b) => b?.tool).keys()]);
  } catch {
    return RESERVED; // no grant to read capabilities: fall back to what this worker knows it serves
  }
}

/** A tool name that is safe to advertise and to match a claim pattern on. */
const NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;

// The claim patterns, MUTABLE on purpose. `agentLoop` re-reads this array on every pass, so
// appending to it is how this worker starts serving a procedure the assistant saved a moment ago,
// without a restart and without claiming `tool_call` wholesale (which would steal other workers'
// work). Every procedure the space already holds is added at startup; new ones arrive on the watch
// below. Dispatch stays content-routed: one pattern per tool name, exactly like a built-in tool.
const patterns = [
  { kind: "tool_call", match: { tool: "run_code" } },
  { kind: "tool_call", match: { tool: "save_procedure" } },
  { kind: "tool_call", match: { tool: "read_procedure" } },
  { kind: "tool_call", match: { tool: "retire_procedure" } },
];
const served = new Set<string>();

async function adoptProcedures(): Promise<void> {
  try {
    const builtin = await capabilityNames(client);
    for (const rec of await client.queryAll({ kind: "procedure" })) {
      const name = String((rec.body as { name?: string }).name ?? "");
      // Never claim a name a worker serves: that is the race described on `capabilityNames`. A
      // procedure saved before that worker published simply stops being claimed here.
      if (!NAME_RE.test(name) || served.has(name) || builtin.has(name)) continue;
      served.add(name);
      patterns.push({ kind: "tool_call", match: { tool: name } });
    }
  } catch { /* no grant to read procedures: this worker simply serves the built-ins */ }
}
await adoptProcedures();
(async () => {
  try {
    for await (const _ of client.watch({ kind: "procedure" })) await adoptProcedures();
  } catch { /* watch unavailable: adopted at startup, and a restart picks up the rest */ }
})();

/**
 * The procedure a call is asking for, or a refusal.
 *
 * The conversation check is a BOUNDARY, not a filter. The chat only offers a procedure to the
 * conversation that wrote it, but "not offered" is not "not callable". A model can name any tool
 * it likes, and a tool_call is just a record anyone may write. So the scope is enforced here,
 * where the code would actually run.
 */
async function lookupProcedure(c: RadiaClient, name: string, conversationId?: string) {
  const rows = await c.query({ kind: "procedure", match: { name, conversationId: conversationId ?? "" } }, 50);
  // `newestByKey`, not `activeByKey`: this caller must SEE a retirement to report it, where the
  // chat's tool list wants it already filtered out. Same projection, two needs.
  const latest = newestByKey<{ name?: string }>(rows, (b) => b?.name).get(name);
  if (!latest) return null;
  // The RECORD, not just its body: a caller has to be able to name the exact version it used.
  // Re-saving a name is a successor, so "the procedure called X" is not a stable referent; only
  // a record id is.
  return { id: latest.id, ...(latest.body as { name: string; artifactId: string; description?: string; retired?: boolean }) };
}

await agentLoop(client, {
  name: "exec",
  patterns,
  leaseSeconds: 60,
  handle: async (rec, c) => {
    const callId = rec.id;
    const b = rec.body as { tool?: string; args?: { code?: string }; conversationId?: string; owner?: string };

    if (b.tool === "save_procedure") return await saveProcedure(rec, c);
    if (b.tool === "read_procedure") return await readProcedure(rec, c);
    if (b.tool === "retire_procedure") return await retireProcedure(rec, c);

    // A named procedure: the code comes from the artifact it was saved as, and the call's own
    // arguments are handed to it as `args`.
    //
    // PROVENANCE. For `run_code` the program is in the tool_call body, so "what exactly ran" is a
    // query. A procedure call carries only {tool, args}, and the code lives elsewhere and can be
    // re-saved, so without this the result could never be attributed to the version that produced
    // it. `provenance` becomes a parent link plus a body field on the result below.
    let provenance: { name: string; recordId: string; artifactId: string } | undefined;
    let code = String(b.args?.code ?? "");
    if (b.tool && b.tool !== "run_code") {
      // Checked at execution too, not just at save: a worker may have started serving this name
      // since. The real tool wins: this worker refuses rather than answering for it.
      if ((await capabilityNames(c)).has(b.tool)) {
        return {
          kind: "tool_result",
          body: { callId, conversationId: b.conversationId, owner: b.owner, ok: false, output: `'${b.tool}' is served by a worker, not by a saved procedure` },
          taint: true,
        };
      }
      const proc = await lookupProcedure(c, b.tool, b.conversationId);
      if (!proc || proc.retired) {
        // A retired name is still claimed on purpose, so this answers at once instead of leaving
        // the caller to wait out the tool deadline. Saving the name again un-retires it.
        const why = proc?.retired
          ? `procedure '${b.tool}' has been retired; save it again to bring it back`
          : `no procedure '${b.tool}' saved in this conversation`;
        return { kind: "tool_result", body: { callId, conversationId: b.conversationId, owner: b.owner, ok: false, output: why }, taint: true };
      }
      provenance = { name: proc.name, recordId: proc.id, artifactId: proc.artifactId };
      const source = new TextDecoder().decode(await c.getArtifact(proc.artifactId));
      // `args` is injected as a literal rather than passed on argv: the sandbox takes its program
      // on stdin and has no environment, and a JSON literal is the one channel that needs no
      // permission. JSON.stringify also means the model's arguments arrive as DATA. They are
      // never concatenated into executable positions.
      code = `const args = ${JSON.stringify(b.args ?? {})};\n${source}`;
    }
    // The source is already in the tool_call record, so every program the model ever ran is
    // auditable by query: `{kind: tool_call, tool: "run_code"}` is the execution log, with the
    // result and any artifact as its children.
    await progress(c, { conversationId: b.conversationId, owner: b.owner, callId, stage: "executing", by: ME, note: `${code.length} chars` }, [callId]);
    if (!code.trim()) {
      return { kind: "tool_result", body: { callId, conversationId: b.conversationId, owner: b.owner, ok: false, output: "run_code needs a `code` argument" }, taint: true };
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
        const a = await c.putArtifact(bytesFrom(r.stdout, args?.encoding), {
          mediaType,
          filename: args?.save_as,
          parentIds: [callId], // lineage: conversation -> tool_call -> artifact
          taint: true, // bytes produced by model-written code
          meta: { conversationId: b.conversationId ?? "", owner: b.owner ?? "" }, // what a grant pattern can bind
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
        conversationId: b.conversationId, owner: b.owner,
        ok: r.ok,
        // Recorded on the RECORD, deliberately not inside `output`: only `output` is serialized
        // back into the model's thread, so provenance is auditable by query without spending
        // context tokens on every call.
        ...(provenance ? { procedure: provenance } : {}),
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
      // The procedure record becomes a PARENT of the result, so "which code produced this?" is a
      // lineage walk rather than a guess. That is the question a model answered wrong from memory,
      // and then invented a reason for. The claimed tool_call is added as a parent by `ack`.
      ...(provenance ? { parentIds: [provenance.recordId] } : {}),
      taint: true, // executed-code output is untrusted by construction
    };
  },
});

/**
 * Store a named program: the code becomes an artifact, the name becomes a `procedure` record.
 *
 * The write is content-keyed the same way `capability` and `kind_def` are (an identical re-save
 * dedups, a changed one is a successor and latest wins), so "save it again under the same name"
 * is an update, never a 409.
 */
async function saveProcedure(rec: RadiaRecord, c: RadiaClient) {
  const callId = rec.id;
  const b = rec.body as { args?: Record<string, unknown>; conversationId?: string; owner?: string };
  const a = b.args ?? {};
  const name = String(a.name ?? "");
  const description = String(a.description ?? "");
  const code = String(a.code ?? "");
  const fail = (output: string) => ({ kind: "tool_result", body: { callId, conversationId: b.conversationId, owner: b.owner, ok: false, output }, taint: true });

  if (!NAME_RE.test(name)) return fail("`name` must be lowercase letters, digits and underscores, starting with a letter");
  if ((await capabilityNames(c)).has(name)) return fail(`'${name}' is already a tool served by a worker; choose another name`);
  if (!code.trim()) return fail("save_procedure needs a `code` argument");
  if (!description.trim()) return fail("save_procedure needs a `description`: it is what you will read when deciding to call it later");
  if (!b.conversationId) return fail("save_procedure needs a conversation to belong to");

  await progress(c, { conversationId: b.conversationId, owner: b.owner, callId, stage: "saving", by: ME, note: name }, [callId]);
  const art = await c.putArtifact(new TextEncoder().encode(code), {
    mediaType: "text/javascript",
    filename: `${name}.js`,
    parentIds: [callId],
    taint: true, // model-written source, like any other bytes it produced
    meta: { conversationId: b.conversationId ?? "", owner: b.owner ?? "" }, // what a grant pattern can bind
  });
  const key = await shortHash(`${description}\n${code}`);
  await c.put({
    kind: "procedure",
    body: {
      name,
      description,
      parameters: a.parameters ?? { type: "object", properties: {} },
      artifactId: art.id,
      conversationId: b.conversationId, owner: b.owner,
    },
    parentIds: [callId],
  }, `procedure:${b.conversationId}:${name}:${key}`);

  // Serve it immediately rather than waiting for the watch to come round: the model may well call
  // what it just saved on the very next turn.
  if (!served.has(name)) {
    served.add(name);
    patterns.push({ kind: "tool_call", match: { tool: name } });
  }
  // Say so when it takes no input. A procedure saved without `parameters` can only ever do the one
  // thing its literals encode, which is easy to write by accident and expensive to discover three
  // turns later, when the model reaches for it with an argument and finds it ignores them. The
  // feedback belongs here, at the moment it can still be acted on, not in the description (which is
  // read before the code is written, when the limitation is not yet visible).
  const schema = a.parameters as { properties?: Record<string, unknown> } | undefined;
  const takesInput = Boolean(schema?.properties && Object.keys(schema.properties).length > 0);
  const usesArgs = /\bargs\b/.test(code);
  const note = takesInput
    ? undefined
    : usesArgs
    ? "saved with no `parameters` schema, but the code reads `args`, so callers will not know what to pass"
    : "saved with no `parameters`: it takes no input and will do the same thing on every call";
  return {
    kind: "tool_result",
    body: {
      callId,
      conversationId: b.conversationId, owner: b.owner,
      ok: true,
      output: { name, artifactId: art.id, size: art.size, saved: true, ...(note ? { note } : {}) },
    },
  };
}

/**
 * Hand back a saved procedure's source, so it can be edited rather than rewritten from memory.
 *
 * This is what makes a saved procedure maintainable instead of write-once: the code leaves the
 * model's context as soon as the turn that wrote it scrolls out of the window, and without a way
 * to read it back, "fix the bug in X" means reconstructing X from its description and hoping.
 * Every version is still on the space (records are immutable, so a re-save is a successor, not an
 * overwrite), which is why this also reports how many there have been.
 */
async function readProcedure(rec: RadiaRecord, c: RadiaClient) {
  const callId = rec.id;
  const b = rec.body as { args?: { name?: string }; conversationId?: string; owner?: string };
  const name = String(b.args?.name ?? "");
  if (!name) {
    return { kind: "tool_result", body: { callId, conversationId: b.conversationId, owner: b.owner, ok: false, output: "read_procedure needs a `name`" }, taint: true };
  }
  const rows = await c.query({ kind: "procedure", match: { name, conversationId: b.conversationId ?? "" } }, 50);
  if (rows.length === 0) {
    return {
      kind: "tool_result",
      body: { callId, conversationId: b.conversationId, owner: b.owner, ok: false, output: `no procedure '${name}' saved in this conversation` },
      taint: true,
    };
  }
  const latest = newestByKey<{ name?: string }>(rows, (bb) => bb?.name).get(name)!;
  const body = latest.body as { name: string; description: string; artifactId: string };
  const code = new TextDecoder().decode(await c.getArtifact(body.artifactId));
  return {
    kind: "tool_result",
    body: {
      callId,
      conversationId: b.conversationId, owner: b.owner,
      ok: true,
      output: { name: body.name, description: body.description, code, versions: rows.length },
    },
    taint: true, // it is model-written source coming back out
  };
}

/**
 * Retire a procedure: stop offering it, without erasing it.
 *
 * Records are immutable, so this is a SUCCESSOR carrying `retired: true`: the same latest-wins
 * rule that makes re-saving a name an update. Nothing is deleted, which is the point: the code
 * stays readable, the history stays intact, and saving the name again simply writes a newer record
 * that is not retired. A delete would also be the wrong shape for a space where every earlier
 * version of the procedure is still referenced by the tool_calls that ran it.
 */
async function retireProcedure(rec: RadiaRecord, c: RadiaClient) {
  const callId = rec.id;
  const b = rec.body as { args?: { name?: string; reason?: string }; conversationId?: string; owner?: string };
  const name = String(b.args?.name ?? "");
  const fail = (output: string) => ({ kind: "tool_result", body: { callId, conversationId: b.conversationId, owner: b.owner, ok: false, output }, taint: true });
  if (!name) return fail("retire_procedure needs a `name`");

  const current = await lookupProcedure(c, name, b.conversationId);
  if (!current) return fail(`no procedure '${name}' saved in this conversation`);
  if (current.retired) return fail(`'${name}' is already retired`);

  await c.put({
    kind: "procedure",
    body: { ...current, retired: true, retiredReason: b.args?.reason ?? null },
    parentIds: [callId],
  }, `procedure:${b.conversationId}:${name}:retired:${await shortHash(String(b.args?.reason ?? ""))}`);

  // The claim pattern deliberately STAYS. Two reasons, and the second is the critical one:
  // a retired name that is still claimed answers "it has been retired" immediately, where an
  // unclaimed one would leave the caller waiting out the tool deadline for a stall diagnosis; and
  // this handler runs INSIDE agentLoop's iteration over `patterns`, so splicing it here would
  // mutate the array being walked. The chat stops OFFERING the tool, which is what actually
  // removes it from the model's context.
  return { kind: "tool_result", body: { callId, conversationId: b.conversationId, owner: b.owner, ok: true, output: { name, retired: true } } };
}

async function shortHash(s: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(bytes)].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
}
