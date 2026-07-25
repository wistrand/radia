// The `radia` CLI (Phase 7). Every command goes through the public `/v0` surface via the TS
// SDK — no privileged backdoor, no direct storage access. If the CLI can do it, so can any
// client. Credentials come from `src/credentials.ts` (RADIA_TOKEN, else the token `radia dev`
// provisioned), so local invocations authenticate exactly like a deployed client would.
//
// Kinds, records, and relationships are DISCOVERED, never hardcoded: `kinds` is a query for
// `kind_def` records, `children`/`lineage` follow the graph, and no verb carries a table of
// known kinds.

import { RadiaClient, RadiaClientError } from "../sdk/ts/client.ts";
import { defaultBase, resolveToken } from "./credentials.ts";
import type { Lease } from "./storage/adapter.ts";

const HELP = `radia <command> [options]

Options common to every command:
  --url <base>       space base URL (default: $RADIA_URL, else http://127.0.0.1:7788)
  --json             raw JSON output (default: a compact human table)

Inspect
  health                              backend, DB clock, resolved principal
  stats                               record counts by kind and state
  doctor                              diagnostics: dead-letters, stuck leases, stale work
  kinds                               declared kinds (a query for kind_def records)
  get <record-id>                     one record
  lineage <record-id>                 ancestry via parent_ids
  children <record-id>                records descending from it
  events [--after <cursor>] [--limit <n>]
  watch <kind> [--match <json>]       stream wakeups until interrupted

Coordinate
  put <kind> <json-body> [--idempotency-key <k>] [--parent <id>]...
  query <kind> [--match <json>] [--order <json>] [--limit <n>]
  read-one <kind> [--match <json>] [--order <json>]
  take <kind> [--match <json>] [--lease <seconds>] [--untainted]
  ack <lease-json> [--result-kind <k> --result <json>] [--idempotency-key <k>]
  nack <lease-json> [--backoff <seconds>]
  release <lease-json>

\`take\` prints the claimed record together with its lease; pass that lease object straight back
to \`ack\`/\`nack\`/\`release\` (as a JSON string, or - to read it from stdin).`;

interface Ctx {
  client: RadiaClient;
  json: boolean;
  /** Whether a credential was found and presented — used to explain an `anonymous` principal. */
  token: boolean;
}

export async function runCli(cmd: string, argv: string[]): Promise<number> {
  if (cmd === "help") {
    console.log(HELP);
    return 0;
  }
  const base = flag(argv, "--url") ?? defaultBase();
  const token = resolveToken(base);
  const ctx: Ctx = { client: new RadiaClient(base, token ?? {}), json: has(argv, "--json"), token: !!token };
  try {
    return await dispatch(cmd, argv, ctx);
  } catch (e) {
    if (e instanceof RadiaClientError) {
      console.error(`error: ${e.message}`);
      return 1;
    }
    const msg = (e as Error).message ?? String(e);
    if (/error sending request|connection refused|Fetch failed|ConnectionRefused/i.test(msg)) {
      console.error(`error: cannot reach a space at ${base} — is \`radia dev\` running? (override with --url or $RADIA_URL)`);
      return 1;
    }
    console.error(`error: ${msg}`);
    return 1;
  }
}

