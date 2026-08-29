// Bundled MCP adapter (Phase 7). `radia mcp` serves the space to an MCP-capable harness over
// stdio, so a model participates in coordination with one line of harness config and no SDK.
//
// Two properties the plan calls for, and why they matter:
//
// 1. **Credentials stay outside the model context.** The adapter resolves a credential itself
//    (src/credentials.ts) and attaches it to every request: the OBSERVER by default (ops reads
//    only, architecture-ops-tiers.md), `RADIA_TOKEN` as the explicit override, the operator token only
//    as a legacy fallback. No token appears in a tool schema, a tool result, or an error.
//
//    THE SCOPE OF THAT CLAIM IS THIS PROCESS, and it used to be written as though it were the
//    model's whole world. It is not: the token sits in the harness's own config file or its
//    environment, both of which an agent with a shell or a file reader can open, and one did the
//    moment a tool refused it something (it wanted an image's bytes, was told to "use a client
//    that can download it", and went looking for a credential). So the property is "nothing HERE
//    hands the model a token", never "the model cannot obtain one". What bounds a leaked token is
//    what it was granted, which is why a team member holds one team and nothing else.
//
// 2. **Leases heartbeat internally.** `space_take` hands the model an opaque `claimId`, never
//    the fenced lease. The adapter holds the real lease and renews it at lease/3 in the
//    background, so a model that spends two minutes thinking does not lose its claim. Settling
//    by `claimId` stops the heartbeat. The model cannot forge, replay, or hand off a lease it
//    never sees.
//
// Everything else is discovered, not hardcoded: `space_kinds` queries `kind_def` records, so a
// kind declared after startup is immediately usable. There is no table of known kinds here.
//
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout. stdout carries protocol frames
// ONLY. Every log line goes to stderr, or the harness sees a corrupt stream.

import { awaitResult, RadiaClient, RadiaClientError } from "../../../sdk/ts/client.ts";
import { defaultBase, resolveDefinitionToken, resolveToken, saveSession, storedObserver, storedSession } from "../../credentials.ts";
import { env } from "../../platform.ts";
import type { Lease, RadiaRecord } from "../../storage/adapter.ts";
import type { Pattern } from "../../core/matching.ts";
import { TOOLS } from "./tools.ts";
import { ScopeFiller } from "./scope.ts";
import { classify, fileTracer, type Tracer } from "./trace.ts";
import { answer, one } from "./render.ts";
import { getLogger } from "../../log.ts";
import { mediaTypeForPath } from "../media.ts";
// A SURFACE MAY IMPORT AN EXTENSION, and this is the reason the rule exists: a workspace is a
// convention built on `/v0`, so the adapter offers the same functions the chat and `radia
// workspaces` call rather than a second spelling of the tree format. The digest is normative
// (`extensions/conformance/`), which is also why a model cannot hand-write a manifest.
import { editWorkspace, readWorkspace, summarizeWorkspaces, writeWorkspace } from "../../../extensions/ts/workspace.ts";
import { newer } from "../../../sdk/ts/registry.ts";
import { ARTIFACT } from "../../../sdk/ts/wire.ts";
import { flag } from "../../flags.ts";
import { readBinaryFile, stdin, writeStdout } from "../../platform.ts";
import { VERSION } from "../../version.ts";

// The third place this string used to be written by hand. An MCP client shows it in its own
// server list, so a stale literal here misreports the build to a person reading someone else's UI.
const SERVER_INFO = { name: "radia", version: VERSION };
/** `explainQuery`'s page note, which `space_query` states itself with the caller's own limit rather
 *  than the probe's. Exported for the guard in `test/trace.test.ts`. */
export const PROBE_NOTE = /filled the limit/;
/** Echoed back to the client when it asks for a version we know; otherwise we answer with this. */
const DEFAULT_PROTOCOL = "2025-06-18";
/** Every revision this adapter speaks, legacy and modern. `2026-07-28` made the protocol stateless
 *  and replaced the handshake with per-request `_meta`; the older three are handshake-based and are
 *  what today's harnesses actually send. */
const KNOWN_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", DEFAULT_PROTOCOL, "2026-07-28"]);
/** `_meta` key carrying a modern request's protocol version. */
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
/** `_meta` key a server SHOULD put its identity under, so a stateless client can name us with no
 *  prior handshake to have learned it from. */
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
/** One capability set for both eras. `listChanged: false` is honest: nothing here pushes, so a
 *  client must not wait for a notification we never send. */
const CAPABILITIES = { tools: { listChanged: false } };

/** Guidance for a model driving this adapter, identical in both eras. A DISPOSITION plus how to
 *  start, never knowledge OF the space: what kinds exist is discovered, not taught. */
function instructions(base: string): string {
  return `A Radia coordination space at ${base}. Agents exchange immutable JSON records and claim ` +
    `work by pattern matching, not by addressing. Start with space_kinds to discover what record ` +
    `kinds exist, how each is indexed, and how each is meant to be used. Nothing about this space ` +
    `is implied by the tool list. Claim work with space_take and settle it with space_ack; the ` +
    `lease is held and renewed for you.`;
}

interface Claim {
  lease: Lease;
  record: RadiaRecord;
  timer: ReturnType<typeof setInterval>;
  /** Set when the heartbeat learned this lease is no longer ours: the record was reclaimed or
   *  force-transitioned (`lease_lost`), or the credential stopped working (401/403). The claim
   *  stays in the map so a settle can SAY so; dropping it would tell the model "unknown claimId",
   *  which reads like its own mistake rather than the space taking the work back. */
  lost?: "lease_lost" | "credential";
}

