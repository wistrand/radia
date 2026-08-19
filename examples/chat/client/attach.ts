// Bytes a person hands the chat: stored beside the conversation, named in the message.
//
// The MARKER is why this is shared rather than written twice. It is what the assistant sees, and
// `artifactId <id>` in it is how a tool call reaches the bytes afterwards (read_image, save, the
// exec worker). A terminal and a page that formatted it differently would give the same model two
// vocabularies for the same thing, and the second one would work until it did not.
//
// Staging (which bytes become artifacts at all) is `client/attachments.ts`, deliberately I/O-free.
// This is the I/O half.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import type { StagedItem } from "./attachments.ts";

/** Where an attachment belongs. `conversationId` is the stamp a GRANT matches on the way in, so it
 *  is not decoration: without it the write is refused rather than misfiled. */
export interface AttachTarget {
  conversationId: string;
  owner: string;
}

const humanSize = (size: number) => size >= 1024 * 1024 ? `${Math.round(size / 1024 / 1024)} MB` : `${Math.round(size / 1024)} KB`;

/**
 * Store bytes as an artifact of this conversation and return the marker that goes in the message.
 *
 * No size check here on purpose: the space holds the ceiling (413 `artifact_too_large`) and the
 * vision worker holds its own, tighter one. A third number in the client is a third number to
 * drift, and it would refuse files that are perfectly storable but merely too big to LOOK at.
 */
export async function attachArtifact(client: RadiaClient, item: StagedItem, to: AttachTarget): Promise<string> {
  const { id, size } = await client.putArtifact(item.bytes, {
    mediaType: item.mediaType,
    filename: item.filename,
    meta: { conversationId: to.conversationId, owner: to.owner },
    // Bytes from the person's own machine, which is exactly what the label names. The exec worker
    // stamps the same one for the same reason; nothing bars it today, and the point of a closed
    // label set is that provenance is stated when it is known rather than invented later.
    taint: ["file"],
  });
  return `[attached ${item.filename} · ${item.mediaType} · ${humanSize(size)} · artifactId ${id}]`;
}
