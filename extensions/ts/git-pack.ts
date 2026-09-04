// Git's smart transport, upload-pack only: the advertisement, the request, and a packfile.
//
// WHY, given that the dumb protocol already works. Dumb costs one HTTP round trip per object, walked
// mostly serially. Measured on a realistic code-generation history (22 versions of a 9-file tree):
// 96 objects, so 98 requests. Locally that is nothing; at 50ms it is five seconds, and it grows with
// every iteration an agent makes. Smart replaces the whole exchange with two requests and one
// packfile.
//
// WHAT IS DELIBERATELY MISSING. No delta compression: every object goes in whole. A pack of
// undeltified objects is completely valid — `git index-pack` accepts it and `git fsck` is happy —
// and deltas are a bandwidth optimisation on top of the ten-times-fewer-round-trips one, with a
// whole new failure surface. No negotiation either: `have` lines are read and ignored, so a `fetch`
// gets a full pack rather than a difference. Both are worth revisiting only with a workspace big
// enough to make them measurable, which is the same rule that decided to build this at all.
//
// NOT A NORMATIVE SURFACE, unlike the object encoding next door. Two packs of one history may
// legitimately differ (ordering, compression level, deltas); what must match is the object IDS,
// which come from `git.ts` and are pinned by known-answer vectors there. So this file can be
// rewritten freely and `extensions/conformance/git.test.ts` still means what it did.
//
// PROTOCOL VERSION 0. Git sends `Git-Protocol: version=2` and falls back when the response is a v0
// advertisement, which is what this returns. v2 is a better protocol and buys nothing here: its
// wins are ref filtering on repositories with thousands of refs, and a workspace has one per head.

import { inflateSync } from "node:zlib";
import { type GitObject, type GitObjectType, gitObjectId, zlib } from "./git.ts";

const enc = new TextEncoder();
const FLUSH = enc.encode("0000");
export const ZERO_ID = "0".repeat(40);

/** One pkt-line: four hex digits of the total length, then the payload. */
export function pkt(s: string): Uint8Array {
  const body = enc.encode(s);
  return concat(enc.encode((body.length + 4).toString(16).padStart(4, "0")), body);
}

/**
 * The `GET info/refs?service=git-upload-pack` body.
 *
 * Three things here are load-bearing and easy to get wrong, because git fails on each of them by
 * falling back or by hanging rather than by complaining:
 *
 *   - the service header comes FIRST, then a flush, then the refs, then another flush;
 *   - capabilities ride on the first ref line after a NUL byte, not on a line of their own;
 *   - `symref=HEAD:refs/heads/<x>` is how a clone learns which branch to check out. Without it git
 *     guesses, and a workspace whose head is not `main` checks out detached.
 */
export function advertisement(branches: Record<string, string>, head: string): Uint8Array {
  const headCommit = branches[head];
  const caps = `symref=HEAD:refs/heads/${head} agent=radia`;
  const lines: Uint8Array[] = [pkt("# service=git-upload-pack\n"), FLUSH];
  // HEAD first, carrying the capabilities, then every branch in sorted order.
  if (headCommit) lines.push(pkt(`${headCommit} HEAD\0${caps}\n`));
  let first = !headCommit;
  for (const [branch, commit] of Object.entries(branches).sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(pkt(`${commit} refs/heads/${branch}${first ? `\0${caps}` : ""}\n`));
    first = false;
  }
  lines.push(FLUSH);
  return concat(...lines);
}

/**
 * The `GET info/refs?service=git-receive-pack` body: the same refs, a different service line, and
 * the capabilities a PUSH negotiates. `report-status` is what lets the answer say "ng" per ref;
 * without it git assumes silence is success. `ofs-delta` is not advertised, so in-pack deltas
 * arrive as ref-deltas, though the reader takes both.
 */
export function receiveAdvertisement(branches: Record<string, string>): Uint8Array {
  const caps = "report-status agent=radia";
  const lines: Uint8Array[] = [pkt("# service=git-receive-pack\n"), FLUSH];
  let first = true;
  for (const [branch, commit] of Object.entries(branches).sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(pkt(`${commit} refs/heads/${branch}${first ? `\0${caps}` : ""}\n`));
    first = false;
  }
  lines.push(FLUSH);
  return concat(...lines);
}

/** One ref update a push asks for. `old` is the client's belief about the current tip; `ZERO_ID`
 *  on either side means create or delete. */
export interface RefCommand {
  old: string;
  new: string;
  ref: string;
}

/** Parse the `POST git-receive-pack` body: `<old> <new> <ref>[\0caps]` lines to a flush, then the
 *  packfile, present only when the push carries objects. */