export async function runMcp(argv: string[]): Promise<void> {
  const base = flag(argv, "--url") ?? defaultBase();
  // The OBSERVER is the default (architecture-ops-tiers.md phase 5): the model behind this adapter gets
  // unscoped ops READS and nothing else, so it can inspect the space and cannot write grants,
  // coordinate ungranted, or destroy anything. `RADIA_TOKEN` stays the explicit override for a
  // caller that WANTS a differently-scoped session (a login, a worker run, or the operator);
  // the operator token is only the fallback for a space provisioned before observers existed.
  //
  // AN EMPTY VARIABLE IS AN ABSENT ONE. Harness configs and wrapper scripts routinely set every
  // variable they know about, empty ones included; `??` keeps `""`, which then reads as "the
  // caller chose an override" for one branch and as "nothing was set" for the next, so an
  // exported `RADIA_TOKEN=` silently discarded the `RADIA_DEFINITION_TOKEN` beside it and the
  // adapter came up as the observer, which cannot coordinate.
  const set = (name: string) => env(name) || undefined;
  const explicit = set("RADIA_TOKEN") ?? set("RADIA_DEFINITION_TOKEN");
  const observer = explicit ? undefined : storedObserver(base)?.definitionToken;
  // THE DURABLE HALF, for an adapter given an identity of its own. Without it a per-agent session
  // is a run token that stops working in 15 minutes and cannot mint another, which is exactly the
  // failure `ClientAuth.definitionToken` exists to end — and it was reachable only by the observer,
  // so the one credential that could not coordinate was the only one that survived the day.
  const definitionToken = observer ?? resolveDefinitionToken(base);
  const token = definitionToken ? undefined : resolveToken(base);
  // A NAMED SESSION keeps its principal across restarts. A run IS the principal in `created_by`,
  // so "the same session" means the same RUN, and the name is SUPPLIED rather than derived: no
  // harness exposes a session identity portably, and guessing one from a pid or a cwd would give a
  // different principal every restart, which is the thing this exists to prevent.
  //
  // The stored run is handed over as the bearer half WITH the durable half behind it, so the
  // session resumes on the same run and still recovers on its own once that run passes its 12h
  // ceiling. Without a name, each start is its own run (below).
  const session = flag(argv, "--session") ?? env("RADIA_SESSION");
  const resumed = session && definitionToken ? storedSession(base, session)?.token : undefined;

  // `reuseRun` FOR THE OBSERVER ONLY. It exists so a short-lived reader does not append an
  // `agent_run` per invocation (plan-startup-ergonomics.md item 4), and the observer is that.
  //
  // A PER-AGENT adapter must NOT reuse: two sessions of the same agent are two processes holding
  // one definition token, and sharing a run would make their records indistinguishable by author
  // and `radia runs --stop` end both. Its own run per session is what makes a session the unit you
  // can attribute work to and stop. CLAUDE.md states the rule on `ClientAuth.reuseRun`.
  const client = new RadiaClient(
    base,
    definitionToken
      ? { definitionToken, ...(resumed ? { token: resumed } : {}), ...(observer ? { reuseRun: true } : {}) }
      : token
      ? { token }
      : {},
  );

  // Resolve the credential NOW and remember whichever run we ended on, which is not necessarily
  // `resumed`: a run past its ceiling is replaced by the exchange, and storing the value we were
  // built with would hand the next start a token that is already dead (`bearerToken` exists for
  // exactly this). Best effort: a session that cannot be remembered still works, it just starts
  // fresh next time, and saying so beats failing to start.
  if (session && definitionToken) {
    try {
      await client.ensureCredential();
      const now = client.bearerToken;
      if (now) saveSession(base, session, { token: now, definitionToken, mintedAt: new Date().toISOString() });
    } catch { /* the space is unreachable; the tool calls below will say so */ }
  }
  const claims = new Map<string, Claim>();
  // Fills in the body fields the caller's own grants require, learned from a refusal (scope.ts).
  const scope = new ScopeFiller(client);
  // `claimable` per kind, read once and kept: it decides what a tool result ADVISES, never what it
  // does, so a stale value costs a sentence rather than a wrong operation.
  const kinds = new Map<string, boolean>();

  log(`radia mcp: space=${base} auth=${
    observer
      ? "observer (ops reads; coordination needs grants — see radia permissions agent:local-observer)"
      : definitionToken
      ? "definition token (renews itself; this adapter acts as its own agent)"
      : token
      ? "bearer token (expires; set RADIA_DEFINITION_TOKEN for a session that renews)"
      : "none (open local space)"
  }${
    session
      ? ` session=${session} (${resumed ? "resumed its run" : "new run; restarts reuse it"})`
      : definitionToken && !observer
      ? " session=none (each start is a new run; pass --session <name> to keep one across restarts)"
      : ""
  }`);
  // THE DEFINITION TOKEN COUNTS. `token` is deliberately undefined whenever one is present (it is
  // the bearer half, and a definition token mints its own), so this said "no credential found" to
  // every per-agent session on the line after announcing "auth=definition token". Found by the
  // first real agent-lab run, where both harnesses printed it while working perfectly.
  if (!observer && !token && !definitionToken) {
    log("radia mcp: no credential found. Start `radia dev` (auto-provisions one) or set RADIA_TOKEN.");
  }

  // `--trace` records what the MODEL ASKED FOR, which no other surface can see: a claim that
  // matched nothing writes no event, so the space cannot tell a bad pattern from an idle queue
  // (agent_docs/plan-agent-lab.md). Off unless asked for, and never fatal.
  const tracePath = flag(argv, "--trace");
  let trace: Tracer | undefined;
  if (tracePath) {
    trace = fileTracer(tracePath, log);
    // Stamped on every line so a run with several agents can be split by author afterwards.
    // Resolved ONCE, best effort: a space that cannot answer still gets traced, unattributed.
    //
    // THE CREDENTIAL FIRST, or `health` answers `anonymous` (see `scope.ts`) and every line of the
    // file is stamped with that. Only the `--session` branch above resolves one, so a trace taken
    // without a session name is exactly the case that lost its author.
    await client.ensureCredential().catch(() => {});
    const principal = await client.health().then((h) => h.principal, () => undefined);
    const identity = { session, principal };
    const inner = trace;
    trace = { call: (e) => inner.call({ ...identity, ...e }) };
    log(`radia mcp: tracing tool calls to ${tracePath}${principal ? ` as ${principal}` : ""}`);
  }

  for await (const msg of frames(stdin())) {
    const res = await handle(msg, client, claims, base, scope, kinds, trace);
    if (res) write(res);
  }
  // Stdin closed. What that MEANS depends on whether this process has an identity it can come back
  // as, and MCP 2026-07-28 is explicit that the process is not the boundary: "an open connection,
  // such as a STDIO process, is not a conversation or session", and clients "SHOULD NOT use an
  // individual task, thread, or conversation as the lifetime boundary for the stdio process".
  //
  // ANONYMOUS: releasing is right. Each start is its own run, a settle is owner-bound, so nothing
  // that comes later can ever finish this work. Holding the lease would make the space wait out a
  // claim nobody can settle.
  //
  // NAMED SESSION: releasing is WRONG, and was. The run survives, so the next process settles the
  // claim by id (`recoverClaim`), and giving the record back here hands a teammate work that is
  // already half done, which is the exact thing a lease exists to prevent.
  for (const [, c] of claims) {
    clearInterval(c.timer);
    if (!session) await client.release(c.lease).catch(() => {});
  }
  if (session && claims.size > 0) {
    log(`radia mcp: ${claims.size} claim(s) still held for session=${session}; settle them by claimId when you return`);
  }
}

// ---- JSON-RPC plumbing ----