async function dispatch(cmd: string, argv: string[], ctx: Ctx): Promise<number> {
  const { client } = ctx;
  switch (cmd) {
    case "health": {
      const h = await client.health();
      return out(ctx, h, () => {
        let line = `${h.storage}  principal=${h.principal}  now=${h.now}  v${h.version}`;
        // `GET /v0/health` is public, so a REJECTED token still returns 200 — as `anonymous`.
        // Without this note that reads as "no credential" rather than "bad credential".
        if (ctx.token && h.principal === "anonymous") {
          line += `\nwarning: a credential was presented but the space rejected it (stale or wrong token).`;
        } else if (!ctx.token) {
          line += `\nnote: no credential presented — relying on this space's open-mode operator default.`;
        }
        return line;
      });
    }

    case "stats": {
      const rows = await client.getStats();
      return out(ctx, rows, () =>
        rows.length
          ? table(["KIND", "STATE", "COUNT"], rows.map((r) => [r.kind, r.state, String(r.count)]))
          : "(empty space)"
      );
    }

    case "doctor": {
      const d = await client.diagnostics() as Diagnostics;
      return out(ctx, d, () => {
        const c = d.counts ?? {};
        const lines = [Object.entries(c).map(([k, v]) => `${k}=${v}`).join("  ")];
        if (d.deadLetter?.count) lines.push(`dead-letter: ${d.deadLetter.count}`);
        if (d.stuckLeases?.count) lines.push(`stuck leases: ${d.stuckLeases.count} (expired but still held)`);
        if (d.staleAvailable?.count) lines.push(`stale available: ${d.staleAvailable.count}`);
        if (lines.length === 1) lines.push("no dead-letters, stuck leases, or stale work");
        return lines.join("\n");
      });
    }

    case "kinds": {
      const defs = await client.listKinds();
      return out(ctx, defs, () =>
        defs.length
          ? table(["KIND", "INDEXED", "SORTABLE", "CLAIMABLE"], defs.map((d) => [
            d.kind,
            (d.indexedPaths ?? []).map((p) => p.path).join(",") || "-",
            (d.sortablePaths ?? []).join(",") || "-",
            String(d.claimable ?? true),
          ]))
          : "(no kinds declared)"
      );
    }

    case "put": {
      const [kind, bodyArg] = positional(argv, 2);
      if (!kind || bodyArg === undefined) return usage("put <kind> <json-body>");
      const parents = flags(argv, "--parent");
      const req = { kind, body: json(bodyArg, "body"), ...(parents.length ? { parentIds: parents } : {}) };
      const r = await client.put(req, flag(argv, "--idempotency-key"));
      return out(ctx, r, () => r.id);
    }

    case "query": {
      const [kind] = positional(argv, 1);
      if (!kind) return usage("query <kind> [--match <json>]");
      const recs = await client.query(template(kind, argv), Number(flag(argv, "--limit") ?? "50"));
      return out(ctx, recs, () => recordTable(recs));
    }

    case "read-one": {
      const [kind] = positional(argv, 1);
      if (!kind) return usage("read-one <kind> [--match <json>]");
      const rec = await client.readOne(template(kind, argv));
      return out(ctx, rec, () => (rec ? JSON.stringify(rec.body) : "(no match)"));
    }

    case "get": {
      const [id] = positional(argv, 1);
      if (!id) return usage("get <record-id>");
      const rec = await client.getRecord(id);
      if (!rec) {
        console.error(`error: no record ${id}`);
        return 1;
      }
      return out(ctx, rec, () => JSON.stringify(rec, null, 2));
    }

    case "lineage": {
      const [id] = positional(argv, 1);
      if (!id) return usage("lineage <record-id>");
      const lin = await client.getLineage(id);
      return out(ctx, lin, () => lin.map((n) => `${"  ".repeat(n.depth)}${n.depth ? "└ " : "● "}${n.record.id}  ${n.record.kind}`).join("\n"));
    }

    case "children": {
      const [id] = positional(argv, 1);
      if (!id) return usage("children <record-id>");
      const kids = await client.getChildren(id);
      return out(ctx, kids, () => recordTable(kids));
    }

    case "events": {
      const evs = await client.getEvents(flag(argv, "--after") ?? "0", Number(flag(argv, "--limit") ?? "50"));
      return out(ctx, evs, () =>
        evs.length
          ? table(["SEQ", "OP", "KIND", "RECORD", "STATE"], evs.map((e) => [
            String(e.seq),
            e.operation,
            e.kind ?? "-",
            (e.recordId ?? "-").slice(-8),
            e.state ?? "-",
          ]))
          : "(no events)"
      );
    }

    case "watch": {
      const [kind] = positional(argv, 1);
      if (!kind) return usage("watch <kind> [--match <json>]");
      const ac = new AbortController();
      // Ctrl-C ends the stream cleanly rather than killing mid-frame.
      Deno.addSignalListener("SIGINT", () => ac.abort());
      for await (const w of client.watch(template(kind, argv), ac.signal)) {
        console.log(ctx.json ? JSON.stringify(w) : `${w.seq}  ${w.kind}  ${w.recordId}`);
      }
      return 0;
    }

    case "take": {
      const [kind] = positional(argv, 1);
      if (!kind) return usage("take <kind> [--lease <seconds>]");
      const claimed = await client.take({ template: template(kind, argv) }, {
        leaseSeconds: flag(argv, "--lease") ? Number(flag(argv, "--lease")) : undefined,
        requireUntainted: has(argv, "--untainted") || undefined,
      });
      if (!claimed) {
        // Nothing claimable is a normal outcome, not a failure — exit 0 so scripts can loop.
        if (ctx.json) console.log("null");
        else console.log("(nothing available)");
        return 0;
      }
      return out(ctx, claimed, () =>
        `claimed ${claimed.record.id} (${claimed.record.kind}) until ${claimed.lease.expiresAt}\n` +
        `body:  ${JSON.stringify(claimed.record.body)}\n` +
        `lease: ${JSON.stringify(claimed.lease)}`);
    }

    case "ack": {
      const lease = await leaseArg(argv);
      if (!lease) return usage("ack <lease-json>");
      const kind = flag(argv, "--result-kind");
      const body = flag(argv, "--result");
      const result = kind ? { kind, body: body ? json(body, "result") : {} } : undefined;
      const r = await client.ack(lease, result, flag(argv, "--idempotency-key"));
      return out(ctx, r, () => (r.status === "ok" ? `ok${r.resultId ? ` -> ${r.resultId}` : ""}` : r.status));
    }

    case "nack": {
      const lease = await leaseArg(argv);
      if (!lease) return usage("nack <lease-json>");
      const backoff = flag(argv, "--backoff");
      const r = await client.nack(lease, backoff ? { backoffSeconds: Number(backoff) } : {});
      return out(ctx, r, () => r.status);
    }

    case "release": {
      const lease = await leaseArg(argv);
      if (!lease) return usage("release <lease-json>");
      const r = await client.release(lease);
      return out(ctx, r, () => r.status);
    }

    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

// ---- argument helpers ----

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** All values of a repeatable flag (`--parent a --parent b`). */
function flags(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === name) out.push(argv[i + 1]);
  return out;
}

function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

/** Positional arguments, skipping flags and their values. */
function positional(argv: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length && out.length < n; i++) {
    if (argv[i].startsWith("--")) {
      // Value-less switches take no argument; everything else consumes the next token.
      if (!["--json", "--untainted"].includes(argv[i])) i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

function json(text: string, what: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`--${what} is not valid JSON: ${text}`);
  }
}

function template(kind: string, argv: string[]) {
  const match = flag(argv, "--match");
  const order = flag(argv, "--order");
  return {
    kind,
    match: match ? json(match, "match") : undefined,
    orderBy: order ? JSON.parse(order) : undefined,
  };
}

/** A lease from the first positional argument, or from stdin when it is `-`. */
async function leaseArg(argv: string[]): Promise<Lease | undefined> {
  const [arg] = positional(argv, 1);
  if (!arg) return undefined;
  const text = arg === "-" ? new TextDecoder().decode(await readAll(Deno.stdin.readable)) : arg;
  const parsed = JSON.parse(text);
  // Accept either a bare lease or the whole `take` output, so a pipeline can pass either.
  return (parsed.lease ?? parsed) as Lease;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of stream) chunks.push(c);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }
  return buf;
}

// ---- output ----

function out(ctx: Ctx, data: unknown, human: () => string): number {
  console.log(ctx.json ? JSON.stringify(data, null, 2) : human());
  return 0;
}

function usage(line: string): number {
  console.error(`usage: radia ${line}`);
  return 2;
}

function recordTable(recs: { id: string; kind: string; body: unknown }[]): string {
  if (!recs.length) return "(no records)";
  return table(["ID", "KIND", "BODY"], recs.map((r) => [r.id.slice(-8), r.kind, truncate(JSON.stringify(r.body), 60)]));
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function table(headers: string[], rows: string[][]): string {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(w[i])).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

interface Diagnostics {
  counts?: Record<string, number>;
  deadLetter?: { count: number };
  stuckLeases?: { count: number };
  staleAvailable?: { count: number };
}
