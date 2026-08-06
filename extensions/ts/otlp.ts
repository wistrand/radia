// OTLP export: threads as traces, attempts as spans.
//
// A CLIENT-side convention, like everything in extensions/: it reads records and events through
// the public API and POSTs OTLP/HTTP JSON to a collector (Jaeger v2, Tempo, Alloy, the
// otel-collector all accept it natively). The runtime is untouched — no push machinery, no
// background work, no dependency: the payload is plain JSON to `<collector>/v1/traces`.
//
// THE MAPPING follows agent_docs/design-inspection.md "a record is not a span":
//
//   trace        <- a thread (everything sharing a lineage root)
//   trace_id     <- 16 bytes of sha256(root record id), hex
//   record span  <- the record: creation -> its terminal ack, zero-duration if never worked
//   attempt span <- one lease attempt: the `take` event -> its settle, child of the record span,
//                   service = the CLAIMING agent (run identity), status from the settle verb
//   parent span  <- the FIRST data parent's record span; every other parent is an OTel LINK,
//                   because provenance is a DAG and a trace is a tree
//   attributes   <- record id, kind, created_by, taint LABELS, delegation chain
//
// IDS ARE DETERMINISTIC (content-derived, not minted), so re-exporting the same history produces
// byte-identical span identities and a collector dedupes instead of double-counting: the exporter
// is idempotent the same way content-keyed registry writes are.
//
// HONESTY RULES, same as the console's waterfall: a record span with no terminal settle carries
// `radia.open: true` rather than an invented end, and nothing here declares topology — the trace
// IS the lineage, mined from what happened.

import type { RadiaRecord } from "../../sdk/ts/client.ts";
import type { SpaceEvent } from "../../sdk/ts/wire.ts";

// ---- OTLP JSON shapes (the protobuf-JSON mapping; trace/span ids are HEX by spec) ----

export interface OtlpAttr {
  key: string;
  value: { stringValue?: string; intValue?: string; boolValue?: boolean; arrayValue?: { values: { stringValue: string }[] } };
}
export interface OtlpSpan {
  traceId: string; // 32 hex chars
  spanId: string; // 16 hex chars
  parentSpanId?: string;
  name: string;
  kind: number; // SPAN_KIND_INTERNAL = 1
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttr[];
  status?: { code: number; message?: string }; // 0 unset, 1 ok, 2 error
  links?: { traceId: string; spanId: string }[];
  events?: { timeUnixNano: string; name: string; attributes?: OtlpAttr[] }[];
}
export interface OtlpResourceSpans {
  resource: { attributes: OtlpAttr[] };
  scopeSpans: { scope: { name: string }; spans: OtlpSpan[] }[];
}

const enc = new TextEncoder();
async function hex(input: string, chars: number): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(input)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, chars);
}
/** The trace id of a thread: derived from its root record, never minted. */
export function traceIdOf(rootId: string): Promise<string> {
  return hex("radia:trace:" + rootId, 32);
}
/** A record span's id; with `attempt` set, that attempt's span id. */
export function spanIdOf(recordId: string, attempt?: number): Promise<string> {
  return hex("radia:span:" + recordId + (attempt !== undefined ? "#" + attempt : ""), 16);
}

/** `run:agent:x:01J…` acted for `agent:x`; anything else is its own service. */
export function agentOf(principal: string): string {
  const p = String(principal || "unknown").split(":");
  if (p[0] === "run" && p.length > 2) return p.slice(1, -1).join(":");
  return String(principal || "unknown");
}