interface Req {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

async function handle(
  req: Req,
  client: RadiaClient,
  claims: Map<string, Claim>,
  base: string,
  scope: ScopeFiller,
  kinds: Map<string, boolean>,
  trace?: Tracer,
): Promise<unknown | null> {
  const { id, method } = req;
  // A notification (no id) never gets a reply, per JSON-RPC.
  const isNotification = id === undefined || id === null;

  // A MODERN request names its protocol version in `_meta`; a legacy one names it once, in
  // `initialize`. Refusing an unknown one by NAMING what we speak is what lets a client retry with
  // a mutually supported version instead of failing blind (spec: UnsupportedProtocolVersionError).
  const wanted = (req.params?._meta as Record<string, unknown> | undefined)?.[META_VERSION];
  if (typeof wanted === "string" && !KNOWN_PROTOCOLS.has(wanted) && !isNotification) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: { supported: [...KNOWN_PROTOCOLS].sort().reverse(), requested: wanted },
      },
    };
  }

  switch (method) {
    // LEGACY ERA. Kept alongside `server/discover` rather than replaced: the SDK's own client
    // defaults to this handshake ("byte for byte", per its migration guide), no deprecation date
    // exists on either side, and a dual-era server is what the spec's compatibility matrix says
    // works for every client era. Dropping it would break today's harnesses to satisfy nobody.
    case "initialize": {
      const want = String((req.params?.protocolVersion as string) ?? "");
      return reply(id, {
        protocolVersion: KNOWN_PROTOCOLS.has(want) ? want : DEFAULT_PROTOCOL,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: instructions(base),
      });
    }

    // MODERN ERA (2026-07-28). The protocol became STATELESS: no handshake, every request carries
    // its own version and capabilities in `_meta`, and a stdio process is explicitly "not a
    // conversation or session". `server/discover` is what a dual-era client probes with, and a
    // server MUST implement it; answering it is also how such a client learns we are modern rather
    // than falling back.
    case "server/discover":
      return reply(id, {
        supportedVersions: [...KNOWN_PROTOCOLS].sort().reverse(),
        capabilities: CAPABILITIES,
        instructions: instructions(base),
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return isNotification ? null : reply(id, {});

    case "tools/list":
      return reply(id, { tools: TOOLS });

    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      // ONE dispatch, so the trace is complete by construction: a tool added later is traced
      // without anybody remembering to trace it.
      const started = Date.now();
      try {
        const text = await call(name, args, client, claims, scope, kinds, base);
        trace?.call({ tool: name, args, ...classify(text), ms: Date.now() - started });
        return reply(id, { content: [{ type: "text", text }] });
      } catch (e) {
        // Tool-level failures are results with isError, not JSON-RPC errors, so the model should
        // see them and adapt (a rejected pattern says why), not have the call disappear.
        // The runtime's own code when there is one, and otherwise a short message: a lab has to
        // tell a REFUSAL (`forbidden`, `undeclared_path`) from a space that was not there, and both
        // arrive here as a thrown thing. An empty label makes them look identical.
        const error = e instanceof RadiaClientError ? e.code : ((e as Error).message ?? "error").slice(0, 120);
        trace?.call({ tool: name, args, outcome: "error", error, ms: Date.now() - started });
        return reply(id, { content: [{ type: "text", text: errorText(e) }], isError: true });
      }
    }

    default:
      if (isNotification) return null;
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } };
  }
}

/**
 * A JSON-RPC result, stamped for both eras.
 *
 * `resultType` became REQUIRED on every result in 2026-07-28, where it is what lets a client tell a
 * finished answer from one still asking (`input_required`) or from a task handle. Adding it is safe
 * for every older client: the spec makes an ABSENT `resultType` mean `"complete"`, so a legacy
 * client that ignores the field reads exactly what it read before.
 *
 * `serverInfo` rides in `_meta` for the same reason it exists there: a stateless client had no
 * handshake to learn our name from.
 */
function reply(id: unknown, result: Record<string, unknown> | unknown) {
  const body = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const meta = { ...(body._meta as Record<string, unknown> | undefined), [META_SERVER_INFO]: SERVER_INFO };
  return { jsonrpc: "2.0", id, result: { resultType: "complete", ...body, _meta: meta } };
}

/** Never surfaces the credential: RadiaClientError carries the server's RFC 9457 detail only. */
function errorText(e: unknown): string {
  if (e instanceof RadiaClientError) return `${e.code}: ${e.message.replace(/^[^:]*:\s*/, "")}`;
  return (e as Error).message ?? String(e);
}

// ---- tool dispatch ----