export function parseReceivePack(body: Uint8Array): { commands: RefCommand[]; caps: string[]; pack: Uint8Array | null } {
  const commands: RefCommand[] = [];
  let caps: string[] = [];
  const dec = new TextDecoder();
  let i = 0;
  for (; i + 4 <= body.length;) {
    const length = parseInt(dec.decode(body.subarray(i, i + 4)), 16);
    if (!Number.isFinite(length) || (length > 0 && length < 4) || i + length > body.length) {
      throw new Error("receive-pack: malformed pkt-line");
    }
    if (length === 0) {
      i += 4;
      break;
    }
    const line = dec.decode(body.subarray(i + 4, i + length)).replace(/\n$/, "");
    i += length;
    const [cmd, capText] = line.split("\0");
    if (capText !== undefined) caps = capText.split(" ").filter(Boolean);
    const [oldId, newId, ref] = cmd.split(" ");
    if (!/^[0-9a-f]{40}$/.test(oldId ?? "") || !/^[0-9a-f]{40}$/.test(newId ?? "") || !ref) {
      throw new Error(`receive-pack: malformed command ${JSON.stringify(cmd)}`);
    }
    commands.push({ old: oldId, new: newId, ref });
  }
  const rest = body.subarray(i);
  return { commands, caps, pack: rest.length > 0 ? rest : null };
}