function nanos(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? String(ms) + "000000" : "0";
}
function attr(key: string, value: string | number | boolean | string[]): OtlpAttr {
  if (Array.isArray(value)) return { key, value: { arrayValue: { values: value.map((v) => ({ stringValue: String(v) })) } } };
  if (typeof value === "number") return { key, value: { intValue: String(value) } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return { key, value: { stringValue: value } };
}

/**
 * The spans one RECORD contributes to its trace: its record span plus one span per attempt found
 * in `events` (which may be any superset; only this record's transitions are read). Pure given
 * its inputs, so a one-shot export and a follower produce identical spans for identical history.
 */
export async function recordSpans(
  record: RadiaRecord,
  events: SpaceEvent[],
  rootId: string,
  opts: { claimable?: boolean } = {},
): Promise<{ service: string; span: OtlpSpan }[]> {
  const traceId = await traceIdOf(rootId);
  const recSpanId = await spanIdOf(record.id);
  const meta = record.runtimeMeta;
  const mine = events.filter((e) => e.recordId === record.id);
  const out: { service: string; span: OtlpSpan }[] = [];

  // Attempts: each `take` opens one, the next settle closes it. Status is the settle verb's:
  // ack is OK, a nack is a failed attempt (dead_letter marks the final one), release is a
  // cooperative cancel and stays unset.
  let attempt = 0;
  let open: { n: number; start: string; agent: string } | null = null;
  let lastAck: string | undefined;
  for (const e of mine) {
    if (e.operation === "take") {
      attempt++;
      open = { n: attempt, start: e.ts, agent: agentOf(e.runId) };
    } else if (open && (e.operation === "ack" || e.operation === "nack" || e.operation === "release")) {
      const status = e.operation === "ack"
        ? { code: 1 }
        : e.operation === "nack"
        ? { code: 2, message: e.state === "dead_letter" ? "dead_letter" : "nack (retryable)" }
        : { code: 0 };
      if (e.operation === "ack") lastAck = e.ts;
      out.push({
        service: open.agent,
        span: {
          traceId,
          spanId: await spanIdOf(record.id, open.n),
          parentSpanId: recSpanId,
          name: `${record.kind} attempt ${open.n}`,
          kind: 1,
          startTimeUnixNano: nanos(open.start),
          endTimeUnixNano: nanos(e.ts),
          attributes: [attr("radia.record.id", record.id), attr("radia.attempt", open.n), attr("radia.settle", e.operation)],
          status,
        },
      });
      open = null;
    }
  }

  // The record span: creation to its terminal ack. Never worked (or not settled inside the
  // window this export saw) stays zero-duration and says so, instead of inventing an end.
  const parents = meta.parentIds || [];
  const settled = lastAck !== undefined;
  const links: { traceId: string; spanId: string }[] = [];
  for (const p of parents.slice(1)) links.push({ traceId, spanId: await spanIdOf(p) });
  out.push({
    service: agentOf(meta.createdBy),
    span: {
      traceId,
      spanId: recSpanId,
      ...(parents.length ? { parentSpanId: await spanIdOf(parents[0]) } : {}),
      name: record.kind,
      kind: 1,
      startTimeUnixNano: nanos(meta.createdAt),
      endTimeUnixNano: nanos(settled ? lastAck! : meta.createdAt),
      attributes: [
        attr("radia.record.id", record.id),
        attr("radia.record.kind", record.kind),
        attr("radia.created_by", meta.createdBy),
        ...(meta.taint && meta.taint.length ? [attr("radia.taint", meta.taint)] : []),
        ...(meta.delegationContext && meta.delegationContext.chain?.length ? [attr("radia.delegation", meta.delegationContext.chain)] : []),
        ...(!settled && opts.claimable !== false ? [attr("radia.open", true)] : []),
      ],
      ...(links.length ? { links } : {}),
      ...(attempt > 0 && mine.some((e) => e.operation === "nack" && e.state === "dead_letter") ? { status: { code: 2, message: "dead_letter" } } : {}),
    },
  });
  return out;
}

/** Group per-service spans into OTLP ResourceSpans (service = the agent, run id stripped). */
export function toResourceSpans(spans: { service: string; span: OtlpSpan }[]): OtlpResourceSpans[] {
  const byService = new Map<string, OtlpSpan[]>();
  for (const s of spans) {
    if (!byService.has(s.service)) byService.set(s.service, []);
    byService.get(s.service)!.push(s.span);
  }
  return [...byService.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([service, list]) => ({
    resource: { attributes: [attr("service.name", service)] },
    scopeSpans: [{ scope: { name: "radia-otlp" }, spans: list }],
  }));
}

/** A whole thread at once: the one-shot export. */
export async function buildThreadSpans(
  records: RadiaRecord[],
  events: SpaceEvent[],
  rootId: string,
  opts: { claimableOf?: (kind: string) => boolean } = {},
): Promise<OtlpResourceSpans[]> {
  const all: { service: string; span: OtlpSpan }[] = [];
  for (const r of records) {
    all.push(...await recordSpans(r, events, rootId, { claimable: opts.claimableOf ? opts.claimableOf(r.kind) : true }));
  }
  return toResourceSpans(all);
}

/** POST an ExportTraceServiceRequest to `<collector>/v1/traces`. Throws on a non-2xx answer. */
export async function postTraces(collectorBase: string, resourceSpans: OtlpResourceSpans[]): Promise<void> {
  if (!resourceSpans.length) return;
  const url = collectorBase.replace(/\/+$/, "") + "/v1/traces";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resourceSpans }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`collector refused traces: ${res.status} ${body.slice(0, 200)}`);
  }
  await res.body?.cancel();
}
