// Code-execution worker. Claims `tool_call{tool:"run_javascript"}` and runs the model's program in a
// permissionless subprocess (extensions/ts/sandbox.ts), then acks the output as a TAINTED `tool_result`.
//
// Three processes, three blast radii. The worker never executes, the executor never holds
// anything:
//
//   workers/exec.ts   run token + space access + --allow-run   claims work, acks results
//     └── deno run -    NO permissions, program on stdin       the actual execution (extensions/ts/sandbox.ts)
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
import { dryRunEntrypoint } from "../../../extensions/ts/broker.ts";
import { asTurnReply } from "../../../extensions/ts/turn.ts";
import { runCode, runEntry } from "../../../extensions/ts/sandbox.ts";
import { captureWorkspace, commitWorkspace, materialize, readWorkspace, validateEntrypoint, writeWorkspace } from "../../../extensions/ts/workspace.ts";
import { bwrapSandbox, defaultConfiner, denoSandbox, macosPython, runBwrap, runSeatbelt, seatbeltPythonSandbox } from "../../../extensions/ts/sandbox.ts";
import { declareSandbox, verifySandbox } from "../../../extensions/ts/sandbox-registry.ts";
import { progress } from "../../../extensions/ts/progress.ts";
import { arg, argAll, argOn } from "../util.ts";
import { type CapabilityBody, capabilityKey, publishCapability } from "../../../extensions/ts/capability.ts";
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
/** Where materialised trees land. Granted to this worker by the launcher as its ONLY write access,
 *  and outside `.radia` on purpose: the sandbox child is denied that directory (it holds the KEK
 *  and the database), and in Deno a deny beats an allow, so a tree materialised there would be
 *  unreadable by the process meant to read it. */
const workspaceRoot = arg("--workspace-root") ?? "";
// Denied even if a root would otherwise cover them: the space's blob key and its operator
// credential. `--deny-read` beats `--allow-read` for the FILE APIS, so pointing `--dir` at a
// directory containing them does not expose them to `Deno.readTextFile`.
//
// IT DOES NOT COVER MODULE LOADING, and both of those files are JSON. Measured: inside this jail
// `import("file:///…/kek.json", { with: { type: "json" } })` returns the file, past the roots and
// past this deny list, while the same path through a file API is refused. There is no Deno flag
// that closes it (`--allow-import` gates remote hosts only); only a mount namespace does, which is
// why `bwrapSandbox` carries `importsConfined: true` and `denoSandbox` carries false. Until this
// worker runs under a confining jail, treat "unreadable by the sandbox" as false for any JSON the
// worker's own user can read. See extensions/ts/sandbox.ts `importsConfined`.
const denyRead = argAll("--deny-dir").filter(Boolean);
/**
 * Refuse to run code at all unless the jail CONFINES the filesystem.
 *
 * Not a Windows switch, though that is the platform where the answer is always no: the same gap
 * exists on a Linux host without bubblewrap and on a Mac whose profile fails. A read permission
 * does not bound module loading (agent_docs/plan-jail-confinement.md), so an unconfined jail reads
 * any JSON its user can read. Off by default, because that unconfined jail is what every host had
 * until the confiners existed and turning it off silently would break working setups; on, for a
 * space where model-written code runs anywhere near something that matters.
 */
const requireConfinement = argOn("--require-confinement");
const client = new RadiaClient(url, token ? { definitionToken: token } : {});

/** Stdout longer than this is stored rather than inlined: a large payload in a `tool_result` lands
 *  in the message thread and is re-sent on every later turn. The reference costs ~40 characters. */
const INLINE_MAX = 4096;

