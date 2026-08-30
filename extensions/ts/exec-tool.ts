// Running model-written code as a TOOL, so more than one app can serve it.
//
// `examples/chat/workers/exec.ts` is 1,538 lines and only about 300 of them are this: pick a jail,
// verify it rather than assert it, run the program, taint the result, store oversized output as an
// artifact. The rest is that app's policy (saved procedures, workspace trees, expectation judging,
// conversation keys) and belongs to it. This file is the part a second app needs and would
// otherwise copy.
//
// A TOOL, not a worker. `serveTools` (./tool-worker.ts) is the reusable worker and already carries
// what a worker owns: advertising, one claim pattern per tool NAME, the answer envelope, and
// encryption through its `keys` port. Handing it these tools is the whole integration.
//
// THREE PROPERTIES ARE NOT OPTIONS, because each is a stated guarantee rather than a default:
//
//   1. The result carries what the run could have CONTRIBUTED, and no more. `file` when the jail
//      can read something; nothing when it cannot. The closed label set (file/net/foreign,
//      agent_docs/design-taint.md) has no label meaning "computed by model-written code", and
//      inventing one is barred: a label exists only where a lineage walk is too slow.
//
//      IN PRACTICE A RESULT IS STILL LABELLED, and it is worth knowing why, because the chat's
//      worker says "TAINTED, always" while doing exactly this: `foreign` is added by the RUNTIME
//      when a parent was written by somebody else, which is every call from another agent. An
//      agent calling its own tool in a jail with no filesystem gets an unlabelled result, and that
//      is correct rather than a gap: nothing untrusted entered it.
//   2. The jail is PROBED before it is served. `verifySandbox` attempts each escape; a claim it
//      cannot test comes back unverified, which is a refusal rather than a pass.
//   3. Whoever holds the credential never executes. This module spawns; the child holds nothing.
//
// It never exits the process. The chat's worker calls `Deno.exit` on an unusable jail, which is
// right for a launcher and wrong for a library: `selectJavascriptJail` REPORTS what held and the
// caller decides whether to serve, refuse, or fall back.

import type { RadiaClient } from "../../sdk/ts/client.ts";
import { defaultConfiner, denoSandbox, type RunOptions, type RunResult, runCode, type SandboxSpec } from "./sandbox.ts";
import { declareSandbox, verifySandbox } from "./sandbox-registry.ts";
import { answer, type ToolAnswer } from "./tool-worker.ts";
import type { Tool, ToolContext } from "./agent-tools.ts";
import type { ToolDef } from "./capability.ts";

/** Output longer than this is stored as an artifact instead of inlined: a model paying for its own
 *  output in context is the reason the threshold exists at all. */
export const INLINE_MAX = 4000;

export interface JailChoice {
  spec: SandboxSpec;
  /** The confiner in force, or undefined for the bare Deno jail. */
  confine?: "bubblewrap" | "sandbox-exec";
  /** What a confiner FAILED, when one was tried and did not hold. Empty when confined. */
  unconfinedBecause: { claim: string; detail: string }[];
  /** Claims the bare jail failed. Non-empty means the jail does not match its own declaration and
   *  serving it would advertise a guarantee nothing checked. */
  refusedBecause: { claim: string; detail: string }[];
}

/**
 * Pick the JavaScript jail this host can actually provide, and say which one that is.
 *
 * Confined first, then the bare Deno jail. The order and the fallback are the chat's, and the
 * reason is measured (agent_docs/architecture-jail-confinement.md): unconfined, a JSON import reaches any
 * file this user can read, past the read roots and past `--deny-read`, because module loading is
 * not bounded by Deno's permissions. A mount namespace closes it. WHICH confiner is a platform
 * guess; WHETHER it works is the probe's answer.
 *
 * `networkTarget` is required for an honest `network: false`: a probe with nothing to dial cannot
 * tell an isolated jail from an offline machine, so it reports unverified. The space's own address
 * is the natural one, since a worker can already reach it.
 */