async function call(
  name: string,
  a: Record<string, unknown>,
  client: RadiaClient,
  claims: Map<string, Claim>,
  scope: ScopeFiller,
  kinds: Map<string, boolean>,
  base: string,
): Promise<string> {
  switch (name) {
    case "space_health":
      // EXCHANGE FIRST. `/v0/health` is public, so an unauthenticated request gets a cheerful
      // `principal: "anonymous"` rather than the 401 that would make the client mint a run. A model
      // whose first call is "who am I" was therefore told "nobody" while the adapter was holding a
      // perfectly good definition token, and the `agent` name below would be missing with it.
      await client.ensureCredential();
      return pretty(await client.health());

    case "space_permissions": {
      // SELF ONLY, and that is not a limitation to lift later: `http.ts` lets any principal read
      // its OWN permissions without an ops power (`asksAboutSelf`), and reading anybody else's
      // needs `observe`. Taking a principal argument would turn a call that always works into one
      // that sometimes 403s, on the exact surface a refused caller reaches for.
      //
      // The exchange first, like `space_health`: the durable name is what the answer is about, and
      // an unauthenticated adapter would ask about `anonymous`.
      await client.ensureCredential();
      const me = await client.health();
      // The AGENT where there is one: grants are held by agents, not by the runs they mint, and
      // `asksAboutSelf` accepts either the principal or the agent it resolves to (`http.ts`).
      return pretty(await client.permissions(me.agent ?? me.principal));
    }

    case "space_kinds":
      return answer("kinds", await client.listKinds());

    case "space_stats": {
      // The REPORT, never the bare array. A pattern-scoped member got `[]` from this call on a
      // space holding eight kinds and had nothing in the answer to say why (see render.ts).
      const r = await client.getStatsReport();
      return answer("stats", r.stats, { scope: r.scope });
    }

    case "space_doctor":
      return pretty(await client.diagnostics());

    case "space_put": {
      const kind = str(a, "kind");
      // The body may need fields the caller's own GRANT requires (a team label, say). Filled in
      // only after the runtime refuses the write for scope, so a put that was already correct is
      // sent exactly as the model wrote it. See scope.ts.
      const r = await scope.fill(kind, (extra) =>
        client.put({
          kind,
          body: { ...extra, ...obj(a, "body") },
          parentIds: Array.isArray(a.parentIds) ? a.parentIds as string[] : undefined,
        }, a.idempotencyKey ? String(a.idempotencyKey) : undefined));
      return pretty(r);
    }

    case "space_query": {
      // The pattern is the MODEL's, so `orderBy` is data here rather than something this call site
      // knows. A directional read cannot be combined with it (the space refuses, and the SDK now
      // refuses first), so the two cases dispatch instead of one silently losing.
      //
      // `queryPage` for BOTH, because it is the one that carries `scope` and `explain`; the two
      // convenience methods return `r.records` alone. The order is unchanged (no page argument
      // means the natural ascending id order, which is what `queryOldest` asks for).
      //
      // ONE PAST THE LIMIT, purely to answer "is this all of them?". No cursor is offered, because
      // this tool takes none to send back; that is CONTINUATION, and it is not what was missing.
      // What was missing is DISCLOSURE: a page that reports only its own size reads as a
      // population, and "3 available tasks" has already been said off this call about a space where
      // two of the three were finished.
      const p = pat(a);
      const n = num(a, "limit") ?? 50;
      const r = await client.queryPage(p, n + 1, undefined, { explain: true });
      const rows = r.records.slice(0, n);
      return answer("records", rows, {
        more: r.records.length > n,
        limit: n,
        remedy: "Use space_stats for totals, or narrow the match.",
        scope: r.scope,
        // The runtime's page note is dropped, and ONLY that one: it reports the limit it was
        // given, which is the probe (`n + 1`), so a caller that asked for 2 was told "results
        // filled the limit (3)" beside our own correct "more than 2 records match". It can only
        // appear when the probe filled, which is exactly when `more` is already saying it better.
        // Matched on the runtime's own wording, like `scope.ts`: a rename there drops the filter
        // rather than misfiring, and `test/trace.test.ts` holds the string.
        notes: r.explain?.filter((note) => !PROBE_NOTE.test(note)),
      });
    }

    case "space_read_one": {
      // The REPORT: a null here is either "no such record" or "none you may read", and a model
      // told only `null` reports the first when it means the second.
      const r = await client.readOneReport(pat(a));
      return one(r.record, { scope: r.scope, notes: r.explain });
    }

    case "space_get":
      return pretty(await client.getRecord(recordId(a)));

    case "space_lineage": {
      // The walk up is not paged: it ends at the roots, so there is no `more` to report.
      const r = await client.getLineageReport(recordId(a));
      return answer("lineage", r.lineage, { scope: r.scope });
    }

    case "space_children": {
      // Fan-out IS unbounded, so this one is a page and says so from the cursor the endpoint
      // already returns. A record with 300 children reported 100 and looked complete.
      const r = await client.getChildrenPage(recordId(a));
      return answer("children", r.children, {
        more: !!r.nextAfter,
        limit: r.children.length,
        // NOT the query remedy: there is no match to narrow here, and `space_stats` counts records
        // per kind, never the fan-out of one record. This tool takes no cursor either, so the only
        // true thing to say is that the count is a floor.
        remedy: "This tool returns one page and takes no cursor, so treat the count as a floor rather than the fan-out.",
        scope: r.scope,
      });
    }

    case "space_events":
      // The page, not the bare array: it carries the event-GC truncation annotation
      // (logBeginsAfter/sweptBefore) and nextAfter, which the model needs to page honestly.
      return pretty(await client.getEventsPage(a.after ? String(a.after) : "0", num(a, "limit") ?? 50));

    case "space_watch": {
      // BOUNDED, because MCP is request/response: a tool call has to return. So this is "wait up
      // to N seconds", never a subscription, and a timeout is an ordinary outcome the model is
      // told about rather than an error it has to interpret.
      //
      // TWO QUESTIONS, and answering the second with the first is what broke a mailbox. The
      // default RECONCILES FIRST, so work already sitting there comes back immediately: right for
      // "is there anything for me?", and right for a CLAIMABLE kind, where taking the record is
      // what removes it from the next answer. On a fact kind nothing consumes anything, so the
      // read returns the same record for ever: an agent asked to watch for new messages was handed
      // a two-minute-old broadcast, twice, and narrowing the pattern did not help because the
      // problem was not the pattern. `newOnly` is the second question, and it needs a BASELINE
      // rather than a filter, because "new" is relative to when the call started.
      //
      // POLLED, not a stream, and deliberately: `sdk/ts/await.ts` states the reason (a watch per
      // outstanding call is a stream per call), and one adapter may have several waits open.
      const seconds = Math.min(Math.max(num(a, "timeoutSeconds") ?? 30, 1), 120);
      const pattern = pat(a);
      const newOnly = a.newOnly === true;
      // The baseline is a RECORD, not an id: ULIDs carry the WRITING PROCESS's clock, so comparing
      // ids across two agents can order a second of writes backwards. `newer` compares `created_at`
      // (the database clock) and falls back to the id only as a tie-break.
      const baseline = newOnly ? await client.readNewest(pattern) : undefined;
      const deadline = Date.now() + seconds * 1000;
      let firstRead = true;
      for (;;) {
        // NEWEST-first when watching for something new; `readOne` otherwise, which is the
        // reconcile-first read and returns whatever matches.
        const rec = newOnly ? await client.readNewest(pattern) : await client.readOne(pattern);
        if (rec && (!newOnly || !baseline || newer(baseline, rec))) {
          const claimable = await isClaimable(client, kinds, rec.kind);
          return pretty({
            found: true,
            // Whether it was ALREADY there or arrived while waiting. A caller treating a watch as a
            // mailbox cannot tell those apart from the record alone, and the difference is the
            // whole question it asked.
            existing: firstRead && !newOnly,
            record: rec,
            note: claimable
              ? "NOT claimed. Another agent can still take this. Call space_take with the same " +
                "pattern to claim it, which is what stops two agents doing the same work."
              : `'${rec.kind}' is not claimable, so there is nothing to take: it is a fact, and ` +
                "every agent granted it sees the same one. Pass newOnly:true to wait for the NEXT " +
                "one instead of being handed this one again.",
          });
        }
        firstRead = false;
        if (Date.now() >= deadline) {
          return pretty({
            found: false,
            waitedSeconds: seconds,
            note: newOnly
              ? "nothing NEW matched in time. Records matching this pattern may already exist; " +
                "this was waiting for one written after the call started."
              : "nothing matched in time. This is not an error: no agent has written one yet. " +
                "Wait again, widen the match, or do something else.",
          });
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    case "space_put_artifact": {
      // TEXT is the primary input, because text is what a model can produce. `base64` exists for
      // the binary a tool might hand it, and one of the two is required: an artifact with no bytes
      // is a record, and `space_put` already writes those.
      const text = typeof a.text === "string" ? a.text : undefined;
      const b64 = typeof a.base64 === "string" ? a.base64 : undefined;
      // A PATH is the third input and the one anything binary actually needs. `base64` is a dead
      // end past a few KB: an 85 KB image is 113 KB of base64, which is a context window spent to
      // move bytes the model never reads, and an agent that judged it too big went looking for the
      // credential to curl the upload endpoint instead. That is the same failure `link: true`
      // fixed on the READ side, arriving from the other direction.
      //
      // Reading a path the model names grants nothing in a harness that already gives it a
      // filesystem, which is every harness this serves; in one that does not, it would be the
      // escalation to weigh before enabling. The bytes go straight to the space and never enter a
      // tool result.
      const path = typeof a.path === "string" ? a.path : undefined;
      // AN UPLOAD LINK is the third answer and the one that assumes nothing. `path` reads a file
      // this process can see, which is true for a stdio harness on one machine and false for a
      // remote agent, a browser, or a container; `base64` is a dead end past a few KB (an 85 KB
      // image is 113 KB of context spent to move bytes the model never reads). `link: true` mints
      // a single-use upload capability and hands back a URL to PUT to, exactly mirroring what
      // `space_get_artifact {link: true}` does on the way in. Everything but the bytes is fixed
      // when the link is minted, so the holder cannot change the team label, the parents or the
      // author.
      if (a.link === true) {
        const meta: Record<string, string | number | boolean | null> = {};
        for (const [k, v] of Object.entries((a.meta ?? {}) as Record<string, unknown>)) {
          if (v !== null && typeof v === "object") throw new Error(`meta.${k} must be a scalar`);
          meta[k] = v as string | number | boolean | null;
        }
        const cap = await scope.fill(ARTIFACT, (extra) =>
          client.uploadCapability({
            ...(typeof a.mediaType === "string" ? { mediaType: a.mediaType } : {}),
            ...(typeof a.filename === "string" ? { filename: a.filename } : {}),
            meta: { ...extra, ...meta },
            ...(Array.isArray(a.parentIds) ? { parentIds: a.parentIds.map(String) } : {}),
          }));
        return pretty({
          ...cap,
          note: "PUT the bytes to that url with no header and no credential: the link IS the " +
            "authorization, for one upload of one artifact, and it is consumed on use. Everything " +
            "except the bytes was decided when it was minted. Bytes never entered this context.",
        });
      }
      const given = [text, b64, path].filter((v) => v !== undefined).length;
      if (given === 0) throw new Error("space_put_artifact needs `link`, `path`, `text` or `base64`");
      if (given > 1) throw new Error("pass exactly one of `path`, `text` or `base64`");
      let bytes: Uint8Array;
      if (path !== undefined) {
        const read = await readBinaryFile(path);
        if (!read) throw new Error(`cannot read '${path}': no such file, or it is not readable by this process`);
        bytes = read;
      } else {
        bytes = text !== undefined ? new TextEncoder().encode(text) : decodeBase64(b64!);
      }
      const meta: Record<string, string | number | boolean | null> = {};
      for (const [k, v] of Object.entries((a.meta ?? {}) as Record<string, unknown>)) {
        // Scalars only: `meta` travels in a HEADER, so an object here would be silently dropped or
        // break the request. Refused by name rather than coerced.
        if (v !== null && typeof v === "object") throw new Error(`meta.${k} must be a scalar; it travels in a header`);
        meta[k] = v as string | number | boolean | null;
      }
      // `meta` merges into the artifact's RECORD BODY, which is what a pattern-scoped artifact
      // grant matches, so it needs the same fill as any other write. Without it a scoped member
      // can coordinate but cannot store bytes, which is the half of a compartment that leaks.
      const r = await scope.fill(ARTIFACT, (extra) =>
        client.putArtifact(bytes, {
          mediaType: typeof a.mediaType === "string"
            ? a.mediaType
            : text !== undefined
            ? "text/plain"
            // From the EXTENSION for a path, because a harness picks its reader from the media type
            // and `application/octet-stream` on a JPEG makes the receiving side refuse to inline it.
            : path !== undefined
            ? (mediaTypeForPath(path) ?? "application/octet-stream")
            : "application/octet-stream",
          // The filename defaults to the one on disk: a receiver naming the file it was sent is
          // strictly more use than `undefined`, and the sender rarely thinks to pass it.
          ...(typeof a.filename === "string"
            ? { filename: a.filename }
            : path !== undefined
            ? { filename: path.replace(/\\/g, "/").split("/").pop()! }
            : {}),
          ...(Array.isArray(a.parentIds) ? { parentIds: a.parentIds.map(String) } : {}),
          ...(Object.keys(meta).length + Object.keys(extra).length > 0 ? { meta: { ...extra, ...meta } } : {}),
          ...(typeof a.idempotencyKey === "string" ? { idempotencyKey: a.idempotencyKey } : {}),
        }));
      return pretty({
        ...r,
        note: "Another agent reads this with space_get_artifact, or finds it with space_query on " +
          "kind 'artifact' if you set meta.",
      });
    }

    // ---- workspaces ----------------------------------------------------------
    //
    // OWNER IS THE DURABLE NAME, never the run: a tree outlives the session that wrote it, and an
    // owner nothing can resolve tomorrow is the identity failure this surface already fixed once
    // for `note.to` (agent_docs/research-agent-sessions.md).
    case "space_save_workspace": {
      const files = obj(a, "files") as Record<string, string>;
      for (const [path, text] of Object.entries(files)) {
        if (typeof text !== "string") throw new Error(`files['${path}'] must be a string`);
      }
      const which = await whichCompartment(scope, a);
      // NESTED FILLS, because a tree write touches TWO kinds: every file lands as an `artifact` and
      // the manifest as a `workspace`. On a compartmented space the artifact puts are refused first
      // and the manifest second, each needing the label its own grants are scoped to, so learning
      // one is not enough. Same learn-from-a-refusal rule as `space_put`: nothing is stamped on a
      // write that would have succeeded, since pre-stamping narrows a record written under an
      // UNSCOPED grant (agent_docs/architecture-teams.md).
      const r = await scope.fill("artifact", (art) =>
        scope.fill("workspace", async (ws) => {
          const at = { ...ws, ...(which ?? {}) };
          // READ THE PREDECESSOR INSIDE THE FILL, so a scope learned from a refusal bounds it on
          // the retry. Read outside, the first save in a process looks the name up across every
          // compartment the caller can reach and supersedes whichever head is newest.
          const head = await headOf(client, str(a, "name"), at);
          return await writeWorkspace(client, {
            name: str(a, "name"),
            owner: await ownerName(client),
            files,
            ...(typeof a.entrypoint === "string" ? { entrypoint: a.entrypoint } : {}),
            // The predecessor, so a re-save is a SUCCESSOR rather than a second head. Without it
            // every save of an existing name forks the tree, and a fork is what this surface then
            // has to report to a model that did nothing wrong.
            ...head,
            ...(Object.keys(at).length ? { scope: at } : {}),
            meta: { ...art, ...at },
          });
        }));
      return pretty({
        workspace: str(a, "name"),
        id: r.id,
        treeDigest: r.treeDigest,
        entrypoint: r.entrypoint,
        files: r.files.map((f) => f.path),
        unchanged: r.deduped,
        forked: r.forked,
      });
    }

    case "space_edit_workspace": {
      const which = await whichCompartment(scope, a);
      const r = await scope.fill("artifact", (art) =>
        scope.fill("workspace", (ws) => {
          const at = { ...ws, ...(which ?? {}) };
          return editWorkspace(client, {
            name: str(a, "name"),
            edits: (a.edits ?? []) as Parameters<typeof editWorkspace>[1]["edits"],
            ...(a.add ? { add: a.add as Record<string, string> } : {}),
            ...(Array.isArray(a.remove) ? { remove: a.remove as string[] } : {}),
            ...(typeof a.entrypoint === "string" ? { entrypoint: a.entrypoint } : {}),
            ...(Object.keys(at).length ? { scope: at } : {}),
            meta: { ...art, ...at },
          });
        }));
      return pretty({
        workspace: str(a, "name"),
        id: r.id,
        treeDigest: r.treeDigest,
        changed: r.changed,
        added: r.added,
        removed: r.removed,
        forked: r.forked,
        preview: r.preview,
      });
    }

    case "space_read_workspace": {
      const m = await readWorkspace(client, str(a, "name"), undefined, await whichCompartment(scope, a));
      if (!m) return `no workspace named '${str(a, "name")}' (or no grant to read it)`;
      const path = typeof a.path === "string" ? a.path : undefined;
      if (!path) {
        return pretty({
          workspace: m.name,
          id: m.id,
          owner: m.owner,
          treeDigest: m.treeDigest,
          entrypoint: m.entrypoint,
          files: m.files.map((f) => ({ path: f.path, digest: f.digest })),
        });
      }
      const file = m.files.find((f) => f.path === path);
      // NAMES THE PATHS IT HAS. A model that guessed a path once will guess again unless the
      // refusal carries the answer.
      if (!file) return `'${path}' is not in this workspace. It holds: ${m.files.map((f) => f.path).join(", ")}`;
      const bytes = await client.getArtifact(file.artifactId);
      return new TextDecoder().decode(bytes);
    }

    case "space_list_workspaces": {
      // Grouped by NAME, so a caller that can read two compartments would report their same-named
      // trees as one workspace with two heads.
      const which = await whichCompartment(scope, a);
      const r = await summarizeWorkspaces(client, which ? { scope: which } : {});
      // `complete` travels, for the same reason every other list here carries `more`: a partial
      // listing presented as a population is the most repeated bug in this codebase.
      return answer("workspaces", r.workspaces, { more: !r.complete, limit: r.workspaces.length });
    }

    case "space_artifact_meta": {
      const m = await client.artifactMeta(recordId(a));
      return m ? pretty(m) : "no artifact with that record id (or no grant to read it)";
    }

    case "space_get_artifact": {
      const id = recordId(a);
      const m = await client.artifactMeta(id);
      if (!m) return "no artifact with that record id (or no grant to read it)";
      // A CAPABILITY URL is the answer for anything that cannot be inlined, and it exists because
      // the refusals below used to be a DEAD END. They told a model to "use a client that can
      // download it" while the model WAS the client, so an agent handed a 101 KB image did the
      // only thing left: it read the definition token out of its harness's config file and started
      // running curl. Refusing without leaving a supported path does not protect the boundary, it
      // routes around it.
      //
      // A URL rather than a local file, and the difference is not convenience. Writing bytes to
      // disk assumes the thing that will read them shares a filesystem with this process, which is
      // true for a stdio harness on a laptop and false for anything else; it also turns a pure
      // client into an arbitrary-file writer. The capability is the runtime's OWN primitive for
      // this exact problem (a browser cannot put an Authorization header on an `<img src>`), it
      // names ONE artifact, it expires, and unlike a credential it is safe to put in a context
      // window: whoever reads it can fetch that artifact and nothing else, for a few minutes.
      if (a.link === true) {
        const cap = await client.artifactCapability(id);
        // ABSOLUTE ALREADY when the space runs a separate artifact ORIGIN, which it does by
        // default: capability URLs are served from a second port precisely so generated content
        // cannot reach the console's origin. Prefixing unconditionally produced
        // `http://space:7881http://space:7882/...`, so the base is added only for a space that
        // handed back a relative path.
        const url = /^https?:\/\//.test(cap.url) ? cap.url : `${base}${cap.url}`;
        return pretty({
          ...m,
          url,
          expiresAt: cap.expiresAt,
          note: "a download URL for THIS artifact only, expiring at the time above. It carries its " +
            "own authorization, so fetch it with no header and do not treat it as a credential: it " +
            "opens one artifact and nothing else. Bytes never entered this context.",
        });
      }
      // REFUSED, never truncated. A truncated file presented as the file is the bounded-read bug
      // wearing a filesystem, and a model cannot tell the difference from inside a tool result.
      if (m.size > MAX_ARTIFACT_READ) {
        return pretty({
          ...m,
          read: false,
          note: `${m.size} bytes is past the ${MAX_ARTIFACT_READ}-byte limit for a tool result. ` +
            "Not truncated: part of a file read as the whole one is worse than not reading it. " +
            "Call again with link:true for a short-lived download URL for this one artifact.",
        });
      }
      // BINARY IS NOT INLINED. base64 in a context window is tokens a model cannot act on, and
      // saying so with the size is more useful than spending the window proving it.
      if (!isTextMedia(m.mediaType)) {
        return pretty({
          ...m,
          read: false,
          note: "binary content is not inlined: a model cannot act on base64 in its context. " +
            "Call again with link:true for a short-lived download URL for this one artifact.",
        });
      }
      const bytes = await client.getArtifact(id);
      return pretty({ ...m, read: true, text: new TextDecoder().decode(bytes) });
    }

    case "space_take": {
      const leaseSeconds = num(a, "leaseSeconds") ?? 60;
      const claimed = await client.take({ pattern: pat(a) }, {
        leaseSeconds,
        allowTaint: a.requireUntainted === true ? [] : (Array.isArray(a.allowTaint) ? a.allowTaint.map(String) : undefined),
      });
      if (!claimed) return "nothing available for that pattern";
      // The model gets a handle; the fenced lease never leaves this process.
      const claimId = `claim-${claimed.record.id}-${claimed.lease.epoch}`;
      // The heartbeat's VERDICT matters, not just that it ran: renewing a lease somebody else now
      // holds, forever, is how a model kept working on a record that had been taken back from it.
      // A transient error is still ignored (the lease has until its expiry); the two authoritative
      // outcomes stop the timer and mark the claim.
      const timer = setInterval(async () => {
        const c = claims.get(claimId);
        if (!c) return;
        try {
          const res = await client.renew(claimed.lease, { leaseSeconds });
          if (res.status === "lease_lost") lose(claims, claimId, "lease_lost");
        } catch (e) {
          if (e instanceof RadiaClientError && (e.status === 401 || e.status === 403)) {
            lose(claims, claimId, "credential");
          }
        }
      }, Math.max(1000, (leaseSeconds / 3) * 1000));
      claims.set(claimId, { lease: claimed.lease, record: claimed.record, timer });
      return pretty({
        claimId,
        record: claimed.record,
        note: "Lease held and renewed for you. Settle with space_ack (done), space_nack (retry) " +
          "or space_release (give it back). If the space takes the record back while you work " +
          "(reclaimed or reassigned), settling says so rather than pretending it landed.",
      });
    }

    case "space_ack": {
      const c = await takeClaim(claims, a, client);
      const kind = a.resultKind ? String(a.resultKind) : undefined;
      // The RESULT body is a write like any other and needs the same fill: acking a scoped task
      // with an unlabelled note is refused, and that refusal would land after the work was done.
      // Per-attempt idempotency key: a retried ack after a dropped response is not double work.
      const r = kind
        ? await scope.fill(kind, (extra) =>
          client.ack(c.lease, { kind, body: { ...extra, ...(a.resultBody ?? {}) as Record<string, unknown> } }, `ack:${c.record.id}:${c.lease.epoch}`))
        : await client.ack(c.lease, undefined, `ack:${c.record.id}:${c.lease.epoch}`);
      return pretty(r);
    }

    case "space_nack": {
      const c = await takeClaim(claims, a, client);
      const backoff = num(a, "backoffSeconds");
      return pretty(await client.nack(c.lease, backoff !== undefined ? { backoffSeconds: backoff } : {}));
    }

    case "space_release": {
      const c = await takeClaim(claims, a, client);
      return pretty(await client.release(c.lease));
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/** Stop renewing a claim we no longer hold, and remember why so the settle can explain it. */
function lose(claims: Map<string, Claim>, claimId: string, reason: "lease_lost" | "credential"): void {
  const c = claims.get(claimId);
  if (!c) return;
  clearInterval(c.timer);
  c.lost = reason;
  log(
    `radia mcp: claim ${claimId} lost (${reason}); the work may already be running elsewhere`,
  );
}

/** Resolve a claimId to its lease and stop its heartbeat. Settling ends the claim either way. */
/**
 * Recover a claim THIS PROCESS never made, from the space.
 *
 * MCP 2026-07-28 is stateless and says so about us directly: "an open connection, such as a STDIO
 * process, is not a conversation or session", and a server "SHOULD NOT require that a client reuse
 * the same connection or process to perform related operations". A claimId that only the process
 * which minted it can settle breaks that, and it broke in practice first: a settle against a
 * restarted adapter answered "this adapter never held it" while the lease was alive and the work
 * was done.
 *
 * Nothing has to be stored to fix it. The claimId embeds the record id, and a `Lease` is exactly
 * what the envelope already carries, so the lease is REDERIVED rather than remembered.
 *
 * THE RUN MUST MATCH, and that is not a formality: a settle is owner-bound (`warnOwnerMismatch`
 * answers `lease_lost` to anyone else), so a restarted adapter can only settle if it came back as
 * the SAME run. That is what `--session` does, which makes the flag load-bearing for conformance
 * and not only for attribution. Without it the refusal says so instead of blaming the caller.
 */
async function recoverClaim(client: RadiaClient, claimId: string): Promise<Claim | undefined> {
  const m = /^claim-([0-9A-Za-z]+)-(\d+)$/.exec(claimId);
  if (!m) return undefined;
  const [, recordId, epoch] = m;
  const env = await client.getEnvelope(recordId).catch(() => null);
  if (!env || env.state !== "leased" || !env.leaseId || env.leaseEpoch === undefined) return undefined;
  // Only OUR run's lease. `health().principal` is the run this process resolved to.
  const me = await client.health().then((h) => h.principal).catch(() => "");
  if (!me || env.leaseOwner !== me) return undefined;
  if (String(env.leaseEpoch) !== epoch) return undefined; // a later claim of the same record
  const record = await client.getRecord(recordId).catch(() => null);
  if (!record) return undefined;
  return {
    lease: {
      recordId,
      leaseId: env.leaseId,
      epoch: env.leaseEpoch,
      ownerRun: env.leaseOwner,
      expiresAt: env.leasedUntil ?? "",
    },
    record,
    // No heartbeat: this process did not start one and is about to settle. Renewing a lease it
    // just adopted would keep alive something the next line ends.
    timer: setInterval(() => {}, 1 << 30),
  };
}

async function takeClaim(claims: Map<string, Claim>, a: Record<string, unknown>, client: RadiaClient): Promise<Claim> {
  const id = str(a, "claimId");
  const c = claims.get(id) ?? await recoverClaim(client, id);
  if (!c) {
    throw new Error(
      `unknown claimId '${id}': it was already settled, or the lease is not held by this session's ` +
        `run. A claim can be settled by a later adapter process only when the run is the same, ` +
        `which is what \`radia mcp --session <name>\` keeps across restarts.`,
    );
  }
  clearInterval(c.timer);
  claims.delete(id);
  if (c.lost) {
    // Told here rather than at the server, which would answer `lease_lost` to the same effect one
    // round trip later. The distinction the model needs is that this is not its error: the record
    // went back to the space and somebody else may hold it now.
    throw new Error(
      c.lost === "credential"
        ? `claim '${id}' was lost: this adapter's credential stopped working (the run was stopped or expired), so nothing it holds can be settled. Nothing was written.`
        : `claim '${id}' was FENCED: the lease was reclaimed or reassigned while you worked on it, so another worker may hold this record now. Nothing was written; take the work again if you still want it.`,
    );
  }
  return c;
}

/** The caller's DURABLE name, which is what a tree is owned by. Memoized per process: it costs an
 *  exchange plus a health call, and it cannot change within a session. */
let ownerMemo: string | undefined;
async function ownerName(client: RadiaClient): Promise<string> {
  if (ownerMemo) return ownerMemo;
  await client.ensureCredential();
  const h = await client.health();
  return ownerMemo = h.agent ?? h.principal;
}

/**
 * WHICH compartment a workspace call means, when the caller can reach more than one.
 *
 * A workspace is looked up by NAME and bounded by the caller's grant, which is exactly right for a
 * member of one team and wrong for a member of several: their lookup spans both, so a save
 * supersedes the other team's tree, an identical one dedups into it and writes NOTHING, and two
 * teams' same-named trees read as one FORKED workspace (agent_docs/architecture-teams.md).
 *
 * ASKED, never inferred, which is `ScopeFiller.choose`: the label cannot be learned from a refusal
 * here, because the read happens before any write.
 *
 * TWO CALLERS IT CANNOT SEE, both from `EffectivePermissions.patterns` rather than from here. An
 * unscoped grant contributes no entry at all, so one sitting beside a scoped grant reads as a
 * single scope (`definitionState.unscoped` in `extensions/ts/team.ts` shouts about that state for
 * the same reason). And a pattern carrying an operator (`{team: {$in: […]}}`) states a set rather
 * than a value, so `flat` drops it. Both go on reading across compartments by name.
 */
function whichCompartment(
  scope: ScopeFiller,
  a: Record<string, unknown>,
): Promise<Record<string, string | number | boolean> | undefined> {
  return scope.choose("workspace", a.scope === undefined ? undefined : flatScope(a.scope));
}

/** A `scope` argument: flat scalars only, because it becomes a match on indexed paths. An empty
 *  object narrows nothing, so it is the same as naming none and is answered the same way. */
function flatScope(v: unknown): Record<string, string | number | boolean> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("'scope' must be an object, e.g. {\"team\": \"alpha\"}");
  const out: Record<string, string | number | boolean> = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === null || typeof val === "object") throw new Error(`scope['${k}'] must be a string, number or boolean`);
    out[k] = val as string | number | boolean;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The manifest a re-save supersedes, or nothing for a first write.
 *
 *  Read here rather than left to the caller: a model asked to "save this workspace again" has no
 *  way to know the id it must name, and omitting it makes every second save a FORK. */
async function headOf(
  client: RadiaClient,
  name: string,
  scope?: Record<string, string | number | boolean>,
): Promise<{ basedOn?: string }> {
  // NOT caught. `readWorkspace` answers null for "no such workspace" and THROWS for a refusal, and
  // swallowing the second turns a caller with `put` but no `query` into one that silently forks the
  // tree on every save: it cannot read the head, so it never names a predecessor. A refusal is the
  // caller's to see.
  const head = await readWorkspace(client, name, undefined, scope && Object.keys(scope).length ? scope : undefined);
  return head ? { basedOn: head.id } : {};
}

// ---- argument coercion ----

/**
 * The record id, under either name a model reaches for.
 *
 * The tools declare `recordId`; every record a model has just read carries its id as `id`, and one
 * did exactly that (`space_get {"id": "01ZZ…"}`, refused). Same rule as `order_by` beside `orderBy`
 * below: the key is the MODEL's, the wire never sees it, and a near-miss the adapter can resolve is
 * not worth a refusal. The declared spelling still wins, so a caller passing both gets what it
 * asked for.
 */
function recordId(a: Record<string, unknown>): string {
  const v = a.recordId ?? a.id ?? a.record_id;
  if (typeof v !== "string" || !v) throw new Error("'recordId' is required and must be a string");
  return v;
}


function str(a: Record<string, unknown>, k: string): string {
  const v = a[k];
  if (typeof v !== "string" || !v) throw new Error(`'${k}' is required and must be a string`);
  return v;
}

function obj(a: Record<string, unknown>, k: string): Record<string, unknown> {
  const v = a[k];
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`'${k}' is required and must be a JSON object`);
  return v as Record<string, unknown>;
}

function num(a: Record<string, unknown>, k: string): number | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`'${k}' must be a number`);
  return n;
}

/**
 * A nested argument a model sent as a JSON STRING, parsed back into the object it means.
 *
 * Observed once in nineteen calls: `match: "{\"to\": {\"$in\": […]}}"`, refused as
 * `invalid_predicate`, and the same agent sent the object correctly on its next call. Same rule as
 * the `recordId` aliases: the key and its encoding are the MODEL's, the wire never sees this form,
 * and a near-miss the adapter can resolve is not worth a wasted call. NARROW deliberately: only a
 * string that parses to a plain object is accepted, so a genuine type error still fails.
 */
function unstring(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : v;
  } catch {
    return v;
  }
}

function pat(a: Record<string, unknown>): Pattern {
  return {
    kind: str(a, "kind"),
    match: (unstring(a.match) ?? undefined) as Record<string, unknown> | undefined,
    // Both spellings: the key is the MODEL's, the wire reads only `orderBy`, and a dropped sort
    // key is a wrong answer rather than an error. The wire's own near-miss refusal cannot help
    // here, because this rebuilds the pattern and the model's key never crosses the socket.
    orderBy: (a.orderBy ?? a.order_by ?? undefined) as Pattern["orderBy"],
  };
}

/**
 * Is this kind claimed as WORK, or is it a fact?
 *
 * Only ever used to choose what a result SAYS. Telling a model to `space_take` a record of a
 * `claimable: false` kind sends it after an operation the space will never satisfy, and the advice
 * reads as authoritative because it comes from the tool rather than the prompt.
 *
 * Fails OPEN to "claimable", the pre-existing wording: a member that cannot read `kind_def` should
 * lose a sentence, not a tool call.
 */
async function isClaimable(client: RadiaClient, cache: Map<string, boolean>, kind: string): Promise<boolean> {
  const held = cache.get(kind);
  if (held !== undefined) return held;
  try {
    for (const def of await client.listKinds()) cache.set(def.kind, def.claimable !== false);
  } catch { /* no kind_def grant: say what the old wording said */ }
  return cache.get(kind) ?? true;
}

/** Same cap the chat's file reads use, and for the same reason: a tool result goes into a context
 *  window. Past it the read is REFUSED with the size, never truncated. */
const MAX_ARTIFACT_READ = 64 * 1024;

/** Can this media type go into a model's context as text? Deliberately a small allowlist: an
 *  unknown type is treated as binary, so the failure is "you were told the size" rather than a
 *  window full of mojibake. */
function isTextMedia(mediaType: string): boolean {
  const t = mediaType.split(";")[0].trim().toLowerCase();
  return t.startsWith("text/") ||
    t === "application/json" || t === "application/xml" || t === "application/yaml" ||
    t.endsWith("+json") || t.endsWith("+xml") || t.endsWith("+yaml");
}

function decodeBase64(b64: string): Uint8Array {
  try {
    const bin = atob(b64.trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    throw new Error("`base64` is not valid base64");
  }
}

function pretty(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

// ---- stdio transport ----

/** Newline-delimited JSON frames from stdin. Malformed lines are reported and skipped rather
 *  than killing the session. A harness that sends one bad frame should not lose the space. */
async function* frames(stream: ReadableStream<Uint8Array>): AsyncGenerator<Req> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line) as Req;
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }
    }
  }
}

function write(msg: unknown): void {
  // Synchronous so frames can never interleave. stdout is protocol-only.
  writeStdout(JSON.stringify(msg) + "\n");
}

/**
 * Diagnostics for this adapter, and the one place in the codebase where the destination is not a
 * preference: stdout carries JSON-RPC frames, so a line printed there corrupts the stream and the
 * harness sees a dead server. The logger writes to stderr by default, which is the same rule
 * expressed once instead of remembered here.
 *
 * The `radia mcp:` prefix is dropped: `source` carries it now, and a harness showing stderr shows
 * the level beside it.
 */
const mcpLog = getLogger("mcp");
function log(msg: string): void {
  mcpLog.info(msg.replace(/^radia mcp: /, ""));
}