// The description is the documentation: the model learns the dialect and the limits from here,
// never from the chat's system prompt. Saying what is DENIED matters as much as what is allowed.
// A model that knows there is no network will not waste a turn discovering it.
// Built per boot rather than declared once, because the sibling it names has to EXIST. Naming a
// tool nobody serves is unreachable advice: the model calls it and gets "unknown tool", which is the
// same defect as naming none. `run_python` is published only where its jail probed clean, so this
// description can only cross-reference it once that is known.
function runJavascriptDef(pythonServed: boolean): ToolDef {
  return {
  type: "function",
  function: {
    name: "run_javascript",
    description:
      `Run JavaScript in a sandbox and get its output back. ` +
      (pythonServed
        ? `JAVASCRIPT ONLY: a Python program goes to run_python, and passing one here fails with a ` +
          `SyntaxError rather than running it. The language of the program decides the tool, and ` +
          `nothing else does. Shelling out to another interpreter is not a workaround: this sandbox ` +
          `cannot start processes at all. `
        : `JAVASCRIPT ONLY, and it is the only language this space runs: there is no Python here, so ` +
          `a task that needs one has to be solved in JavaScript or not at all. Say so rather than ` +
          `writing Python and hoping. `) +
      `Two shapes, and picking the wrong one ` +
      `is the common mistake. Bare 'code' is a THROWAWAY: use it when the answer is the output ` +
      `(a calculation, parsing, checking your own reasoning) and the program itself is not worth ` +
      `keeping, because nothing is stored. When the PROGRAM is the point, save_workspace first and ` +
      `pass 'workspace': that is every program the user will keep, look at, or ask you to fix, ` +
      `including a single file. Print results with console.log; stdout is what you get back. ` +
      `Pass 'workspace' to run against a saved multi-file tree instead of a bare snippet; it is ` +
      `materialised read-only for the run and discarded after. ` +
      `Pass save_as to STORE stdout as an artifact instead of only returning it. Use that ONLY for ` +
      `bytes the program COMPUTED. If you already know the content, you are not computing it: ` +
      `wrapping text you wrote in a console.log and printing it back is a roundtrip that sends ` +
      `the same content twice and stores exactly what you would have passed directly. Content ` +
      `you authored (a page, an SVG, a config, a document) goes to save_content in ONE call, ` +
      `whether or not the user said the word "save". For binary formats, print base64 and set ` +
      `encoding:"base64". Output larger than ${INLINE_MAX} characters is stored as an artifact ` +
      `automatically and you get a preview plus its id. Pass 'expect' to state what the run should ` +
      `do before it runs; the verdict comes back with the result and is recorded independently. ` +
      `The sandbox has NO network, NO filesystem, ` +
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
        workspace: {
          type: "string",
          description:
            "Run against a saved workspace instead of a bare snippet. Your program runs INSIDE the " +
            "tree, so relative paths work: Deno.readTextFileSync('src/main.ts') reads that file, " +
            "and await import('./src/main.ts') imports it. Save it first with save_workspace. The " +
            "tree is READ-ONLY and discarded after the run, so a file your program writes does not " +
            "persist and is NOT how you change the project: call save_workspace again with the new " +
            "contents. Your `code` is JavaScript, never TypeScript, because it arrives on stdin and " +
            "has no extension to state a dialect: a type annotation in it is a SyntaxError. The " +
            "files it imports may be TypeScript. To run the tree AS ITSELF rather than probing it, " +
            "omit `code` and let the workspace's entrypoint run.",
        },
        record: {
          type: "object",
          description:
            "REHEARSE the workspace's entrypoint the way an AGENT would run it: it is called as " +
            "default(record, space), where this object becomes record.body. `space` has exactly " +
            "three methods, each taking ONE argument and returning a promise you must AWAIT: " +
            "space.put({kind, body}) (positional arguments are not the shape, and an un-awaited " +
            "put fails AFTER your result, which is reported as the run failing), " +
            "space.query(pattern, limit) and space.readOne(pattern). Everything it writes " +
            "through `space` is RECORDED, not written, and comes back as `wouldWrite` with the " +
            "parts the host adds (the claimed record as a parent, the jail's labels). Reads are " +
            "refused in a rehearsal. Use this to check an entrypoint before anything is bound to " +
            "it; use the plain call to run the tree as a program.",
        },
        entrypoint: {
          type: "string",
          description:
            "Run this file from the workspace instead of sending a program. Omit it and the " +
            "workspace's own declared entrypoint runs, which is the same file an agent bound to " +
            "this tree would run. Needs `workspace`, and must name a file that is in it.",
        },
        write: {
          type: "boolean",
          description:
            "Let the program CHANGE the workspace. Off by default: a run that only inspects should " +
            "not be able to produce a version. With it on, whatever the program wrote is captured " +
            "as the next version of the tree and the result reports {changed, removed, newVersion}. " +
            "This is how a program edits its own project (generate a file, fix a file); editing by " +
            "hand is still save_workspace with the new contents. Symlinks are never captured, and " +
            "there are limits on how many files and bytes a run may hand back.",
        },
        expect: {
          type: "object",
          description:
            "What this run should do, stated BEFORE it runs. Every clause given must hold. The " +
            "result comes back with {check:{verdict,reasons}} and the verdict is recorded as a " +
            "record you cannot write yourself, so it is evidence rather than your own say-so. " +
            "Use it whenever you are iterating toward something specific and you can name the " +
            "success condition: it turns 'looks right' into a checked fact, and on a failure the " +
            "reasons tell you which clause missed. Omit it when there is nothing to check (a " +
            "one-off calculation you will read yourself); an omitted expectation records no " +
            "verdict, which is honest, rather than a passing one.",
          properties: {
            exit_zero: { type: "boolean", description: "True if the program must exit 0; false if it must fail." },
            stdout_equals: { type: "string", description: "Exact expected stdout (trailing newlines ignored)." },
            stdout_contains: { type: "string", description: "A substring stdout must contain." },
          },
        },
        save_as: { type: "string", description: "Filename to store COMPUTED stdout under as an artifact, e.g. 'koala.svg'. The media type is taken from the extension unless media_type says otherwise. For content you already wrote, use save_content rather than printing it back." },
        media_type: { type: "string", description: "Override the stored artifact's media type, e.g. 'text/csv'." },
        encoding: { type: "string", enum: ["utf8", "base64"], description: "How stdout encodes the artifact's bytes. Use 'base64' for binary formats (PNG, zip)." },
      },
      // No `required`: either `code` or a workspace with an entrypoint.

    },
  },
  };
}

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
      "sandbox as run_javascript, with the same limits. Re-saving the same name replaces it. " +
      "It is stored as a WORKSPACE named proc-<name>, so you can read it with read_workspace, " +
      "change one line with edit_workspace instead of re-sending the whole program, and every " +
      "version is kept. Returns {name, workspace, entrypoint, treeDigest}.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tool name to save it under: lowercase letters, digits and underscores, e.g. 'hash_text'." },
        description: { type: "string", description: "What it does and what `args` it expects. This becomes the tool description you will see later, so write it for your future self." },
        code: {
          type: "string",
          description:
            "The program. Read inputs from the `args` object, which is in scope; print results with " +
            "console.log (or print, in Python). It may instead `export default (args) => …` and " +
            "RETURN its answer, which is the same shape an agent's entrypoint has.",
        },
        language: {
          type: "string",
          enum: ["javascript", "python"],
          description: "Which language `code` is. Default javascript. The saved file's extension decides the jail, so a Python procedure really runs in the Python one.",
        },
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

await publishCapability(client, SAVE_PROCEDURE, ME);
await publishCapability(client, READ_PROCEDURE, ME);
await publishCapability(client, RETIRE_PROCEDURE, ME);

// EVERYTHING the handler reads must be declared above `agentLoop`, which never returns: a `const`
// placed after it is never evaluated, so it stays in the temporal dead zone for the life of the
// process and the first handler that touches it throws `Cannot access '<name>' before
// initialization` (silently, since a handler that throws just nacks and retries).

/** This worker's own tools. A fallback for the check below, for the moment before capabilities
 *  have been read (or if this run has no grant to read them). */
/** Tool names this worker executes DIRECTLY rather than resolving as a saved procedure. Every
 *  runner must be listed: adding `run_python` while the check compared against ONE name sent every
 *  Python call down the procedure path, where it came back as "no procedure named run_python". */
const BUILTIN_RUNNERS = new Set(["run_javascript", "run_python"]);

const RESERVED = new Set([...BUILTIN_RUNNERS, "save_procedure", "read_procedure", "retire_procedure"]);

/** What the caller said the run would do. Data only: no regex, no expression to evaluate, so a
 *  reader (or an auditor) can see exactly what was claimed. */
interface Expectation {
  exit_zero?: boolean;
  stdout_equals?: string;
  stdout_contains?: string;
}

/**
 * Did the run do what was claimed of it?
 *
 * Every stated clause must hold; an empty expectation is not a pass, it is no claim, and the caller
 * gets no `check` record at all. That distinction is the whole point: a space full of runs with no
 * verdict should look like what it is (unverified) rather than like success.
 *
 * The comparison is deliberately dumb. An expectation that could run code would be one more thing
 * the model authors and the auditor has to read; this one is three literal comparisons, so "what
 * was claimed" is legible without executing anything.
 */
