// A worker that serves named tools as claimed work.
//
// The shape every tool worker repeats: publish a `capability` per tool so agents discover it, claim
// `tool_call{tool}` one pattern per name, run the tool, and answer with a `tool_result` — or, when
// the call carries a turn slot, with the transcript reply itself (`asTurnReply`, ./turn.ts).
//
// WHY THIS IS SHARED AND NOT COPIED. The answer envelope is five fields
// (`callId`, `conversationId`, `owner`, `ok`, `output`), and `callId` is the one that matters: a
// reply without it leaves the caller waiting out its deadline for an answer that already exists.
// Hand-built at sixteen sites across three workers, it is the same hazard that produced this
// codebase's recurring bug — a record rebuilt by hand quietly missing a field that the next reader
// needs. One envelope, one place.
//
// A FAILED CALL IS AN ANSWER, never a nack. The model should see "that tool refused and why" and
// try something else; a nack retries the same doomed call at cost and tells nobody.

import { agentLoop } from "../../sdk/ts/loop.ts";
import type { RadiaClient, RadiaRecord } from "../../sdk/ts/client.ts";
import { publishCapability, type ToolDef } from "./capability.ts";
import { progress } from "./progress.ts";
import { asTurnReply, type TurnKinds } from "./turn.ts";
import type { Tool, ToolContext } from "./agent-tools.ts";

/** A `tool_call` body, in the fields this harness reads. */
export interface ToolCallBody {
  tool?: string;
  args?: Record<string, unknown>;
  conversationId?: string;
  owner?: string;
}

const ANSWER = Symbol("radia.toolAnswer");

/** A result that carries more than a value: lineage, labels, or an explicit refusal. */
export interface ToolAnswer {
  [ANSWER]: true;
  ok: boolean;
  output: unknown;
  /** The DATA the answer came from, so taint rides lineage instead of being asserted. */
  parentIds?: string[];
  taint?: string[];
  /** Extra BODY fields beside the five. For what belongs on the record but not in `output`: only
   *  `output` is serialized back into a model's thread, so provenance recorded here is auditable by
   *  query without spending context tokens on every call. */
  meta?: Record<string, unknown>;
}

/**
 * Return this from a tool that needs to say more than its value.
 *
 * A plain return is `ok: true` with no parents and no labels, which is what most tools want.
 * Refusing is `answer(why, {ok: false})`; throwing does the same with the error's message.
 */
export function answer(
  output: unknown,
  opts: { ok?: boolean; parentIds?: string[]; taint?: string[]; meta?: Record<string, unknown> } = {},
): ToolAnswer {
  return { [ANSWER]: true, ok: opts.ok ?? true, output, ...opts };
}

const isAnswer = (v: unknown): v is ToolAnswer =>
  typeof v === "object" && v !== null && (v as Record<PropertyKey, unknown>)[ANSWER] === true;

/**
 * The answer envelope, and the ONE place it is built.
 *
 * `taint` is passed through rather than defaulted, because an empty array and an absent one differ
 * to the runtime: absent means "raise nothing", which is not the same as asserting the result is
 * unclassified.
 */
export function toolResult(
  callId: string,
  b: ToolCallBody,
  a: ToolAnswer,
): { kind: string; body: Record<string, unknown>; parentIds?: string[]; taint?: string[] } {
  return {
    kind: "tool_result",
    body: { callId, conversationId: b.conversationId, owner: b.owner, ...a.meta, ok: a.ok, output: a.output },
    ...(a.parentIds?.length ? { parentIds: a.parentIds } : {}),
    ...(a.taint ? { taint: a.taint } : {}),
  };
}

export interface ServeOptions {
  /** This worker's principal. Namespaces its advertisements, so two workers serving one name are
   *  distinguishable rather than silently replacing each other (./capability.ts). */
  provider: string;
  /** Tool name -> implementation. */
  tools: Record<string, Tool>;
  /** Definitions to advertise, matched to `tools` BY NAME. A tool with no definition is served but
   *  never advertised, which is how a worker keeps something callable without offering it. */
  schemas: ToolDef[];
  /** What to report before running a tool. Omit, or return undefined, for tools that answer fast
   *  enough that a status line is noise. */
  stage?: (tool: string) => string | undefined;
  /** For a loop label; defaults to `provider`. */
  name?: string;
  leaseSeconds?: number;
  kinds?: Partial<TurnKinds>;
  signal?: AbortSignal;
}

/**
 * Advertise the tools, then claim and serve them until aborted.
 *
 * Returns the names actually advertised, which is what a launcher needs in order to withdraw them
 * later: a worker cannot reliably retire its own advertisements, because a signal handler races its
 * own death (./capability.ts).
 */
export async function serveTools(client: RadiaClient, opts: ServeOptions): Promise<string[]> {
  const provider = opts.provider;
  const served: string[] = [];
  for (const name of Object.keys(opts.tools)) {
    const def = opts.schemas.find((s) => s.function.name === name);
    if (!def) continue;
    await publishCapability(client, def, provider);
    served.push(name);
  }

  await agentLoop(client, {
    name: opts.name ?? provider,
    // One pattern per NAME, never `tool_call` wholesale: claiming the kind would steal other
    // workers' work, and content-routing per name is the whole point.
    patterns: Object.keys(opts.tools).map((tool) => ({ kind: "tool_call", match: { tool } })),
    ...(opts.leaseSeconds ? { leaseSeconds: opts.leaseSeconds } : {}),
    handle: async (rec: RadiaRecord, c: RadiaClient) => {
      const b = rec.body as ToolCallBody;
      const callId = rec.id;
      const ctx: ToolContext = { callId, conversationId: b.conversationId, owner: b.owner };
      const stage = opts.stage?.(b.tool ?? "");
      if (stage) await progress(c, { ...ctx, stage, by: provider, note: b.tool }, [callId]);
      let a: ToolAnswer;
      try {
        const out = await opts.tools[b.tool ?? ""](b.args ?? {}, ctx);
        a = isAnswer(out) ? out : answer(out);
      } catch (e) {
        a = answer(e instanceof Error ? e.message : String(e), { ok: false });
      }
      return asTurnReply(rec, toolResult(callId, b, a), opts.kinds);
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return served;
}
