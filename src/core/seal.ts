// The event log's tamper evidence: sealing, signing, and verifying the hash chain.
//
// WHAT THIS BUYS, stated plainly so nobody mistakes the guarantee. A hash chain stored in the
// database it protects detects accidental corruption, partial restores, and edits by someone who
// did not know to recompute the following links. It does NOT, on its own, detect an adversary with
// write access, because that adversary can recompute the whole chain.
//
// What closes that gap is the SIGNATURE: each link is HMAC'd under a key that does not live in the
// database, so a rewriter can rebuild the chain and still cannot forge the seals over it. That is
// real detection against the realistic threat (a backup, a replica, a support session, an operator
// quietly deleting an event). An attacker holding both the database and the key is out of scope
// here and is what M2's externally anchored checkpoints are for.
//
// An unsigned chain is still worth having, and the report says which one it is rather than letting
// "verified" mean two different things.

import { CHAIN_GENESIS, type ChainedEvent, eventHash } from "../../sdk/ts/wire.ts";
import type { EventSeal, SpaceEvent, StorageAdapter } from "../storage/adapter.ts";
import type { IntegrityReport } from "../../sdk/ts/wire.ts";
import { readTextFile, restrictToOwner, UsageError, writeTextFile } from "../platform.ts";

/** How many events one sealing pass covers. Bounded because sealing runs on demand, inside a
 *  request, and an unbounded first pass over a long-lived space would hold that request open. */
export const SEAL_BATCH = 500;

const b64 = {
  encode: (b: Uint8Array) => btoa(String.fromCharCode(...b)),
  decode: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

/** The chain input for one event. Split out so the sealer and the verifier cannot disagree about
 *  what was hashed, which is the only way a verifier can be wrong in the direction that matters. */
export function chainedEvent(index: number, e: SpaceEvent): ChainedEvent {
  return {
    index,
    id: e.id,
    ts: e.ts,
    runId: e.runId,
    operation: e.operation,
    recordId: e.recordId,
    kind: e.kind,
    state: e.state,
    bodySha256: e.bodySha256,
    detail: e.detail,
  };
}

/**
 * Signs and checks seals under a key the database does not hold.
 *
 * ONE key signs, several may verify. A chain outlives any single key, so a signature carries the
 * ID of the key that made it, `<kid>:<mac>`, and verification picks by that id. Without it,
 * rotating the seal key makes every earlier link unverifiable and reports it as tampering, which
 * is the one verdict this file exists to make trustworthy. A signature with no `:` is from before
 * key ids and is checked against every key held, newest first.
 */
export class SealKey {
  private constructor(
    private readonly current: { kid: string; key: CryptoKey },
    private readonly retired: { kid: string; key: CryptoKey }[],
    readonly source: string,
  ) {}

  static async fromBytes(raw: Uint8Array, source: string, retired: Uint8Array[] = []): Promise<SealKey> {
    return new SealKey(await entry(raw), await Promise.all(retired.map(entry)), source);
  }

  /** The key new links are signed under. */
  get kid(): string {
    return this.current.kid;
  }

  async sign(hash: string): Promise<string> {
    const mac = await crypto.subtle.sign("HMAC", this.current.key, new TextEncoder().encode(hash));
    return `${this.current.kid}:${b64.encode(new Uint8Array(mac))}`;
  }

  /**
   * Check a link's signature. `unknown_key` is NOT `false`: a link signed by a key this space no
   * longer holds is un-checkable, and reporting it as a bad signature would accuse an honest chain
   * of tampering. The caller decides what an un-checkable link means.
   */
  async verify(hash: string, sig: string): Promise<"ok" | "bad" | "unknown_key"> {
    const at = sig.indexOf(":");
    const kid = at > 0 ? sig.slice(0, at) : undefined;
    const mac = at > 0 ? sig.slice(at + 1) : sig;
    const keys = kid === undefined
      ? [this.current, ...this.retired] // pre-kid: try everything held
      : [this.current, ...this.retired].filter((e) => e.kid === kid);
    if (keys.length === 0) return "unknown_key";
    for (const e of keys) {
      try {
        if (await crypto.subtle.verify("HMAC", e.key, b64.decode(mac) as BufferSource, new TextEncoder().encode(hash))) {
          return "ok";
        }
      } catch {
        return "bad"; // a malformed signature is a failed one, not an exception
      }
    }
    return "bad";
  }
}

/** Keys kept for VERIFYING links signed before a rotation. Never used to sign. */
function retiredKeys(raw: string | undefined, where: string): Uint8Array[] {
  return (raw ?? "").split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
    const key = b64.decode(t);
    if (key.byteLength !== 32) throw new UsageError(`${where} must be a comma-separated list of 32-byte base64 keys`);
    return key;
  });
}

