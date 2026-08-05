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

import { type GitObject, type GitObjectType, zlib } from "./git.ts";

const enc = new TextEncoder();
const FLUSH = enc.encode("0000");

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