function judge(
  e: Expectation,
  r: { stdout: string; exitCode: number | null; timedOut: boolean },
): { verdict: "pass" | "fail"; reasons: string[] } {
  const reasons: string[] = [];
  // A killed process has a null exit code. Treating that as "not zero" is right and treating it as
  // a pass would be the worst possible failure of this feature: a timeout must never read as met.
  if (e.exit_zero === true && r.exitCode !== 0) reasons.push(`expected exit 0, got ${r.timedOut ? "a timeout" : r.exitCode}`);
  if (e.exit_zero === false && r.exitCode === 0) reasons.push(`expected a non-zero exit, got 0`);
  // Trailing newlines are an artifact of console.log, not of the answer, so they are not a failure.
  if (e.stdout_equals !== undefined && r.stdout.trimEnd() !== e.stdout_equals.trimEnd()) {
    reasons.push(`stdout did not equal the expected text`);
  }
  if (e.stdout_contains !== undefined && !r.stdout.includes(e.stdout_contains)) {
    reasons.push(`stdout did not contain ${JSON.stringify(e.stdout_contains)}`);
  }
  return { verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}

/** The clauses actually stated, so the record says what was claimed rather than what was possible. */
function stated(a: unknown): Expectation | undefined {
  if (!a || typeof a !== "object" || Array.isArray(a)) return undefined;
  const e = a as Record<string, unknown>;
  const out: Expectation = {};
  if (typeof e.exit_zero === "boolean") out.exit_zero = e.exit_zero;
  if (typeof e.stdout_equals === "string") out.stdout_equals = e.stdout_equals;
  if (typeof e.stdout_contains === "string") out.stdout_contains = e.stdout_contains;
  return Object.keys(out).length > 0 ? out : undefined;
}

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
    // Keyed by (provider, tool), not by tool: keyed by tool, one provider RETIRING a name would
    // drop it from this set while another provider still served it, and a procedure could then be
    // saved under a name a live worker answers.
    const live = activeByKey<CapabilityBody>(caps, capabilityKey);
    return new Set([...live.values()].map((r) => (r.body as CapabilityBody).tool));
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
const RUN_PYTHON: ToolDef = {
  type: "function",
  function: {
    name: "run_python",
    description:
      `Run Python 3 in a sandbox and get its output back. PYTHON ONLY, and it is the tool for every ` +
      `Python program: run_javascript cannot parse Python and fails with a SyntaxError, so the ` +
      `language you wrote decides the tool and nothing else does. ` +
      `The same shape as run_javascript and the ` +
      `same rules: bare 'code' is a THROWAWAY whose answer is the output, 'workspace' runs against ` +
      `a saved tree with your program inside it, 'write' lets it change that tree, 'expect' records ` +
      `a verdict, 'save_as' stores stdout as an artifact. Print with print(); stdout is what you ` +
      `get back. ` +
      `The JAIL DIFFERS from run_javascript and the difference is worth knowing: this one is built ` +
      `from namespaces rather than permission flags, so it has NO network and cannot see your ` +
      `files, but it CAN see the Python installation it needs to exist and it can start processes. ` +
      `run_javascript can do neither. Ask space_query {kind:"sandbox"} for what each one guarantees. ` +
      `Runs for at most ${Math.round(timeoutMs / 1000)}s.`,
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "The Python program. Use print() to return anything." },
        workspace: {
          type: "string",
          description:
            "Run against a saved workspace: your program runs INSIDE the tree, so relative paths " +
            "work and open('src/main.py') reads that file. Save it first with save_workspace. To " +
            "run the tree AS ITSELF, omit `code` and let its entrypoint run. To probe it instead, " +
            "send `code` and reach the tree's files from there (importlib, or runpy.run_path). The " +
            "tree is read-only unless you pass write, and it is discarded after the run, so a file " +
            "your program writes does not persist by itself.",
        },
        record: {
          type: "object",
          description:
            "REHEARSE the workspace's entrypoint the way an AGENT would run it: it is called as " +
            "default(record, space), where this object becomes record.body. Everything it writes " +
            "through `space` is RECORDED, not written, and comes back as `wouldWrite` with the " +
            "parts the host adds (the claimed record as a parent, the jail's labels). Reads are " +
            "refused in a rehearsal. Use this to check an entrypoint before anything is bound to " +
            "it; use the plain call to run the tree as a program.",
        },
        entrypoint: {
          type: "string",
          description:
            "Run this file from the workspace instead of sending a program. Omit it and the " +
            "workspace's own declared entrypoint runs, which is the same file an agent bound to " +
            "this tree would run. Needs `workspace`, and must name a file that is in it.",
        },
        write: {
          type: "boolean",
          description:
            "Let the program change the workspace; changes become a new version. This is about the " +
            "TREE, not the space: it does not make a rehearsal write records, and passing it with " +
            "`record` is refused rather than ignored.",
        },
        save_as: { type: "string", description: "Filename to store COMPUTED stdout under as an artifact." },
        media_type: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"] },
        expect: {
          type: "object",
          description: "What this run should do, stated before it runs. Same clauses as run_javascript.",
          properties: {
            exit_zero: { type: "boolean" },
            stdout_equals: { type: "string" },
            stdout_contains: { type: "string" },
          },
        },
      },
      // No `required`: either `code` or a workspace with an entrypoint.

    },
  },
};

const patterns = [
  { kind: "tool_call", match: { tool: "run_javascript" } },
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
  return {
    id: latest.id,
    ...(latest.body as {
      name: string;
      artifactId?: string;
      workspace?: string;
      entrypoint?: string;
      description?: string;
      retired?: boolean;
    }),
  };
}

// PROVE THE JAIL BEFORE SERVING ANYTHING. The operator declared what this environment guarantees;
// this worker is the only thing that can test whether the declaration is true, and a record nobody
// verified is a more convincing version of an unenforced sentence, because structured data looks
// authoritative. Failing claims are NAMED, and the worker refuses to start rather than warning: a
// policy relying on an unverified guarantee is worse than no policy, since it looks like one.
// PROVE EACH JAIL BEFORE ADVERTISING IT. Per backend, because the guarantee is not uniform: under
// Deno "no network" is the ABSENCE of a flag, and under bubblewrap it is the PRESENCE of one, so a
// bwrap jail missing `--unshare-all` is silently open while its record still claims otherwise.
//
// A backend that fails is not served, and its tool is never published: the model cannot call what
// nobody advertises. On a host without bwrap that means Python is simply absent, which is the
// honest outcome rather than a tool that fails on first use.
/** The confiner in force for every run this worker performs, decided once at boot. */
let confine: "bubblewrap" | "sandbox-exec" | undefined;