export async function selectJavascriptJail(opts: {
  networkTarget: string;
  readRoots?: string[];
  timeoutMs?: number;
  /** Somewhere OUTSIDE the read roots for the import probe's canary. Without it the import claim
   *  reports unverified, the confined jail is refused, and confinement silently never happens. */
  scratchDir?: string;
}): Promise<JailChoice> {
  const { networkTarget, readRoots = [], timeoutMs, scratchDir } = opts;
  const candidate = defaultConfiner();
  const confined = candidate
    ? denoSandbox({ name: "deno-confined", readRoots, ...(timeoutMs ? { timeoutMs } : {}), confine: candidate })
    : undefined;
  const unconfinedBecause = confined
    ? await verifySandbox(confined, {
      readRoots,
      ...(timeoutMs ? { timeoutMs } : {}),
      networkTarget,
      ...(scratchDir ? { scratchDir } : {}),
    }).then((r) => r.map((f) => ({ claim: f.claim, detail: String(f.detail ?? "") })))
      .catch((e) => [{ claim: "backend", detail: String(e) }])
    : [{ claim: "backend", detail: `no confiner on this host` }];

  if (unconfinedBecause.length === 0 && confined && candidate) {
    return { spec: confined, confine: candidate, unconfinedBecause: [], refusedBecause: [] };
  }
  // FALL BACK rather than refuse: a host without bubblewrap keeps the jail it has always had, and
  // the record says which one ran. Never claim more than was verified.
  const bare = denoSandbox({ name: "deno", readRoots, ...(timeoutMs ? { timeoutMs } : {}) });
  const refusedBecause = (await verifySandbox(bare, { readRoots, ...(timeoutMs ? { timeoutMs } : {}), networkTarget }))
    .map((f) => ({ claim: f.claim, detail: String(f.detail ?? "") }));
  return { spec: bare, unconfinedBecause, refusedBecause };
}

export interface ExecToolsOptions {
  /** The jail to run in, from `selectJavascriptJail`. Declared as a record by `serveExecTools`. */
  jail: JailChoice;
  /** Absolute paths the program may read. Empty means no filesystem at all, which is the default
   *  posture and the one the tool description states. */
  readRoots?: string[];
  timeoutMs?: number;
  /**
   * Fields this app's grants bind, stamped on everything this tool WRITES: the `tool_result` body
   * and any artifact it stores. The app's, not this module's: a conversation stamps
   * `{conversationId, owner}`, a team stamps `{team}`.
   *
   * Not optional in practice wherever grants are pattern-scoped. `bodyMatchesGrant` refuses a write
   * carrying another scope's label OR NO LABEL AT ALL, so on a team space an unstamped
   * `tool_result` is refused and the answer never lands.
   */
  meta?: (ctx: ToolContext) => Record<string, string | number | boolean | null>;
  /** Output longer than this is stored rather than returned. */
  inlineMax?: number;
}

