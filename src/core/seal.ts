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
import type { EventSeal, SpaceEvent } from "../storage/adapter.ts";
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

/** What a verification found. `ok` is the only field a caller should branch on. */
export interface IntegrityReport {
  /** Set when only a SUFFIX was walked (`verifyIntegrity({tail})`): the first idx checked. `ok`
   *  then means "nothing below this was altered", and says nothing about the links beneath it. */
  spotCheckedFrom?: number;
  ok: boolean;
  /** Links checked in this pass. */
  checked: number;
  /** Chain length, so "0 checked" cannot read as "verified". */
  sealed: number;
  /** Events committed but not yet sealed. Not a fault: sealing follows the watermark. */
  unsealed: number;
  head?: { idx: number; hash: string };
  /** Present only when the chain is signed. `false` means a link's signature did not verify, which
   *  is the case a bare chain cannot distinguish from an honest rebuild. */
  signed: boolean;
  /**
   * Present when the chain begins past genesis: event GC's anchor state. `swept` counts events
   * whose content is gone (`anchorIdx` links below the anchor, plus the anchor's own event once
   * the sweep completes); the anchor's dense idx is what makes it exact. `attested` means the
   * retained suffix carries a sealed horizon statement covering the anchor, so the truncation is
   * the one the sweep declared; without it `ok` is false (`unattested_truncation`). On an
   * unsigned chain an attestation is naive-edit evidence only, like the chain itself.
   */
  truncated?: { anchorIdx: number; swept: number; attested: boolean };
  failure?: {
    idx: number;
    eventId: string;
    reason: "hash_mismatch" | "broken_link" | "missing_event" | "bad_signature" | "unknown_key" | "gap" | "unattested_truncation";
    detail: string;
  };
}

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