/** The `report-status` answer: `unpack ok` (or the unpack error), one line per ref, a flush. */
export function receiveReport(unpack: string, refs: { ref: string; ok: boolean; message?: string }[]): Uint8Array {
  // Neither line may contain a newline: one line is one pkt, and git reads the first word of each.
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  const lines = [pkt(`unpack ${oneLine(unpack) || "error"}\n`)];
  for (const r of refs) {
    lines.push(pkt(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${oneLine(r.message ?? "refused")}\n`));
  }
  lines.push(FLUSH);
  return concat(...lines);
}

// ── reading a pack ────────────────────────────────────────────────────────────────────────────
//
// The half the header said was deliberately missing, needed now that a pack can ARRIVE. A push is
// a thin pack: deltas against objects the client believes the server holds (ref-delta) and against
// earlier objects in the same pack (ofs-delta, when advertised). Deltas are applied against their
// resolved base, and every resulting object is RE-HASHED: an id is taken from the bytes, never from
// the pack's own claim, so a pack cannot alias one object as another.
//
// INFLATING NEEDS ONE THING THE WEB API DOES NOT GIVE: where the stream ended. Objects sit end to end
// with no length on the compressed bytes, so the next one starts wherever this one's zlib stream
// stopped. `DecompressionStream` throws on the bytes after a stream and, measured, hands back the
// full output of a stream missing its last five bytes, so it neither locates the end nor checks the
// trailer. `node:zlib`'s synchronous inflate with `info` stops at the stream end, verifies the
// adler32, and reports the input it consumed, which is what a packfile needs and why this file
// reaches for a Node built-in where everything around it uses Web APIs. A ~250-line decoder written
// for the same property was replaced by it.

/** Inflate one zlib stream at `offset`, hold it to the length the pack header claimed, and say
 *  where it ended. A header that lies desynchronises the whole rest of the pack, so a length
 *  mismatch fails here rather than on the object that follows. */
export function inflateAt(src: Uint8Array, offset: number, expected: number): { data: Uint8Array; consumed: number } {
  let r: { buffer: Uint8Array; engine: { bytesWritten: number } };
  try {
    r = inflateSync(src.subarray(offset), { info: true, maxOutputLength: Math.max(expected, 1) }) as unknown as typeof r;
  } catch (e) {
    throw new Error(`inflate: ${(e as Error).message}`);
  }
  if (r.buffer.length !== expected) throw new Error(`inflate: expected ${expected} bytes, got ${r.buffer.length}`);
  return { data: new Uint8Array(r.buffer.buffer, r.buffer.byteOffset, r.buffer.byteLength), consumed: r.engine.bytesWritten };
}

const MAX_PACK_OBJECTS = 100_000;
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_DELTA_DEPTH = 64;

interface RawEntry {
  offset: number;
  type: number; // 1 commit, 2 tree, 3 blob, 4 tag, 6 ofs-delta, 7 ref-delta
  data: Uint8Array;
  baseOffset?: number;
  baseId?: string;
}

const TYPE_NAME: Record<number, GitObjectType> = { 1: "commit", 2: "tree", 3: "blob" };

/**
 * Every object in a packfile, resolved and keyed by id. `external` answers a ref-delta whose base is
 * not in the pack (the thin-pack case); a base nobody has is an error naming its id.
 */
export async function readPack(
  bytes: Uint8Array,
  external: (id: string) => GitObject | undefined = () => undefined,
): Promise<Map<string, GitObject>> {
  if (bytes.length < 32 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "PACK") throw new Error("not a packfile");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4);
  if (version !== 2) throw new Error(`packfile version ${version} is not supported`);
  const count = view.getUint32(8);
  if (count > MAX_PACK_OBJECTS) throw new Error(`packfile claims ${count} objects; the ceiling is ${MAX_PACK_OBJECTS}`);
  // The trailer is the SHA-1 of everything before it. Checked first: a truncated or corrupted pack
  // fails here rather than as a confusing inflate error deep inside.
  const claimed = toHex(bytes.subarray(bytes.length - 20));
  const actual = toHex(new Uint8Array(await crypto.subtle.digest("SHA-1", bytes.subarray(0, bytes.length - 20) as BufferSource)));
  if (claimed !== actual) throw new Error("packfile checksum mismatch");

  const entries: RawEntry[] = [];
  let p = 12;
  for (let n = 0; n < count; n++) {
    const offset = p;
    let c = bytes[p++];
    const type = (c >> 4) & 7;
    let size = c & 15;
    let shift = 4;
    while (c & 0x80) {
      c = bytes[p++];
      size += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (size > MAX_OBJECT_BYTES) throw new Error(`pack object of ${size} bytes exceeds the ${MAX_OBJECT_BYTES} ceiling`);
    const entry: RawEntry = { offset, type, data: new Uint8Array(0) };
    if (type === 6) {
      c = bytes[p++];
      let back = c & 0x7f;
      while (c & 0x80) {
        c = bytes[p++];
        back = (back + 1) * 128 + (c & 0x7f);
      }
      entry.baseOffset = offset - back;
    } else if (type === 7) {
      entry.baseId = toHex(bytes.subarray(p, p + 20));
      p += 20;
    } else if (!(type in TYPE_NAME) && type !== 4) throw new Error(`pack object type ${type} is not valid`);
    const { data, consumed } = inflateAt(bytes, p, size);
    entry.data = data;
    p += consumed;
    entries.push(entry);
  }
  if (p !== bytes.length - 20) throw new Error("packfile has trailing bytes before its checksum");

  const byOffset = new Map(entries.map((e) => [e.offset, e]));
  const resolved = new Map<RawEntry, GitObject | null>(); // null: a tag, which has no place here
  const byId = new Map<string, GitObject>();
  // Ids of the plain objects first, so a ref-delta against an in-pack base resolves without an
  // extra pass.
  for (const e of entries) {
    if (e.type in TYPE_NAME) {
      const type = TYPE_NAME[e.type];
      const obj = { id: await gitObjectId(type, e.data), type, payload: e.data };
      resolved.set(e, obj);
      byId.set(obj.id, obj);
    } else if (e.type === 4) resolved.set(e, null);
  }
  const resolve = async (e: RawEntry, depth: number): Promise<GitObject | null> => {
    const hit = resolved.get(e);
    if (hit !== undefined) return hit;
    if (depth > MAX_DELTA_DEPTH) throw new Error("delta chain too deep");
    let base: GitObject | null | undefined;
    if (e.baseOffset !== undefined) {
      const b = byOffset.get(e.baseOffset);
      if (!b) throw new Error("ofs-delta names an offset that is not an object");
      base = await resolve(b, depth + 1);
    } else {
      base = byId.get(e.baseId!) ?? external(e.baseId!);
      if (!base) throw new Error(`delta base ${e.baseId} is neither in the pack nor in the repository`);
    }
    if (base === null) throw new Error("a delta against a tag");
    const payload = applyDelta(base.payload, e.data);
    const obj = { id: await gitObjectId(base.type, payload), type: base.type, payload };
    resolved.set(e, obj);
    byId.set(obj.id, obj);
    return obj;
  };
  for (const e of entries) await resolve(e, 0);
  return byId;
}

/** Git's delta format: two varint sizes, then copy (high bit set) and insert commands. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let p = 0;
  const varint = () => {
    let v = 0, shift = 0, b: number;
    do {
      if (p >= delta.length) throw new Error("delta: truncated size");
      b = delta[p++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return v;
  };
  const baseSize = varint();
  if (baseSize !== base.length) throw new Error(`delta: base is ${base.length} bytes, delta expects ${baseSize}`);
  const size = varint();
  if (size > MAX_OBJECT_BYTES) throw new Error("delta: result exceeds the object ceiling");
  const out = new Uint8Array(size);
  let o = 0;
  while (p < delta.length) {
    const cmd = delta[p++];
    if (cmd & 0x80) {
      let off = 0, n = 0;
      if (cmd & 0x01) off |= delta[p++];
      if (cmd & 0x02) off |= delta[p++] << 8;
      if (cmd & 0x04) off |= delta[p++] << 16;
      if (cmd & 0x08) off += delta[p++] * 2 ** 24;
      if (cmd & 0x10) n |= delta[p++];
      if (cmd & 0x20) n |= delta[p++] << 8;
      if (cmd & 0x40) n |= delta[p++] << 16;
      if (n === 0) n = 0x10000;
      if (off + n > base.length || o + n > size) throw new Error("delta: copy out of range");
      out.set(base.subarray(off, off + n), o);
      o += n;
    } else if (cmd) {
      if (p + cmd > delta.length || o + cmd > size) throw new Error("delta: insert out of range");
      out.set(delta.subarray(p, p + cmd), o);
      o += cmd;
      p += cmd;
    } else throw new Error("delta: zero command is reserved");
  }
  if (o !== size) throw new Error(`delta: produced ${o} bytes, expected ${size}`);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** What a client asked for. `haves` is parsed and then ignored; see the header. */
export interface UploadPackRequest {
  wants: string[];
  haves: string[];
  done: boolean;
}

/** Parse the `POST git-upload-pack` body: `want <sha> [caps]`, flush, `have <sha>`…, `done`. */
export function parseUploadPack(body: Uint8Array): UploadPackRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;
  const dec = new TextDecoder();
  for (let i = 0; i + 4 <= body.length;) {
    const header = dec.decode(body.subarray(i, i + 4));
    const length = parseInt(header, 16);
    // A flush (`0000`) or an unparseable header ends a section rather than the message: wants are
    // followed by one, and haves follow that.
    if (!Number.isFinite(length) || length === 0) {
      i += 4;
      continue;
    }
    const line = dec.decode(body.subarray(i + 4, i + length)).trim();
    i += length;
    const [verb, sha] = line.split(" ");
    if (verb === "want" && sha) wants.push(sha);
    else if (verb === "have" && sha) haves.push(sha);
    else if (verb === "done") done = true;
  }
  return { wants, haves, done };
}

/**
 * The `POST git-upload-pack` response: `NAK`, then the pack.
 *
 * `NAK` means "I have nothing in common with you", which is true by construction here since haves
 * are ignored. It is also what the client waits for before reading pack bytes, so it is not
 * optional even when the answer is the whole history.
 *
 * No side-band, because none was advertised: the pack follows the NAK as raw bytes on the same
 * response. Advertising `side-band-64k` would mean framing every chunk and buying the ability to
 * interleave progress messages nobody reads.
 */
export async function uploadPackResponse(objects: Iterable<GitObject>): Promise<Uint8Array> {
  return concat(pkt("NAK\n"), await packfile(objects));
}

/** An error the client will print, in the one form upload-pack has for saying so. */
export function uploadPackError(message: string): Uint8Array {
  return concat(pkt("NAK\n"), pkt(`ERR ${message}\n`));
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3 };

/**
 * A version-2 packfile of every object given, undeltified.
 *
 * `PACK`, a version, a count, then per object a variable-length (type, size) header followed by the
 * zlib of its payload, and a SHA-1 of everything before it. The size in that header is the
 * UNCOMPRESSED length, and it is the field most easily got wrong: git uses it to know when an
 * object ends, so a wrong one desynchronises the whole rest of the pack rather than failing on the
 * object that carried it.
 */
export async function packfile(objects: Iterable<GitObject>): Promise<Uint8Array> {
  const all = [...objects];
  const head = new Uint8Array(12);
  head.set(enc.encode("PACK"), 0);
  new DataView(head.buffer).setUint32(4, 2);
  new DataView(head.buffer).setUint32(8, all.length);

  const chunks: Uint8Array[] = [head];
  for (const object of all) {
    chunks.push(objectHeader(TYPE_CODE[object.type], object.payload.length));
    chunks.push(await zlib(object.payload));
  }
  const body = concat(...chunks);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", body as BufferSource));
  return concat(body, digest);
}

/**
 * The per-object header: type in bits 6-4 of the first byte, then the size in 7-bit groups.
 *
 * Note the asymmetry that makes this easy to write backwards: the FIRST byte carries the low four
 * bits of the size, every later byte carries seven more, and the continuation bit is the high bit
 * of the byte you are leaving rather than the one you are entering.
 */
function objectHeader(type: number, size: number): Uint8Array {
  const out: number[] = [];
  let byte = (type << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    out.push(byte | 0x80);
    byte = size & 0x7f;
    size = Math.floor(size / 128);
  }
  out.push(byte);
  return new Uint8Array(out);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