/** Import one seal key. The id is derived under its own label, so it identifies the key without
 *  being a fingerprint to test candidate keys against, and two processes holding the same key
 *  agree on it without being configured. */
async function entry(raw: Uint8Array): Promise<{ kid: string; key: CryptoKey }> {
  const key = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", concat(raw, new TextEncoder().encode("radia/seal-key-id")) as BufferSource));
  return { kid: [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(""), key };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/**
 * Load the seal key from the environment, or generate one in a file beside the runtime directory.
 *
 * Same shape as the blob KEK, and for the same reason: the env var is the real deployment path, and
 * the file is what makes the local default usable without ceremony. The file lives NEXT TO the
 * database rather than in it, which is the whole point; a copied database is not a copied key.
 */
export async function loadSealKey(opts: { env?: string; file?: string; retiredEnv?: string }): Promise<SealKey | undefined> {
  if (opts.env) {
    const raw = b64.decode(opts.env.trim());
    if (raw.byteLength !== 32) {
      throw new UsageError(
        `RADIA_SEAL_KEY must decode to 32 bytes (got ${raw.byteLength}). Generate one with: ` +
          `deno eval 'console.log(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))))'`,
      );
    }
    return await SealKey.fromBytes(raw, "env", retiredKeys(opts.retiredEnv, "RADIA_SEAL_KEY_RETIRED"));
  }
  if (!opts.file) return undefined;
  const existing = readTextFile(opts.file);
  if (existing) {
    const parsed = JSON.parse(existing) as { seal?: string; retired?: string[] };
    const raw = b64.decode((parsed.seal ?? "").trim());
    if (raw.byteLength !== 32) throw new UsageError(`${opts.file} does not contain a 32-byte "seal"`);
    return await SealKey.fromBytes(raw, opts.file, retiredKeys((parsed.retired ?? []).join(","), `${opts.file} "retired"`));
  }
  const raw = crypto.getRandomValues(new Uint8Array(32));
  writeTextFile(opts.file, JSON.stringify({ seal: b64.encode(raw), createdAt: new Date().toISOString() }, null, 2));
  restrictToOwner(opts.file);
  return await SealKey.fromBytes(raw, `${opts.file} (generated)`);
}

/** Build the links for a batch of final events, continuing from `head`. Pure: the caller writes. */
export async function linkEvents(
  head: EventSeal | null,
  events: SpaceEvent[],
  key?: SealKey,
): Promise<EventSeal[]> {
  const out: EventSeal[] = [];
  let prev = head?.hash ?? CHAIN_GENESIS;
  let idx = (head?.idx ?? -1) + 1;
  for (const e of events) {
    const hash = await eventHash(prev, chainedEvent(idx, e));
    out.push({
      idx,
      eventId: e.id,
      cursor: e.cursor,
      seq: e.seq,
      hash,
      prevHash: prev,
      ...(key ? { sig: await key.sign(hash) } : {}),
    });
    prev = hash;
    idx++;
  }
  return out;
}

// The report's SHAPE crosses `/v0`, so it is defined in the wire vocabulary and re-exported here:
// a client restating it is how the SDK's copy came to be missing `spotCheckedFrom`.
export type { IntegrityReport } from "../../sdk/ts/wire.ts";

/**
 * The horizon statement and its reader, in one place so the sweep and the verifier cannot
 * disagree about the format. The event sweep (plan-gc.md phase 3) writes and SEALS this before it
 * deletes anything; verify then accepts a chain that begins at idx J only when the newest sealed
 * statement attests an anchor at or above J. A deeper truncation deletes the statement with the
 * rest and leaves an anchor with no attestation, which is reported as exactly that.
 */
export function horizonStatement(
  anchor: { idx: number; cursor: string; seq: number },
  runId: string,
): { runId: string; operation: string; detail: Record<string, unknown> } {
  return {
    runId,
    operation: "gc",
    detail: { eventHorizon: { anchorIdx: anchor.idx, cursor: anchor.cursor, seq: anchor.seq } },
  };
}

/** The anchor idx a sealed event attests, or null when it is not a horizon statement. */
export function attestedAnchorIdx(e: SpaceEvent): number | null {
  if (e.operation !== "gc") return null;
  const d = e.detail as { eventHorizon?: { anchorIdx?: unknown } } | undefined | null;
  const idx = d?.eventHorizon?.anchorIdx;
  return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
}

/**
 * What chain maintenance needs from a space: the event tables, and the key.
 *
 * TWO MEMBERS, which is the narrowest port in `src/core` and not an accident: sealing and verifying
 * are a walk over the log plus arithmetic over hashes. Nothing here reads a record, a grant or a
 * kind, so nothing here can be wrong about authorization. `sealKey` is optional by the same design
 * the chain has: absent, the chain still detects corruption and naive edits, and `verifyIntegrity`
 * reports WHICH guarantee is in force rather than implying the stronger one.
 */
export interface ChainHost {
  readonly storage: Pick<StorageAdapter, "sealHead" | "sealableEvents" | "appendSeals" | "getSeals" | "appendGcEvent">;
  /** Signs each link under a key held OUTSIDE the database, so a rewriter who can rebuild the
   *  chain still cannot forge the seals over it. */
  readonly sealKey?: SealKey;
}

/**
 * Extend the event chain over everything that has become final since the last pass.
 *
 * ON DEMAND, never on a timer: an idle space should hold no background work, the same lesson
 * `Notifier` and `sweepWatches` learned. Verification seals first, so the answer covers
 * everything sealable at the moment it is asked rather than whatever a timer last got to.
 *
 * Idempotent and safe to run concurrently with another instance: seals are content-derived, so
 * two sealers over one database compute identical rows, and the loser's insert is skipped rather
 * than overwriting a link.
 */
export async function sealEvents(host: ChainHost, limit = SEAL_BATCH): Promise<{ sealed: number; head?: { idx: number; hash: string } }> {
  let head = await host.storage.sealHead();
  let sealed = 0;
  for (;;) {
    const after = head ? { cursor: head.cursor, seq: head.seq } : null;
    const events = await host.storage.sealableEvents(after, Math.min(limit - sealed, SEAL_BATCH));
    if (events.length === 0) break;
    const links = await linkEvents(head, events, host.sealKey);
    const written = await host.storage.appendSeals(links);
    sealed += written;
    // A short write means another sealer claimed those positions. Re-read the head and continue
    // from wherever the chain actually reached, rather than assuming this process's view.
    head = await host.storage.sealHead();
    if (written < links.length || sealed >= limit) break;
  }
  return { sealed, ...(head ? { head: { idx: head.idx, hash: head.hash } } : {}) };
}

/**
 * Verify the event chain, reporting the FIRST divergence.
 *
 * "The chain is invalid" is not an answer anyone can act on. The position, the event it covers,
 * and which of the four ways it failed are, and they are what distinguishes a truncated restore
 * from an edited row.
 *
 * `tail` verifies only the newest N links, from the hash of the one below them. A full walk is
 * O(the whole history) and `radia doctor` embedded one, so a routine health check re-verified
 * every link ever written on every run: measured at 1.7s over 20k links on a fresh space and 60s
 * on a working one, and unbounded from there. A spot check answers what a health report is
 * actually asking (has the recent log been altered) and says so in `spotCheckedFrom`; the full
 * audit stays `radia integrity`, which is where an unbounded walk belongs.
 */
export async function verifyIntegrity(host: ChainHost, opts: { seal?: boolean; limit?: number; tail?: number } = {}): Promise<IntegrityReport> {
  if (opts.seal !== false) await sealEvents(host);
  const head = await host.storage.sealHead();
  const signed = !!host.sealKey;
  const report: IntegrityReport = {
    ok: true,
    checked: 0,
    sealed: head ? head.idx + 1 : 0,
    unsealed: (await host.storage.sealableEvents(head ? { cursor: head.cursor, seq: head.seq } : null, 1)).length,
    signed,
    ...(head ? { head: { idx: head.idx, hash: head.hash } } : {}),
  };
  type Reason = NonNullable<IntegrityReport["failure"]>["reason"];
  const fail = (idx: number, eventId: string, reason: Reason, detail: string) => {
    report.ok = false;
    report.failure = { idx, eventId, reason, detail };
    return report;
  };

  let prev = CHAIN_GENESIS;
  let expectIdx = 0;
  let afterIdx = -1;
  let first = true;
  // Start from the hash BELOW the tail rather than from genesis. Not the anchor path below: that
  // one exists for event GC and demands an attestation, because a chain that begins late without
  // one is indistinguishable from a truncated log. A spot check makes no claim about the links it
  // skipped, so it must not judge them either.
  if (opts.tail !== undefined && head && head.idx + 1 > opts.tail) {
    const from = head.idx + 1 - opts.tail;
    const [below] = await host.storage.getSeals(from - 1, 1);
    if (below) {
      afterIdx = below.idx;
      prev = below.hash;
      expectIdx = below.idx + 1;
      first = false;
      report.spotCheckedFrom = expectIdx;
    }
  }
  // Event GC leaves a chain that begins past genesis (the anchor state: links below the anchor
  // deleted, the anchor's own event swept once the sweep completes). Those facts are collected
  // during the walk and judged AFTER it, because the horizon statement that makes the
  // truncation honest is sealed above it in the retained suffix.
  let truncated: NonNullable<IntegrityReport["truncated"]> | undefined;
  let anchorEventId = "";
  let attested = -1; // newest sealed horizon statement's anchorIdx; the walk ascends, last wins
  for (;;) {
    const seals = await host.storage.getSeals(afterIdx, Math.min(opts.limit ?? SEAL_BATCH, SEAL_BATCH));
    if (seals.length === 0) break;
    // ONE read per PAGE, not one per link. Each link's event was fetched with its own windowed
    // read, which is cheap against a warm cache (0.085ms) and is not what an audit meets: on a
    // freshly started space the same 20k-link walk took 135 SECONDS at ~6.7ms a link. Measured
    // both ways, because the hot-cache number says the opposite and is the one easy to get.
    // Seals are contiguous and ascending, so a page's events are one window; a gap (event GC
    // swept a link) falls back to the single read, which is also the anchor's path.
    const lead = seals[0];
    const window = await host.storage.sealableEvents(
      lead.seq > 0 ? { cursor: lead.cursor, seq: lead.seq - 1 } : null,
      seals.length,
    );
    const byId = new Map(window.map((e) => [e.id, e]));
    for (const seal of seals) {
      const event = byId.get(seal.eventId) ?? await eventById(host, seal.eventId, seal.cursor, seal.seq);
      if (first) {
        first = false;
        if (seal.idx > 0 || !event) {
          // The anchor. Its prev_hash points at a deleted link, so the chain is accepted FROM
          // its hash; what stands behind that hash is the signature (on a signed chain) plus
          // the attestation judged below. A chain that merely STARTS late without either stays
          // a tamper verdict.
          truncated = { anchorIdx: seal.idx, swept: seal.idx + (event ? 0 : 1), attested: false };
          anchorEventId = seal.eventId;
          expectIdx = seal.idx;
          if (seal.idx > 0) prev = seal.prevHash;
        }
      }
      // A missing position is a DELETED link. Without this check a truncated chain verifies
      // perfectly, which is the failure an audit most needs to catch.
      if (seal.idx !== expectIdx) {
        return fail(expectIdx, seal.eventId, "gap", `chain jumps from ${expectIdx - 1} to ${seal.idx}`);
      }
      if (seal.prevHash !== prev) {
        return fail(seal.idx, seal.eventId, "broken_link", `prev_hash does not match the hash at ${seal.idx - 1}`);
      }
      if (!event) {
        // Tolerated at the anchor alone, pending attestation; anywhere else it is tampering.
        if (!(truncated && seal.idx === truncated.anchorIdx)) {
          return fail(seal.idx, seal.eventId, "missing_event", "the sealed event is no longer in the log");
        }
      } else {
        const hash = await eventHash(seal.prevHash, chainedEvent(seal.idx, event));
        if (hash !== seal.hash) {
          return fail(seal.idx, seal.eventId, "hash_mismatch", "the event does not hash to its seal; it was altered after sealing");
        }
        const a = attestedAnchorIdx(event);
        if (a !== null) attested = a;
        report.checked++;
      }
      if (host.sealKey) {
        if (!seal.sig) return fail(seal.idx, seal.eventId, "bad_signature", "the link carries no signature on a signed chain");
        const verdict = await host.sealKey.verify(seal.hash, seal.sig);
        // A link signed under a RETIRED key that nobody supplied is un-checkable, not forged.
        // Calling it a bad signature would report a rotation as tampering, which is the one
        // verdict this report exists to be trusted on.
        if (verdict === "unknown_key") {
          return fail(
            seal.idx,
            seal.eventId,
            "unknown_key",
            "this link was signed under a seal key this space does not hold; supply it (RADIA_SEAL_KEY_RETIRED) to check links from before the rotation",
          );
        }
        if (verdict === "bad") {
          return fail(seal.idx, seal.eventId, "bad_signature", "the signature does not verify; the chain was rebuilt without the key");
        }
      }
      prev = seal.hash;
      expectIdx++;
      afterIdx = seal.idx;
    }
  }
  if (truncated) {
    // Honest states have the chain beginning AT or BELOW the attested anchor: mid-sweep the
    // oldest surviving pair sits below it, at completion exactly on it. Deeper is dishonest.
    truncated.attested = attested >= truncated.anchorIdx;
    report.truncated = truncated;
    if (!truncated.attested) {
      return fail(
        truncated.anchorIdx,
        anchorEventId,
        "unattested_truncation",
        attested < 0
          ? `the chain begins at idx ${truncated.anchorIdx} with no sealed horizon statement; honest event GC seals its horizon before deleting`
          : `the chain begins at idx ${truncated.anchorIdx} but the newest sealed horizon statement attests only idx ${attested}: the log was truncated deeper than GC declared`,
      );
    }
  }
  return report;
}

/**
 * Write and seal the horizon statement that makes an event-log truncation attributable to GC
 * rather than to tampering. The M2 event sweep MUST call this and see `attested: true` BEFORE
 * it deletes anything: a crash after deletion but before the statement leaves an anchor with no
 * attestation, which verify reports as tampering, and would be right to. `attested: false`
 * means the statement is committed but the finality watermark has not let the chain seal
 * through it yet; the sweep must not proceed until a later attempt seals it.
 */
export async function attestEventTruncation(
  host: ChainHost,
  anchor: { idx: number; cursor: string; seq: number },
  runId = "gc:events",
): Promise<{ attested: boolean }> {
  const at = await host.storage.appendGcEvent(horizonStatement(anchor, runId));
  await sealEvents(host);
  const head = await host.storage.sealHead();
  const attested = !!head &&
    (BigInt(head.cursor) > BigInt(at.cursor) || (head.cursor === at.cursor && head.seq >= at.seq));
  return { attested };
}

/** The sealed event, read back for verification. Positioned by its cursor rather than scanned:
 *  a verify must not become a full log scan per link. */
async function eventById(host: ChainHost, id: string, cursor: string, seq: number): Promise<SpaceEvent | undefined> {
  const before = seq > 0 ? { cursor, seq: seq - 1 } : null;
  const window = await host.storage.sealableEvents(before, 4);
  return window.find((e) => e.id === id);
}