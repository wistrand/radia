// Bundled MCP adapter (Phase 7). `radia mcp` serves the space to an MCP-capable harness over
// stdio, so a model participates in coordination with one line of harness config and no SDK.
//
// Two properties the plan calls for, and why they matter:
//
// 1. **Credentials stay outside the model context.** The adapter resolves a credential itself
//    (src/credentials.ts) and attaches it to every request: the OBSERVER by default (ops reads
//    only, architecture-ops-tiers.md), `RADIA_TOKEN` as the explicit override, the operator token only
//    as a legacy fallback. No token appears in a tool schema, a tool result, or an error, so a
//    model driving this cannot read, log, or leak the credential it is acting under.
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
import { newer } from "../../../sdk/ts/registry.ts";
import { ARTIFACT } from "../../../sdk/ts/wire.ts";
import { flag } from "../../flags.ts";
import { stdin, writeStderr, writeStdout } from "../../platform.ts";
import { VERSION } from "../../version.ts";

// The third place this string used to be written by hand. An MCP client shows it in its own
// server list, so a stale literal here misreports the build to a person reading someone else's UI.
const SERVER_INFO = { name: "radia", version: VERSION };
/** Echoed back to the client when it asks for a version we know; otherwise we answer with this. */
const DEFAULT_PROTOCOL = "2025-06-18";
const KNOWN_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", DEFAULT_PROTOCOL]);

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
  if (!observer && !token) {
    log("radia mcp: no credential found. Start `radia dev` (auto-provisions one) or set RADIA_TOKEN.");
  }

  for await (const msg of frames(stdin())) {
    const res = await handle(msg, client, claims, base, scope, kinds);
    if (res) write(res);
  }
  // Stdin closed: the harness is gone. Release anything still held rather than making the space
  // wait out every lease.
  for (const [, c] of claims) {
    clearInterval(c.timer);
    await client.release(c.lease).catch(() => {});
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
): Promise<unknown | null> {
  const { id, method } = req;
  // A notification (no id) never gets a reply, per JSON-RPC.
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const want = String((req.params?.protocolVersion as string) ?? "");
      return reply(id, {
        protocolVersion: KNOWN_PROTOCOLS.has(want) ? want : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          `A Radia coordination space at ${base}. Agents exchange immutable JSON records and claim ` +
          `work by pattern matching, not by addressing. Start with space_kinds to discover what ` +
          `record kinds exist and how each is indexed. Nothing about this space is implied by the ` +
          `tool list. Claim work with space_take and settle it with space_ack; the lease is held ` +
          `and renewed for you.`,
      });
    }

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
      try {
        const text = await call(name, args, client, claims, scope, kinds);
        return reply(id, { content: [{ type: "text", text }] });
      } catch (e) {
        // Tool-level failures are results with isError, not JSON-RPC errors, so the model should
        // see them and adapt (a rejected pattern says why), not have the call disappear.
        return reply(id, { content: [{ type: "text", text: errorText(e) }], isError: true });
      }
    }

    default:
      if (isNotification) return null;
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } };
  }
}

function reply(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
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
): Promise<string> {
  switch (name) {
    case "space_health":
      return pretty(await client.health());

    case "space_kinds":
      return pretty(await client.listKinds());

    case "space_stats":
      return pretty(await client.getStats());

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
      const p = pat(a);
      const n = num(a, "limit") ?? 50;
      return pretty(p.orderBy?.length ? await client.queryOrdered(p, n) : await client.queryOldest(p, n));
    }

    case "space_read_one":
      return pretty(await client.readOne(pat(a)));

    case "space_get":
      return pretty(await client.getRecord(str(a, "recordId")));

    case "space_lineage":
      return pretty(await client.getLineage(str(a, "recordId")));

    case "space_children":
      return pretty(await client.getChildren(str(a, "recordId")));

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
      if (text === undefined && b64 === undefined) throw new Error("space_put_artifact needs `text` or `base64`");
      if (text !== undefined && b64 !== undefined) throw new Error("pass `text` or `base64`, not both");
      const bytes = text !== undefined ? new TextEncoder().encode(text) : decodeBase64(b64!);
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
          mediaType: typeof a.mediaType === "string" ? a.mediaType : (text !== undefined ? "text/plain" : "application/octet-stream"),
          ...(typeof a.filename === "string" ? { filename: a.filename } : {}),
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

    case "space_artifact_meta": {
      const m = await client.artifactMeta(str(a, "recordId"));
      return m ? pretty(m) : "no artifact with that record id (or no grant to read it)";
    }

    case "space_get_artifact": {
      const id = str(a, "recordId");
      const m = await client.artifactMeta(id);
      if (!m) return "no artifact with that record id (or no grant to read it)";
      // REFUSED, never truncated. A truncated file presented as the file is the bounded-read bug
      // wearing a filesystem, and a model cannot tell the difference from inside a tool result.
      if (m.size > MAX_ARTIFACT_READ) {
        return pretty({
          ...m,
          read: false,
          note: `${m.size} bytes is past the ${MAX_ARTIFACT_READ}-byte limit for a tool result. ` +
            "Not truncated: part of a file read as the whole one is worse than not reading it.",
        });
      }
      // BINARY IS NOT INLINED. base64 in a context window is tokens a model cannot act on, and
      // saying so with the size is more useful than spending the window proving it.
      if (!isTextMedia(m.mediaType)) {
        return pretty({
          ...m,
          read: false,
          note: "binary content is not inlined. Use the digest to compare it, or a client that can " +
            "download it; a model cannot act on base64 in its context.",
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
      const c = takeClaim(claims, a);
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
      const c = takeClaim(claims, a);
      const backoff = num(a, "backoffSeconds");
      return pretty(await client.nack(c.lease, backoff !== undefined ? { backoffSeconds: backoff } : {}));
    }

    case "space_release": {
      const c = takeClaim(claims, a);
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
function takeClaim(claims: Map<string, Claim>, a: Record<string, unknown>): Claim {
  const id = str(a, "claimId");
  const c = claims.get(id);
  if (!c) throw new Error(`unknown claimId '${id}': it was already settled, or this adapter never held it`);
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

// ---- argument coercion ----

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

function pat(a: Record<string, unknown>): Pattern {
  return {
    kind: str(a, "kind"),
    match: (a.match ?? undefined) as Record<string, unknown> | undefined,
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

function log(msg: string): void {
  writeStderr(msg + "\n");
}
