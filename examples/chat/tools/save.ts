// `save_content`: persist something the assistant wrote as an artifact.
//
// The counterpart to `run_code`'s `save_as`, which only covers bytes a PROGRAM produced. Content
// the model composed directly (an SVG it drew in prose, a config it drafted, a summary worth
// keeping) has no other route out of the conversation, and telling it to re-emit the same text
// inside a `run_code` literal costs the identical tokens and lands in the thread identically. So
// the direct tool is not a shortcut around the "bytes never travel inside a record" rule; it is
// the honest shape for content whose only source is the model's own output.
//
// Why not make every message an artifact instead: record bodies must stay queryable JSON or
// matching, pattern scoping, windowing and the Feed all stop working. Payloads go out of line;
// the conversation itself does not.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import type { Tool, ToolContext } from "./files.ts";
import type { ToolDef } from "../provider/openrouter.ts";
import { bytesFrom, mediaTypeFor } from "../util.ts";

export function makeSaveTools(client: RadiaClient): Record<string, Tool> {
  return {
    save_content: async (a, ctx?: ToolContext) => {
      const content = typeof a.content === "string" ? a.content : "";
      if (!content) return { error: "save_content needs `content`" };
      const filename = typeof a.filename === "string" ? a.filename : undefined;
      const mediaType = typeof a.media_type === "string" ? a.media_type : mediaTypeFor(filename);
      const { id, size } = await client.putArtifact(bytesFrom(content, a.encoding), {
        mediaType,
        filename,
        // Lineage: conversation -> tool_call -> artifact, so a stored file can be traced back to
        // the turn that produced it.
        parentIds: ctx?.callId ? [ctx.callId] : undefined,
        // Body metadata, not lineage: a grant pattern matches the body, so this is what pins the
        // artifact to the conversation that produced it.
        meta: { conversationId: ctx?.conversationId ?? "", owner: ctx?.owner ?? "" },
        // Model-authored content, possibly derived from something it read: untrusted, like any
        // other output on this path. Clearing it needs a privileged declassify.
        taint: true,
      });
      return { artifactId: id, mediaType, size, filename };
    },
  };
}

export const SAVE_SCHEMAS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "save_content",
      description:
        "Store text you have written as a file (an artifact) the user can open and keep: SVG, " +
        "JSON, CSV, Markdown, code, anything textual. Use this when the user asks you to save, " +
        "store or keep something you produced in the conversation. Pass the exact content and a " +
        "filename; the media type comes from the extension unless media_type overrides it. For " +
        "binary formats, pass base64 and set encoding:\"base64\". Returns {artifactId, mediaType, " +
        "size}. The user is shown a link automatically, so refer to it in words rather than " +
        "inventing a path. To save the OUTPUT OF A PROGRAM instead, use run_code with save_as, " +
        "which avoids repeating the content here.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The exact bytes to store, as text." },
          filename: { type: "string", description: "Name to store it under, e.g. 'koala.svg'." },
          media_type: { type: "string", description: "Override the media type, e.g. 'text/csv'." },
          encoding: { type: "string", enum: ["utf8", "base64"], description: "How `content` encodes the bytes." },
        },
        required: ["content", "filename"],
      },
    },
  },
];