/** `run_javascript`, ready for `serveTools`: the tool, its schema, and the jail it declares. */
export function execTools(client: RadiaClient, opts: ExecToolsOptions): {
  tools: Record<string, Tool>;
  schemas: ToolDef[];
  spec: SandboxSpec;
} {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const readRoots = opts.readRoots ?? [];
  const inlineMax = opts.inlineMax ?? INLINE_MAX;

  const run: Tool = async (args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolAnswer> => {
    const source = typeof args?.code === "string" ? args.code : typeof args?.source === "string" ? args.source : "";
    if (!source.trim()) {
      // A REFUSAL IS AN ANSWER, never a nack: an empty program will still be empty on redelivery,
      // and a nack turns a caller's mistake into a retry loop.
      return answer({ ok: false, stderr: "no code: pass the program as `code`" }, {
        ok: false,
        ...(ctx && opts.meta ? { meta: opts.meta(ctx) } : {}),
      });
    }
    const r: RunResult = await runCode(source, {
      timeoutMs,
      readRoots,
      ...(opts.jail.confine ? { confine: opts.jail.confine } : {}),
    } as RunOptions);

    const stored = await store(client, r, args, ctx, opts, inlineMax);
    return answer({
      ok: r.ok,
      stdout: stored ? `${r.stdout.slice(0, 200)}…[stored as ${stored.artifactId}]` : r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      ms: r.ms,
      sandbox: opts.jail.spec.name,
      ...(stored ?? {}),
    }, {
      ok: r.ok,
      // Onto the RESULT BODY as well as the artifact: the record this answer becomes is subject to
      // the same pattern-scoped grant as any other write.
      ...(ctx && opts.meta ? { meta: opts.meta(ctx) } : {}),
      // What the jail could have CONTRIBUTED. `[]` means "raise nothing", which is not the same as
      // asserting the result is unclassified: the runtime still unions the parents' labels and adds
      // `foreign` when the caller is another agent, so a cross-agent call is labelled either way.
      taint: readRoots.length > 0 ? ["file"] : [],
    });
  };

  return {
    tools: { run_javascript: run },
    spec: opts.jail.spec,
    schemas: [{
      type: "function",
      function: {
        name: "run_javascript",
        description: `Run JavaScript in a sandbox and get its output back. Print results with ` +
          `console.log; stdout is what you get back. The sandbox has NO network, NO environment ` +
          `variables and cannot start processes, so fetch and Deno.env fail. ` +
          (readRoots.length > 0
            ? `It CAN read files under: ${readRoots.join(", ")}, and nothing outside them. `
            : `It has NO filesystem access. `) +
          `It cannot see the space: pass any data you need INSIDE the code as literals. Runs for at ` +
          `most ${Math.round(timeoutMs / 1000)}s. Output over ${inlineMax} characters is stored as ` +
          `an artifact and you get its id instead. The result is CLASSIFIED as untrusted, so an ` +
          `agent reading it may refuse it. Returns {ok, stdout, stderr, exitCode, timedOut, ms}.`,
        parameters: {
          type: "object",
          properties: {
            code: { type: "string", description: "The JavaScript program. Print with console.log." },
            save_as: { type: "string", description: "Store stdout as an artifact with this filename." },
          },
          required: ["code"],
        },
      },
    }],
  };
}

/** Oversized or explicitly-saved output, as an artifact parented on the call. Best effort: a bad
 *  media type must not swallow the output the caller actually asked for. */
async function store(
  client: RadiaClient,
  r: RunResult,
  args: Record<string, unknown> | undefined,
  ctx: ToolContext | undefined,
  opts: ExecToolsOptions,
  inlineMax: number,
): Promise<{ artifactId: string; size: number } | undefined> {
  const saveAs = typeof args?.save_as === "string" ? args.save_as : undefined;
  if (r.stdout.length === 0 || !(saveAs || r.stdout.length > inlineMax)) return undefined;
  try {
    const a = await client.putArtifact(new TextEncoder().encode(r.stdout), {
      mediaType: "text/plain",
      ...(saveAs ? { filename: saveAs } : {}),
      // LINEAGE: `callId` is the claimed record's own id (`serveTools`), so the bytes hang off the
      // call that produced them and `space_children` finds them from the call.
      ...(ctx?.callId ? { parentIds: [ctx.callId] } : {}),
      taint: (opts.readRoots ?? []).length > 0 ? ["file"] : [],
      meta: (ctx && opts.meta?.(ctx)) ?? {},
    });
    return { artifactId: a.id, size: a.size };
  } catch (e) {
    r.stderr += `\n[artifact not stored: ${e}]`;
    return undefined;
  }
}

/** Declare the jail as a record, so "what can this space execute, and under what guarantees" is a
 *  query rather than a deployment script. A `check` naming a jail that never landed in the registry
 *  leaves that reference dangling. */
export async function declareExecJail(client: RadiaClient, jail: JailChoice): Promise<void> {
  await declareSandbox(client, jail.spec);
}