{
  // PREFER THE CONFINED JAIL. The permission model does not bound module loading, so an unconfined
  // Deno jail reads any JSON its user can read, this space's blob KEK and operator credential
  // included (package T). A mount namespace closes it. Filesystem only: net stays denied by Deno's
  // flags, so nothing here passes `--unshare-net`.
  //
  // Fall back rather than refuse. A host without bubblewrap keeps the jail it has always had and
  // the RECORD says which one ran, which is the same posture `run_python` already takes: publish
  // what probes clean, and never claim more than was verified.
  // WHICH confiner is a platform guess (`defaultConfiner`); WHETHER it works is the probe's answer.
  // A host with neither keeps the jail it has always had.
  const candidate = defaultConfiner();
  const confined = candidate ? denoSandbox({ name: "deno-confined", readRoots, timeoutMs, confine: candidate }) : undefined;
  const confinedFailed = confined
    ? await verifySandbox(confined, {
      readRoots,
      timeoutMs,
      networkTarget: new URL(url).host,
      // This worker may write to its workspace root and nowhere else, and the probe needs somewhere
      // OUTSIDE the jail's read roots to put its canary. Without it the import claim reports
      // unverified, the jail is refused, and confinement silently never happens.
      ...(workspaceRoot ? { scratchDir: workspaceRoot } : {}),
    }).catch((e) => [{ claim: "backend", held: false, detail: String(e) }])
    : [{ claim: "backend", held: false, detail: `no confiner for ${Deno.build.os}` }];
  if (confinedFailed.length === 0) confine = candidate;

  if (!confine && requireConfinement) {
    // Refusing is the whole point of the flag, and it refuses EVERYTHING: procedures are code
    // execution too, so serving them while declining `run_javascript` would honour the letter of
    // this and none of its intent.
    console.error(
      "exec worker: REFUSING to serve. --require-confinement is set and no confiner holds on this " +
        `host (${confinedFailed.map((f) => `${f.claim}: ${f.detail}`).join("; ")}). ` +
        "Install bubblewrap (Linux, WSL2), run on macOS, or drop the flag to accept an unconfined jail.",
    );
    Deno.exit(1);
  }

  const js = confine && confined ? confined : denoSandbox({ name: "deno", readRoots, timeoutMs });
  // The SPACE's own address as the network probe target: this worker can already reach it (that is
  // its one `--allow-net` grant), it is always listening, and it needs no outbound connection. A
  // probe with no target reports the claim UNVERIFIED, which refuses the jail.
  const networkTarget = new URL(url).host;
  const failed = confine ? [] : await verifySandbox(js, { readRoots, timeoutMs, networkTarget });
  if (failed.length > 0) {
    console.error(
      "exec worker: refusing to serve. The Deno jail does not match its declaration: " +
        failed.map((f) => `${f.claim} (${f.detail})`).join(", "),
    );
    Deno.exit(1);
  }
  // Declared as well as verified. A `check` names the jail its verdict was reached in, so a jail
  // that never lands in the registry leaves that reference dangling and "which of my sandboxes has
  // a filesystem" silently omits the default one.
  await declareSandbox(client, js);
  console.error(
    confine
      ? `exec worker: JavaScript runs CONFINED (${confine} over the Deno jail); module loading is bounded`
      : "exec worker: JavaScript runs UNCONFINED (no usable confiner). Module loading is not bounded by " +
        "the read permission, so any JSON this user can read is reachable from the sandbox: " +
        `${confinedFailed.map((f) => f.claim).join(", ")}. See agent_docs/plan-jail-confinement.md`,
  );

  // PYTHON, per platform. Linux confines it with a mount namespace; macOS with a Seatbelt profile,
  // which has to be `(deny default)` because Python brings no permission model for a filesystem
  // confiner to sit under. Neither is assumed: whichever the platform suggests is PROBED, and a host
  // where it does not hold simply has no Python (agent_docs/plan-jail-confinement.md).
  const macPython = Deno.build.os === "darwin" ? macosPython() : undefined;
  const py = macPython
    ? seatbeltPythonSandbox({ name: "python", interpreter: macPython, timeoutMs })
    : bwrapSandbox({ command: ["python3", "-"], language: "python", name: "python", timeoutMs });
  const pyFailed = await verifySandbox(py, {
    timeoutMs,
    networkTarget,
    ...(macPython ? {} : { bwrap: { command: ["python3", "-"], timeoutMs } }),
  }).catch((e) => [{ claim: "backend", held: false, detail: String(e) }]);
  if (pyFailed.length === 0) {
    patterns.push({ kind: "tool_call", match: { tool: "run_python" } });
    await publishCapability(client, RUN_PYTHON, ME);
    await declareSandbox(client, py);
    await publishCapability(client, runJavascriptDef(true), ME);
  } else {
    await publishCapability(client, runJavascriptDef(false), ME);
    // Two very different outcomes, and reporting them alike taught the wrong thing. A jail that
    // could not START (no `bwrap` installed, no permission to spawn it) is an ABSENT language: an
    // ordinary fact about this host, and the notice should read like one. A jail that ran and then
    // failed a claim it declared is a jail that LIED, which is the case this whole probe exists for
    // and must stay loud.
    const unavailable = pyFailed.length === 1 && pyFailed[0].claim === "backend";
    console.error(
      unavailable
        ? "exec worker: run_python unavailable on this host (no bwrap), serving run_javascript only"
        : `exec worker: REFUSING to serve run_python, its jail does not match its declaration: ${
          pyFailed.map((f) => `${f.claim} (${f.detail})`).join(", ")
        }`,
    );
  }
}

/** The `tool_call` body this worker claims. */
interface Call {
  tool?: string;
  args?: { code?: string; workspace?: string; entrypoint?: string; record?: unknown; write?: boolean; save_as?: string; media_type?: string; encoding?: string; expect?: unknown };
  conversationId?: string;
  owner?: string;
}

/** What ran, and where the code came from. */
interface Program {
  code: string;
  /** Set for a procedure saved as a TREE: the code is the workspace's entrypoint, not `code`. */
  workspace?: string;
  entrypoint?: string;
  /** Set only for a saved procedure: for a builtin runner the program is in the call body. */
  /**
   * What produced a result, pinned to the exact code.
   *
   * `recordId` names the PROCEDURE version, which is not the same question: a tree-backed procedure
   * runs whatever its workspace currently holds, so the record alone would leave "which code ran"
   * one edit away from unanswerable. `treeDigest` is stamped once the tree is materialised, and it
   * is the tree-shaped equivalent of the `artifactId` a single-artifact procedure pinned.
   */
  provenance?: { name: string; recordId: string; artifactId?: string; treeDigest?: string };
}

/** The materialised tree a run sees, or the absence of one. */
interface Tree {
  name?: string;
  root?: string; // temp directory, removed after the run
  parent?: string; // the manifest (or the version the run produced): the result's data parent
  roots: string[]; // read roots handed to the jail
  digest?: string;
  manifest: Awaited<ReturnType<typeof readWorkspace>>;
  write: boolean;
}

/**
 * A step's refusal, carrying the sentence the model should read.
 *
 * ANSWERED, never thrown, and that is the whole reason this type exists. A handler that throws is
 * nacked and the call becomes claimable again (`sdk/ts/loop.ts`), which is right for a transient
 * fault and exactly wrong for a permanent one: an erased payload is not coming back, so retrying
 * re-fails until the CLIENT's deadline and the user sees "timed out waiting for 'run_python'" with
 * no reason. A shredded file in a tree did exactly that, turning a one-line explanation into a
 * two-minute hang.
 */
interface Refused {
  refused: string;
}
const refuse = (refused: string): Refused => ({ refused });
const isRefused = (x: unknown): x is Refused => typeof x === "object" && x !== null && "refused" in x;

/** Every refusal is the same record shape, and every copy of it has to remember `callId`: without
 *  one the client waits out its deadline for a reply that already exists. */
function refusal(b: Call, callId: string, output: string) {
  return {
    kind: "tool_result",
    body: { callId, conversationId: b.conversationId, owner: b.owner, ok: false, output },
    taint: [] as string[],
  };
}

/**
 * RESOLVE: what program is this call, and where did it come from?
 *
 * A builtin runner carries its source in the call body. A named procedure carries only `{tool,
 * args}`, so the code is fetched from the artifact it was saved as and the arguments are injected.
 */
