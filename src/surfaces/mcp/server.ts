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

import { RadiaClient, RadiaClientError } from "../../../sdk/ts/client.ts";
import { defaultBase, resolveToken, storedObserver } from "../../credentials.ts";
import { env } from "../../platform.ts";
import type { Lease, RadiaRecord } from "../../storage/adapter.ts";
import type { Pattern } from "../../core/matching.ts";
import { TOOLS } from "./tools.ts";
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
  const explicit = env("RADIA_TOKEN");
  const observer = explicit ? undefined : storedObserver(base)?.definitionToken;
  const token = observer ? undefined : resolveToken(base);
  const client = new RadiaClient(base, observer ? { definitionToken: observer } : token ? { token } : {});
  const claims = new Map<string, Claim>();

  log(`radia mcp: space=${base} auth=${
    observer
      ? "observer (ops reads; coordination needs grants — see radia permissions agent:local-observer)"
      : token
      ? "bearer token"
      : "none (open local space)"
  }`);
  if (!observer && !token) {
    log("radia mcp: no credential found. Start `radia dev` (auto-provisions one) or set RADIA_TOKEN.");
  }

  for await (const msg of frames(stdin())) {
    const res = await handle(msg, client, claims, base);
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
        const text = await call(name, args, client, claims);
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
      const r = await client.put({
        kind: str(a, "kind"),
        body: obj(a, "body"),
        parentIds: Array.isArray(a.parentIds) ? a.parentIds as string[] : undefined,
      }, a.idempotencyKey ? String(a.idempotencyKey) : undefined);
      return pretty(r);
    }

    case "space_query":
      return pretty(await client.query(pat(a), num(a, "limit") ?? 50));

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
      const result = kind ? { kind, body: (a.resultBody ?? {}) as Record<string, unknown> } : undefined;
      // Per-attempt idempotency key: a retried ack after a dropped response is not double work.
      const r = await client.ack(c.lease, result, `ack:${c.record.id}:${c.lease.epoch}`);
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

/** Resolve a claimId to its lease and stop its heartbeat. Settling ends the claim either way. */
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
    orderBy: (a.orderBy ?? undefined) as Pattern["orderBy"],
  };
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
