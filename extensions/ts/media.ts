// Bytes in and out of a tool call, with the rules a copy gets wrong.
//
// Two helpers, not a worker: a media worker's loop is already `serveTools` (./tool-worker.ts) and
// its middle is a provider call. What is worth sharing is the handling either side of that, because
// each of these carries a rule that is invisible at the call site and expensive to rediscover:
//
//   storing   an artifact needs `conversationId` in its META, not only in its lineage, or a grant
//             cannot bind it: patterns match the BODY, and `parent_ids` is not body.
//   reading   an artifact is BY ID and by HEAD first, and a permission failure must not be
//             reported as a missing file.

import type { RadiaClient } from "../../sdk/ts/client.ts";

/** The part of a `tool_call` these need: who asked, on whose behalf, under which call. */
export interface CallRef {
  callId: string;
  conversationId?: string;
  owner?: string;
}

/**
 * Store bytes a tool produced, as an artifact the caller can be handed a reference to.
 *
 * `taint` is the caller's claim about where the bytes came from and is not defaulted: generated
 * media is a prompt-injection vector the moment anything reads it back (instructions render as
 * pixels), so `["net"]` is usual for a provider's output, and a caller that knows better says so.
 */
export async function storeToolArtifact(
  client: RadiaClient,
  call: CallRef,
  bytes: Uint8Array,
  opts: { mediaType: string; filename: string; taint?: string[] },
): Promise<{ id: string; size: number; mediaType: string }> {
  const artifact = await client.putArtifact(bytes, {
    mediaType: opts.mediaType,
    filename: opts.filename,
    parentIds: [call.callId], // lineage: conversation -> tool_call -> artifact
    ...(opts.taint?.length ? { taint: opts.taint } : {}),
    // Lineage records where it CAME from; this is what a grant can BIND. Without it an artifact is
    // readable by any session that learns its id, whatever the conversation scoping says.
    meta: { conversationId: call.conversationId ?? "", owner: call.owner ?? "" },
  });
  return { id: artifact.id, size: artifact.size, mediaType: opts.mediaType };
}

/** Why a read was refused, in words a model can act on. `null` means the bytes are usable. */
export type ReadRefusal = string;

/**
 * Fetch an artifact a tool was asked about, refusing before the bytes move.
 *
 * BY ID ONLY: no path, no URL, no base64, so the runtime's read grant decides whether the call is
 * allowed rather than a string a model composed. HEAD first, so an unreadable type or an oversized
 * blob costs nothing. And a PERMISSION failure is named as one: the same lookup answering "not
 * found" for a missing grant sent an assistant round eight retries of a call that could never work.
 */
export async function readToolArtifact(
  client: RadiaClient,
  artifactId: string,
  opts: { accept?: string[]; maxBytes?: number; describeSize?: (n: number) => string } = {},
): Promise<{ bytes: Uint8Array; mediaType: string; size: number } | { refused: ReadRefusal }> {
  const size = opts.describeSize ?? ((n: number) => `${Math.round(n / 1024)} KB`);
  let meta: { mediaType: string; size: number } | null;
  try {
    meta = await client.artifactMeta(artifactId);
  } catch (e) {
    const status = (e as { status?: number }).status;
    return {
      refused: status === 403 || status === 401
        ? `not allowed to read artifact ${artifactId}: this is a permission problem, not a missing file`
        : String(e),
    };
  }
  if (!meta) return { refused: `no artifact ${artifactId}` };
  const mediaType = meta.mediaType.split(";")[0].trim().toLowerCase();
  if (opts.accept && !opts.accept.includes(mediaType)) {
    return { refused: `${artifactId} is ${mediaType}; accepted types are ${opts.accept.join(", ")}` };
  }
  if (opts.maxBytes !== undefined && meta.size > opts.maxBytes) {
    return { refused: `${artifactId} is ${size(meta.size)}, over the ${size(opts.maxBytes)} limit` };
  }
  return { bytes: await client.getArtifact(artifactId), mediaType, size: meta.size };
}