async function resolveProgram(c: RadiaClient, b: Call): Promise<Program | Refused> {
  if (!b.tool || BUILTIN_RUNNERS.has(b.tool)) return { code: String(b.args?.code ?? "") };

  // Checked at execution too, not just at save: a worker may have started serving this name since.
  // The real tool wins, and this worker refuses rather than answering for it.
  if ((await capabilityNames(c)).has(b.tool)) {
    return refuse(`'${b.tool}' is served by a worker, not by a saved procedure`);
  }
  const proc = await lookupProcedure(c, b.tool, b.conversationId);
  if (!proc || proc.retired) {
    // A retired name is still claimed on purpose, so this answers at once instead of leaving the
    // caller to wait out the tool deadline. Saving the name again un-retires it.
    return refuse(
      proc?.retired
        ? `procedure '${b.tool}' has been retired; save it again to bring it back`
        : `no procedure '${b.tool}' saved in this conversation`,
    );
  }
  // A procedure saved as a TREE runs its entrypoint, which is what makes it multi-file, able to be
  // TypeScript or Python, readable with read_workspace and exportable like any other project.
  if (proc.workspace) {
    return {
      code: "",
      workspace: proc.workspace,
      entrypoint: proc.entrypoint ?? "main.js",
      // No `artifactId`: this procedure IS a tree. The digest is stamped below, once the tree is
      // materialised, rather than read again here.
      provenance: { name: proc.name, recordId: proc.id },
    };
  }
  // LEGACY: a procedure saved as a lone artifact, before they were trees. Still resolved, because
  // the registry is latest-wins over records that already exist and re-saving is the only migration
  // anyone should have to do.
  if (!proc.artifactId) return refuse(`procedure '${b.tool}' has neither a workspace nor stored code; save it again`);
  const source = new TextDecoder().decode(await c.getArtifact(proc.artifactId));
  return {
    // `args` is injected as a literal rather than passed on argv: the sandbox takes its program on
    // stdin and has no environment, and a JSON literal is the one channel that needs no permission.
    // JSON.stringify also means the model's arguments arrive as DATA, never concatenated into an
    // executable position.
    code: `const args = ${JSON.stringify(b.args ?? {})};\n${source}`,
    // PROVENANCE. The code lives elsewhere and can be re-saved, so without this the result could
    // never be attributed to the version that produced it.
    provenance: { name: proc.name, recordId: proc.id, artifactId: proc.artifactId ?? "" },
  };
}

/**
 * The program a PROCEDURE actually runs: arguments, then the tree's entrypoint.
 *
 * Generated into its own directory, never into the tree, for the reason the broker's boot has the
 * same rule: a tree is content-addressed, so a per-call file inside it would change the digest that
 * identifies the code, and phase 6 shares one materialised root between calls.
 *
 * `args` is a GLOBAL rather than a parameter, because that is the contract every procedure written
 * so far was saved against (the old runner prepended `const args = …` to the source). A procedure
 * that instead exports a default function gets called with the same object and may RETURN its
 * answer, which is the shape an agent entrypoint has.
 */
function procedureBoot(entryPath: string, args: unknown, language: "javascript" | "python"): string {
  const json = JSON.stringify(args ?? {});
  if (language === "python") {
    return [
      "import builtins, json, importlib.util",
      `builtins.args = json.loads(${JSON.stringify(json)})`,
      `spec = importlib.util.spec_from_file_location("procedure", ${JSON.stringify(entryPath)})`,
      "m = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(m)",
      "if hasattr(m, 'main'):",
      "    out = m.main(builtins.args)",
      "    if out is not None:",
      "        print(out if isinstance(out, str) else json.dumps(out))",
      "",
    ].join("\n");
  }
  return [
    `globalThis.args = ${json};`,
    `const mod = await import(${JSON.stringify(`file://${entryPath}`)});`,
    "if (mod && typeof mod.default === 'function') {",
    "  const out = await mod.default(globalThis.args);",
    "  if (out !== undefined) console.log(typeof out === 'string' ? out : JSON.stringify(out));",
    "}",
    "",
  ].join("\n");
}

/** The jail an entrypoint implies. The FILE says which language it is, which is the honest signal:
 *  choosing from the tool name is what made every saved procedure JavaScript whatever it contained. */
function jailFor(entrypoint: string): "python" | "javascript" {
  return entrypoint.toLowerCase().endsWith(".py") ? "python" : "javascript";
}

/**
 * MATERIALISE: turn a named workspace into a real directory the jail may read.
 *
 * The manifest becomes a data PARENT of the result, which is what stops a classified tree from
 * laundering its labels through the filesystem: the substrate cannot see a disk, so the edge is the
 * only thing that carries the classification.
 */
async function openTree(c: RadiaClient, b: Call, callId: string, named?: string): Promise<Tree | Refused> {
  // `named` is the PROCEDURE's tree, which the caller does not get to choose: a tool call carries
  // arguments, never the code that serves it.
  const name = named ?? (typeof b.args?.workspace === "string" ? b.args.workspace : undefined);
  // WRITE is opt-in per call. Reading is the common case and must not carry the capability to
  // change the tree: a run that only inspects should not be able to produce a version.
  const write = named ? false : b.args?.write === true;
  if (!name) return { roots: readRoots, manifest: null, write };

  const manifest = await readWorkspace(c, name, b.conversationId);
  if (!manifest) return refuse(`no workspace '${name}' saved in this conversation; save_workspace first`);

  // `|| undefined`, because an EMPTY `--workspace-root` is not a directory: `{dir: ""}` throws
  // "Empty path is not allowed" rather than falling back to the system temp dir. Latent until
  // procedures became trees, since nothing else materialised one in a fleet launched without it.
  let root: string;
  try {
    root = await Deno.makeTempDir({ dir: workspaceRoot || undefined, prefix: `${name}-` });
  } catch (e) {
    // The failure a launcher causes, said once and plainly. Without this it is a silent nack loop
    // and a tool call that times out, which is the least diagnosable shape a defect can take.
    return refuse(
      `this worker cannot materialise a workspace: it has no writable directory (${(e as Error).message}). ` +
        `Launch it with --workspace-root <dir> and --allow-write for that directory.`,
    );
  }
  // `materialize` VERIFIES on the way in: every artifact is hashed against the entry that names it,
  // and the tree digest is recomputed from the entries. A manifest that lies about either is
  // refused here rather than silently attested to later.
  let mat;
  try {
    mat = await materialize(c, manifest, root);
  } catch (e) {
    await Deno.remove(root, { recursive: true }).catch(() => {});
    return refuse(e instanceof Error ? e.message : String(e));
  }
  await progress(c, { conversationId: b.conversationId, owner: b.owner, callId, stage: "executing", by: ME, note: `workspace ${name} (${manifest.files.length} files)` }, [callId]);
  return {
    name,
    root,
    parent: manifest.id,
    // The tree REPLACES the configured read roots rather than adding to them: a run against a
    // workspace should see the workspace, not also whatever directories the operator opened for
    // ad-hoc file reads.
    roots: [root],
    digest: mat.treeDigest,
    manifest,
    write,
  };
}

/**
 * Which file the tree runs as, for a call that sent no program of its own.
 *
 * An explicit `entrypoint` beats the manifest's, so a probe can run any file in the tree without
 * re-pointing the workspace. Either way it must BE in the tree: a name that is not is refused here,
 * where the caller can read why, rather than inside a jail as "module not found".
 */
function entrypointFor(b: Call, tree: Tree): string | undefined | Refused {
  const asked = typeof b.args?.entrypoint === "string" ? b.args.entrypoint.trim() : "";
  const name = asked || tree.manifest?.entrypoint;
  if (!name) return undefined;
  if (!tree.root || !tree.manifest) return refuse(`\`entrypoint\` names a file in a workspace, so pass \`workspace\` too`);
  try {
    validateEntrypoint(name, tree.manifest.files);
  } catch (e) {
    return refuse((e as Error).message);
  }
  return name;
}

/**
 * RUN a procedure: its tree, its entrypoint, and its arguments, through a generated boot.
 *
 * The boot lives in its own directory and that directory is added to the read roots, because it
 * cannot live in the tree: a per-call file inside a content-addressed directory would change the
 * digest and collide with any other call sharing the same materialised root.
 */
