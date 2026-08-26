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
import { assertReadable, type ConversationKey, openBody, sealBody } from "./encrypted.ts";
import { asTurnReply, parseArgs, type TurnKinds } from "./turn.ts";
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

/**
 * Seal a worker's reply under the conversation's key, whichever shape it took.
 *
 * The kind decides the fields (`ENCRYPTED_FIELDS`), so this is one call rather than a branch: a
 * bare call's `tool_result.output` and a slotted call's transcript `message.content` are both
 * covered, and a reply of any other shape passes through untouched.
 */
async function sealReply<T extends { kind?: string; body?: unknown }>(
  reply: T,
  key: ConversationKey | undefined,
): Promise<T> {
  if (!key || typeof reply?.kind !== "string" || typeof reply.body !== "object" || reply.body === null) return reply;
  return { ...reply, body: await sealBody(reply.body as Record<string, unknown>, reply.kind, key) };
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
  /**
   * Tool calls served AT ONCE. Default 1 (sequential), because a tool worker's cost profile is
   * the tool's, not the harness's: raise it for a worker whose tools WAIT (a query, an HTTP
   * fetch), leave it at 1 for one whose tools WORK (spawning a jail, encoding an image), where
   * overlapping trades latency for contention. See agent_docs/plan-scaling.md.
   */
  concurrency?: number;
  /** Passed through to `agentLoop`: false serves on the tick alone, for a host that cannot spend a
   *  connection per kind on wakeups (a browser tab). */
  watch?: boolean;
  kinds?: Partial<TurnKinds>;
  signal?: AbortSignal;
  /**
   * This worker's way to a conversation's DEK (plan-encryption.md phase 4), or absent for a fleet
   * serving plaintext conversations only.
   *
   * A PORT, for the reason the inference worker's is: how a key is fetched and who may is app
   * policy. `owner` goes with the id so the lookup is bounded by the CALLER rather than trusting a
   * reference that arrived in a body.
   */
  keys?: (conversationId: string, owner?: string) => Promise<ConversationKey | undefined>;
}

/**
 * Delegated clients for one worker, keyed on the claimed record's AUTHOR RUN.
 *
 * PER `serveTools` CALL, never module-level, and that is a correctness rule rather than tidiness:
 * the key is the author alone, so a module-level map shared by two workers in one process would
 * hand worker A the credential worker B minted — a different worker's authority, under the same
 * caller. One process runs one tool worker today; nothing enforces that, and the failure would be
 * silent.
 *
 * The author run is server-assigned (`created_by`) and its delegation is immutable, so two calls
 * from one author resolve to the same caller. Keying on a body field would be an escalation, since
 * a body naming somebody else's conversation would then reuse their credential.
 */
function delegatedClients(c: RadiaClient) {
  const byAuthor = new Map<string, { client: RadiaClient; until: number }>();
  return async function callerClient(rec: RadiaRecord): Promise<RadiaClient> {
    const author = rec.runtimeMeta?.createdBy;
    if (!author) return c;
    const now = Date.now();
    const hit = byAuthor.get(author);
    if (hit && hit.until > now + 60_000) return hit.client;
    // Drop what has lapsed before adding. Author runs ROTATE (a person's run has a 12h ceiling and
    // a fresh one per login), so without this a long-lived shared worker — the deployment this
    // whole mechanism exists for — accumulates one dead entry per run for as long as it runs.
    for (const [k, v] of byAuthor) if (v.until <= now) byAuthor.delete(k);
    try {
      const d = await c.delegatedClient(rec.id);
      byAuthor.set(author, { client: d.client, until: Date.parse(d.expiresAt) });
      return d.client;
    } catch (e) {
      // Safe to fall back — the grants a worker may exercise only for a caller live under a
      // `delegable:` principal its own token cannot reach — but the later `forbidden` reads as a
      // grant bug unless the cause is on the record.
      console.error(`[tool-worker] no delegated run for ${author} (${e}); this call runs with the worker's own reach`);
      return c;
    }
  };
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
  const callerClient = delegatedClients(client);
  const served: string[] = [];
  for (const name of Object.keys(opts.tools)) {
    const def = opts.schemas.find((s) => s.function.name === name);
    if (!def) continue;
    await publishCapability(client, def, provider);
    served.push(name);
  }

  await agentLoop<ToolCallBody>(client, {
    name: opts.name ?? provider,
    // One pattern per NAME, never `tool_call` wholesale: claiming the kind would steal other
    // workers' work, and content-routing per name is the whole point.
    patterns: Object.keys(opts.tools).map((tool) => ({ kind: "tool_call", match: { tool } })),
    ...(opts.leaseSeconds ? { leaseSeconds: opts.leaseSeconds } : {}),
    ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
    ...(opts.watch === false ? { watch: false } : {}),
    handle: async (rec, c) => {
      const raw = rec.body;
      const callId = rec.id;
      const ctx: ToolContext = { callId, conversationId: raw.conversationId, owner: raw.owner, caller: () => callerClient(rec) };
      const stage = opts.stage?.(raw.tool ?? "");
      if (stage) await progress(c, { ...ctx, stage, by: provider, note: raw.tool }, [callId]);
      let a: ToolAnswer;
      let b = raw;
      // Resolved before anything reads the arguments, and OUTSIDE the try: a conversation whose key
      // this worker cannot reach must not look like a tool that failed. `assertReadable` below is
      // what turns that into a refusal naming the reader.
      const key = raw.conversationId && opts.keys
        ? await opts.keys(raw.conversationId, raw.owner).catch(() => undefined)
        : undefined;
      try {
        // A tool ACTS on its arguments, so ciphertext reaching one is not a garbled read: it is a
        // file written or a service called with bytes nobody meant (plan-encryption.md phase 1).
        // The refusal is an ANSWER rather than a nack, per this file's rule and because a body this
        // build cannot decrypt will not become decryptable on redelivery — raising to the loop
        // would poison the queue with one record forever.
        if (key) b = await openBody(raw as Record<string, unknown>, "tool_call", key) as ToolCallBody;
        assertReadable(b, `tool ${raw.tool}`);
        // What an opened `args` holds is the model's RAW argument string: the turn worker copied a
        // blob it could not read rather than parsing it (./turn.ts), so the parse happens here, on
        // the far side of the key. An unencrypted call already arrives parsed.
        if (typeof b.args === "string") b = { ...b, args: parseArgs(b.args) };
        const bad = b.args?._unparsed !== undefined ? b.args : null;
        if (bad) {
          // Refuse BEFORE the tool, and name the real problem. Handed `{_unparsed}`, a tool reports
          // whichever required field it misses first, so a malformed payload is refused as a missing
          // argument the model did send and it retries the same doomed call (`parseArgs`, ./turn.ts).
          a = answer(
            `the arguments for ${b.tool} were not valid JSON and could not be repaired: ${bad._parseError}. ` +
              `Most often a long string contains a raw newline instead of \\n. Send them again, ` +
              `escaped, or split the work into smaller calls.`,
            { ok: false },
          );
        } else {
          const out = await opts.tools[b.tool ?? ""](b.args ?? {}, ctx);
          a = isAnswer(out) ? out : answer(out);
        }
      } catch (e) {
        a = answer(e instanceof Error ? e.message : String(e), { ok: false });
      }
      // Sealed on the way back under the SAME key, so a tool's output does not undo the thread's
      // encryption. `sealReply` covers both shapes an answer takes: a `tool_result` for a bare call
      // and a transcript `message` for a slotted one.
      return await sealReply(asTurnReply(rec, toolResult(callId, b, a), opts.kinds), key);
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return served;
}