async function runProcedure(tree: Tree, entrypoint: string, args: unknown) {
  const jail = jailFor(entrypoint);
  const bootDir = await Deno.makeTempDir({ dir: workspaceRoot || undefined, prefix: "proc-boot-" });
  try {
    const bootPath = `${bootDir}/${jail === "python" ? "boot.py" : "boot.mjs"}`;
    await Deno.writeTextFile(bootPath, procedureBoot(`${tree.root}/${entrypoint}`, args, jail));
    const roots = [...tree.roots, bootDir];
    return jail === "python"
      ? await (() => {
        // A PROCEDURE in Python takes the same per-platform jail as any other Python run: the boot
        // directory joins the read roots either way, so the generated program is reachable.
        const py = pythonCommand();
        const o = { timeoutMs, readRoots: roots, cwd: tree.root, command: [py.bin, bootPath] };
        return py.seatbelt ? runSeatbelt(null, o) : runBwrap(null, o);
      })()
      : await runEntry(bootPath, { timeoutMs, readRoots: roots, denyRead, cwd: tree.root, ...(confine ? { confine, ...jailCache() } : {}) });
  } finally {
    await Deno.remove(bootDir, { recursive: true }).catch(() => {});
  }
}

/**
 * Where a confined jail keeps Deno's caches: inside this worker's own writable directory.
 *
 * A confiner bounds READS, and Deno writes its caches regardless, so a jail pointed at the host's
 * cache leaves it writable-but-unreadable and CORRUPTS IT for the whole machine (plan-jail-
 * confinement.md phase 4). This worker holds write access to exactly one directory, which is also
 * the only place it can put one.
 */
function jailCache(): { cacheDir?: string } {
  return workspaceRoot ? { cacheDir: `${workspaceRoot}/deno-cache` } : {};
}

/** Which interpreter runs Python here, and whether Seatbelt is what jails it. `/usr/bin/python3` is
 *  never the answer on macOS: it is the xcrun shim, and the profile denies the temp file it needs. */
function pythonCommand(): { bin: string; seatbelt: boolean } {
  const mac = Deno.build.os === "darwin" ? macosPython() : undefined;
  return mac ? { bin: mac, seatbelt: true } : { bin: "python3", seatbelt: false };
}

/** RUN: in the tree when there is one, so relative paths resolve as they would in a checkout. */
function runProgram(code: string, jail: "python" | "javascript", tree: Tree, entry?: string) {
  // The tree, and ONLY the tree: a run that may write gets it for exactly the directory it was
  // given, never the workspace root shared with other calls.
  const writeRoots = tree.write && tree.root ? [tree.root] : [];
  const opts = { timeoutMs, readRoots: tree.roots, writeRoots, cwd: tree.root, ...(confine ? { confine, ...jailCache() } : {}) };
  // A FILE when the tree says how it is run: it carries its own extension, so a `.ts` entrypoint is
  // TypeScript without anything having to guess a dialect, and stdin stays free. A bare `code`
  // argument keeps the stdin path, because a throwaway should not have to become a file first.
  const py = pythonCommand();
  if (entry) {
    const path = `${tree.root}/${entry}`;
    return jail === "python"
      ? py.seatbelt
        ? runSeatbelt(null, { ...opts, command: [py.bin, path] })
        : runBwrap(null, { ...opts, command: [py.bin, path] })
      : runEntry(path, { ...opts, denyRead });
  }
  return jail === "python"
    ? py.seatbelt
      ? runSeatbelt(code, { ...opts, command: [py.bin, "-"] })
      : runBwrap(code, { ...opts, command: [py.bin, "-"] })
    : runCode(code, { ...opts, denyRead });
}

type Run = Awaited<ReturnType<typeof runProgram>>;

/**
 * CAPTURE: hash after, store the difference, commit a successor, then discard the directory.
 *
 * An unchanged tree writes nothing, so a read-only attempt does not manufacture a version. Mutates
 * `tree` because the result belongs to the version the run PRODUCED, not the one it started from.
 */
async function captureTree(c: RadiaClient, tree: Tree, r: Run): Promise<{
  committed: { id: string; treeDigest: string; forked: boolean } | null;
  changed?: { changed: string[]; removed: string[] };
}> {
  let committed: { id: string; treeDigest: string; forked: boolean } | null = null;
  let changed: { changed: string[]; removed: string[] } | undefined;
  if (tree.write && tree.root && tree.manifest) {
    try {
      const cap = await captureWorkspace(c, tree.manifest, tree.root);
      changed = { changed: cap.changed, removed: cap.removed };
      committed = await commitWorkspace(c, tree.manifest, cap);
      if (committed) {
        tree.digest = committed.treeDigest;
        tree.parent = committed.id;
      }
    } catch (e) {
      // A refused capture (a quota, an unsafe path a program invented) must not read as success.
      r.stderr += `\n[workspace not captured: ${e}]`;
    }
  }
  // Materialised bytes are scratch: the tree of record is the manifest. Discarding is the honest
  // behaviour rather than leaving a directory that looks like state.
  if (tree.root) await Deno.remove(tree.root, { recursive: true }).catch(() => {});
  return { committed, changed };
}

/**
 * STORE: stdout to an artifact, when asked or when it is too big for the thread.
 *
 * The bytes come from the SANDBOX, not from the model's tokens: content generated by code never
 * round-trips through the context to be saved.
 */
async function storeStdout(c: RadiaClient, b: Call, callId: string, r: Run) {
  const args = b.args;
  if (r.stdout.length === 0 || !(args?.save_as || r.stdout.length > INLINE_MAX)) return undefined;
  try {
    const mediaType = args?.media_type ?? mediaTypeFor(args?.save_as);
    const a = await c.putArtifact(bytesFrom(r.stdout, args?.encoding), {
      mediaType,
      filename: args?.save_as,
      parentIds: [callId], // lineage: conversation -> tool_call -> artifact
      taint: readRoots.length > 0 ? ["file"] : [],
      meta: { conversationId: b.conversationId ?? "", owner: b.owner ?? "" }, // what a grant pattern can bind
    });
    return { artifactId: a.id, mediaType, size: a.size };
  } catch (e) {
    // Best-effort: a bad media type or an oversized payload must not swallow the output the model
    // actually asked for.
    r.stderr += `\n[artifact not stored: ${e}]`;
    return undefined;
  }
}

/**
 * JUDGE: measure the run against what was claimed BEFORE it ran, and write the verdict as a record.
 *
 * The session has no grant to put a `check`, so a pass is something the runtime observed rather than
 * something the model said about its own output. No expectation means no check: an unverified run
 * must not look like a passing one.
 */
async function judgeRun(
  c: RadiaClient,
  b: Call,
  callId: string,
  jail: "python" | "javascript",
  tree: Tree,
  r: Run,
): Promise<{ verdict: string; reasons: string[] } | undefined> {
  const expectation = stated(b.args?.expect);
  if (!expectation) return undefined;
  const j = judge(expectation, r);
  try {
    await c.put({
      kind: "check",
      body: {
        callId,
        conversationId: b.conversationId,
        owner: b.owner,
        tool: b.tool ?? "run_javascript",
        // WHAT was verified, not just that something was. A verdict against a tree digest is an
        // attestation of a reproducible input; against a call id it is a note about an event.
        ...(tree.digest ? { workspace: tree.name, treeDigest: tree.digest } : {}),
        // WHERE it was verified. A verdict from a jail with a filesystem and one from a jail with
        // none are not the same evidence, and nothing else in the record says which.
        sandbox: jail === "python" ? "python" : "deno",
        verdict: j.verdict,
        expected: expectation,
        reasons: j.reasons,
        // The observed side, capped: enough to see WHY it failed without copying a payload into a
        // record that has to stay queryable JSON.
        exitCode: r.exitCode,
        stdout: r.stdout.slice(0, 500),
      },
      // The call is the parent, so a check hangs off the attempt it judges and rides the same
      // attempt chain the retry lineage builds.
      parentIds: [callId],
    });
    return j;
  } catch (e) {
    // A worker that cannot record a verdict must not silently return a passing-looking result.
    return { verdict: j.verdict, reasons: [...j.reasons, `(verdict not recorded: ${e})`] };
  }
}

await agentLoop(client, {
  name: "exec",
  patterns,
  leaseSeconds: 60,
  // Five named steps, each answerable on its own: resolve what to run, materialise what it runs
  // over, run it, capture what it changed, judge what it claimed. This was one 265-line function,
  // which is longer than most files in the runtime and was the hardest thing here to follow.
  // A slotted call's reply IS the tool message (workers/reply.ts); a bare call keeps tool_result.
  handle: async (rec, c) => asTurnReply(rec, await serve(rec, c)),
});

// deno-lint-ignore no-explicit-any
async function serve(rec: any, c: RadiaClient): Promise<{ kind: string; body: Record<string, unknown>; [extra: string]: unknown }> {
  {
    const callId = rec.id;
    const b = rec.body as Call;

    if (b.tool === "save_procedure") return await saveProcedure(rec, c);
    if (b.tool === "read_procedure") return await readProcedure(rec, c);
    if (b.tool === "retire_procedure") return await retireProcedure(rec, c);

    const program = await resolveProgram(c, b);
    if (isRefused(program)) return refusal(b, callId, program.refused);

    // A PROCEDURE brings its own tree, so the call's `workspace` argument is not consulted: a tool
    // call carries arguments, never the code that serves it.
    const tree = await openTree(c, b, callId, program.workspace);
    if (isRefused(tree)) return refusal(b, callId, tree.refused);

    // PIN THE CODE, not just its name. `materialize` verified this digest against the bytes it
    // wrote, so stamping it here records what actually ran rather than what the registry pointed at
    // when somebody later goes looking.
    if (program.provenance && program.workspace && tree.digest) program.provenance.treeDigest = tree.digest;

    // WHICH FILE RUNS, and it is only a question when no program was sent. A `code` argument is a
    // throwaway and keeps the stdin path; a tree that declares an entrypoint is run AS ITSELF, from
    // a file, which is what lets the same tree be run by an agent later.
    const entry = program.workspace ? program.entrypoint : program.code.trim() ? undefined : entrypointFor(b, tree);
    if (isRefused(entry)) return refusal(b, callId, entry.refused);
    if (!entry && !program.code.trim()) {
      return refusal(
        b,
        callId,
        `${b.tool} needs a \`code\` argument, or a \`workspace\` whose manifest declares an entrypoint ` +
          `(set one with save_workspace/edit_workspace, or name a file here with \`entrypoint\`)`,
      );
    }

    // The source is already in the tool_call record, so every program the model ever ran is
    // auditable by query: `{kind: tool_call, tool: "run_javascript"}` is the execution log, with the
    // result and any artifact as its children.
    await progress(c, {
      conversationId: b.conversationId,
      owner: b.owner,
      callId,
      stage: "executing",
      by: ME,
      note: entry ? `${tree.name}/${entry}` : `${program.code.length} chars`,
    }, [callId]);

    // The LANGUAGE follows the file for anything running from a tree, and the tool name only for a
    // stdin snippet. That is what makes a Python procedure possible at all: it used to be decided
    // by which tool was called, so a procedure was JavaScript whatever it contained.
    const jail = entry ? jailFor(entry) : b.tool === "run_python" ? "python" : "javascript";

    // A REHEARSAL: called `(record, space)` the way a host calls a bound agent, with everything it
    // would write recorded instead of written. This is the only way to exercise an agent's
    // entrypoint from here, because the chat's jail has no broker and a hand-written stub of
    // `space` is exactly where "passes in chat, fails in prod" comes from.
    if (b.args?.record !== undefined) {
      if (!entry || !tree.root) {
        return refusal(b, callId, "`record` runs a workspace's ENTRYPOINT, so pass `workspace` (and give the tree an entrypoint)");
      }
      // Silently ignoring this sent a model looking for another way to "really" run the tree, and
      // what it found was adding an `import.meta.main` guard so a plain run would execute: the code
      // then ran as a PROGRAM rather than as the agent, which is the one thing a rehearsal exists to
      // check. The two flags also mean different things, so neither reading was going to happen.
      if (b.args?.write) {
        return refusal(
          b,
          callId,
          "`write` and `record` cannot be combined. A rehearsal writes NOTHING by design: the records " +
            "an entrypoint proposes have to be written by the agent the code is bound to, under its own " +
            "grants, and `wouldWrite` shows you exactly what that run would produce. (`write` means " +
            "something else again: letting a program change its own workspace tree.) For a real run, " +
            "bind the tree to an agent and let a host claim its work.",
        );
      }
      // A REHEARSAL'S FAILURE IS ITS ANSWER, never a fault to retry. Letting this throw nacks, and
      // at-least-once then runs the same doomed code five more times while the model waits for a
      // tool result that never arrives: the diagnosis reaches the terminal and nobody else. Both
      // bugs found this way (a channel the host could not create, a put with positional arguments)
      // were fully explained in a message the model never saw. Infrastructure faults are returned
      // here too, deliberately: a jail this worker cannot start is something the person asking
      // needs told, and a silent retry loop is how the last one hid for a whole session.
      let dry: Awaited<ReturnType<typeof dryRunEntrypoint>>;
      try {
        dry = await dryRunEntrypoint({
        root: tree.root,
        entrypoint: entry,
        record: { id: `dry-run:${callId}`, kind: "exec_request", body: b.args.record } as unknown as RadiaRecord,
        timeoutMs,
        // This worker may write to its workspace root and nowhere else.
        ...(workspaceRoot ? { bootRoot: workspaceRoot } : {}),
        // A rehearsal runs in the same jail a real claim would, confiner included.
        ...(confine ? { run: { confine, ...jailCache() } } : {}),
        ...(jail === "python" ? { spec: { name: "dry", language: "python", isolation: "bubblewrap" } as never } : {}),
        });
      } catch (e) {
        await captureTree(c, tree, { stdout: "", stderr: "", ok: false, exitCode: 1, timedOut: false, truncated: false, ms: 0 });
        return refusal(
          b,
          callId,
          `the rehearsal of ${tree.name}/${entry} failed, and nothing was written: ${String(e instanceof Error ? e.message : e).slice(0, 2000)}`,
        );
      }
      await captureTree(c, tree, { stdout: "", stderr: "", ok: true, exitCode: 0, timedOut: false, truncated: false, ms: 0 });
      return {
        kind: "tool_result",
        body: {
          callId,
          conversationId: b.conversationId,
          owner: b.owner,
          ok: true,
          output: {
            rehearsal: true,
            workspace: tree.name,
            entrypoint: entry,
            result: dry.result,
            // What it WOULD have written, host rules included: the stamp, the forced parent and the
            // labels are the half a reviewer is actually checking.
            wouldWrite: dry.proposals,
            note: "nothing was written. Reads are refused in a rehearsal; they work when this runs as the agent.",
          },
        },
        ...(tree.parent ? { parentIds: [tree.parent] } : {}),
        taint: readRoots.length > 0 ? ["file"] : [],
      };
    }

    const r = program.workspace
      ? await runProcedure(tree, entry as string, b.args ?? {})
      : await runProgram(program.code, jail, tree, entry);

    const { committed, changed } = await captureTree(c, tree, r);
    const stored = await storeStdout(c, b, callId, r);
    const checked = await judgeRun(c, b, callId, jail, tree, r);

    return {
      kind: "tool_result",
      body: {
        callId,
        conversationId: b.conversationId,
        owner: b.owner,
        ok: r.ok,
        // Recorded on the RECORD, deliberately not inside `output`: only `output` is serialized
        // back into the model's thread, so provenance is auditable by query without spending
        // context tokens on every call.
        ...(program.provenance ? { procedure: program.provenance } : {}),
        output: {
          // When it was stored, send a preview rather than the payload: the artifact is the copy.
          stdout: stored ? r.stdout.slice(0, 400) + (r.stdout.length > 400 ? " …[stored as artifact]" : "") : r.stdout,
          stderr: r.stderr,
          exitCode: r.exitCode,
          timedOut: r.timedOut,
          truncated: r.truncated,
          ms: r.ms,
          // Returned as well as recorded, so the model sees the verdict in the same round rather
          // than spending another one asking whether its own run passed.
          ...(tree.name ? { workspace: tree.name, treeDigest: tree.digest } : {}),
          ...(changed ?? {}),
          ...(committed ? { newVersion: committed.treeDigest } : {}),
          ...(committed?.forked ? { forked: true } : {}),
          ...(checked ? { check: checked } : {}),
          ...(stored ?? {}),
        },
      },
      // The procedure record becomes a PARENT of the result, so "which code produced this?" is a
      // lineage walk rather than a guess. That is the question a model answered wrong from memory,
      // and then invented a reason for. The claimed tool_call is added as a parent by `ack`.
      //
      // A workspace manifest is a parent for a different reason: it carries the tree's
      // classification labels, so naming it is how a run over a classified tree inherits them.
      ...(program.provenance || tree.parent
        ? { parentIds: [...(program.provenance ? [program.provenance.recordId] : []), ...(tree.parent ? [tree.parent] : [])] }
        : {}),
      // Classified by what the sandbox could REACH, not by the fact that code ran: "a program
      // produced this" is a graph fact the log already answers. With read roots the output may
      // carry file contents; with none there is nothing a barrier would test.
      taint: readRoots.length > 0 ? ["file"] : [],
    };
  }
}

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
  const fail = (output: string) => ({ kind: "tool_result", body: { callId, conversationId: b.conversationId, owner: b.owner, ok: false, output }, taint: [] });

  if (!NAME_RE.test(name)) return fail("`name` must be lowercase letters, digits and underscores, starting with a letter");
  if ((await capabilityNames(c)).has(name)) return fail(`'${name}' is already a tool served by a worker; choose another name`);
  if (!code.trim()) return fail("save_procedure needs a `code` argument");
  if (!description.trim()) return fail("save_procedure needs a `description`: it is what you will read when deciding to call it later");
  if (!b.conversationId) return fail("save_procedure needs a conversation to belong to");

  await progress(c, { conversationId: b.conversationId, owner: b.owner, callId, stage: "saving", by: ME, note: name }, [callId]);

  // A PROCEDURE IS A WORKSPACE, never a lone code artifact. A tree is multi-file, carries its own
  // language through its entrypoint, versions, exports, and can be bound to an agent; a single
  // artifact is none of those, so "promote a script to a tool" would be a rewrite.
  const language: "javascript" | "python" = a.language === "python" ? "python" : "javascript";
  const entry = language === "python" ? "main.py" : "main.js";
  const ws = `proc-${name}`;
  const prev = await readWorkspace(c, ws, b.conversationId);
  const w = await writeWorkspace(c, {
    name: ws,
    owner: b.owner ?? "",
    conversationId: b.conversationId,
    files: { [entry]: code },
    entrypoint: entry,
    basedOn: prev?.id,
  });

  const key = await shortHash(`${description}\n${ws}\n${w.treeDigest}`);
  await c.put({
    kind: "procedure",
    body: {
      name,
      description,
      parameters: a.parameters ?? { type: "object", properties: {} },
      // The tree, by NAME: re-saving is a new version and a procedure runs the current one, the
      // same way `read_workspace` reads the current one. A digest here would pin the procedure to
      // the version it was saved at, which is promotion's job and not this call's.
      workspace: ws,
      entrypoint: entry,
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
      output: { name, workspace: ws, entrypoint: entry, treeDigest: w.treeDigest, size: code.length, saved: true, ...(note ? { note } : {}) },
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
    return { kind: "tool_result", body: { callId, conversationId: b.conversationId, owner: b.owner, ok: false, output: "read_procedure needs a `name`" }, taint: [] };
  }
  const rows = await c.query({ kind: "procedure", match: { name, conversationId: b.conversationId ?? "" } }, 50);
  if (rows.length === 0) {
    return {
      kind: "tool_result",
      body: { callId, conversationId: b.conversationId, owner: b.owner, ok: false, output: `no procedure '${name}' saved in this conversation` },
      taint: [],
    };
  }
  const latest = newestByKey<{ name?: string }>(rows, (bb) => bb?.name).get(name)!;
  const body = latest.body as { name: string; description: string; artifactId?: string; workspace?: string; entrypoint?: string };
  // A procedure is a TREE now, so its source is a file in it. The artifact path stays for the ones
  // saved before that, which is the whole migration: nothing to run, nothing to rewrite.
  let code: string;
  if (body.workspace) {
    const manifest = await readWorkspace(c, body.workspace, b.conversationId);
    const entry = body.entrypoint ?? manifest?.entrypoint;
    const file = manifest?.files.find((f) => f.path === entry);
    if (!file) {
      return {
        kind: "tool_result",
        body: {
          callId,
          conversationId: b.conversationId,
          owner: b.owner,
          ok: false,
          output: `procedure '${name}' points at ${body.workspace}/${entry}, which is not in that workspace any more`,
        },
        taint: [],
      };
    }
    code = new TextDecoder().decode(await c.getArtifact(file.artifactId));
  } else if (body.artifactId) {
    code = new TextDecoder().decode(await c.getArtifact(body.artifactId));
  } else {
    return {
      kind: "tool_result",
      body: { callId, conversationId: b.conversationId, owner: b.owner, ok: false, output: `procedure '${name}' has no stored code` },
      taint: [],
    };
  }
  return {
    kind: "tool_result",
    body: {
      callId,
      conversationId: b.conversationId, owner: b.owner,
      ok: true,
      output: { name: body.name, description: body.description, code, versions: rows.length },
    },
    taint: [],
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
  const fail = (output: string) => ({ kind: "tool_result", body: { callId, conversationId: b.conversationId, owner: b.owner, ok: false, output }, taint: [] });
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
