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
import { readWorkspace, writeWorkspace } from "../../../extensions/ts/workspace.ts";

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
        // No label. "The model wrote this" is a graph fact the log answers; a label is only for
        // what a BARRIER tests, and nothing bars content for having been authored. Anything the
        // model READ to write it is already labelled on the parents this inherits from.
        taint: [],
      });
      return { artifactId: id, mediaType, size, filename };
    },
  };
}

/**
 * `share_artifact`: turn a stored artifact into a URL someone can OPEN.
 *
 * Separate from `save_content` because the two URLs answer different questions, and the assistant
 * had only one of them. `save_content` returns an artifact id, and the id-based URL is the stable
 * way to REFER to an artifact: it never changes and it needs a token, which a browser cannot attach
 * to a typed URL or an `<img src>`. A capability URL is the way to OPEN one: short-lived, scoped to
 * a single artifact, and carrying its own authorization in the query string.
 *
 * Without this the assistant could produce a file and then had no honest way to hand it over. What
 * it did instead was quote the id URL (which 401s in a browser, and downloads rather than renders
 * even with a token) or invent a capability URL it had no way to mint.
 *
 * Takes the SESSION's client, never the worker's. `POST /v0/artifacts/{id}/capability` authorizes
 * at MINT time against the caller's read grant, so running it as the session is what stops a scoped
 * user from converting an artifact it cannot read into a link that needs no token at all. Handing
 * this the worker's credential would do exactly that.
 */
export function makeShareTools(session: RadiaClient): Record<string, Tool> {
  return {
    share_artifact: async (a) => {
      const id = typeof a.artifact_id === "string" ? a.artifact_id : "";
      if (!id) return { error: "share_artifact needs `artifact_id`" };
      const { url, expiresAt } = await session.artifactCapability(id);
      // Absolute, always. The server returns a RELATIVE url when no isolated artifact origin is
      // running (`--artifact-port 0`), which the console can resolve against its own origin and an
      // agent cannot: handing a model `/v0/artifacts/…` produces an answer no user can open, and
      // the model has no way to know what to prepend.
      return { url: new URL(url, session.base).toString(), expiresAt };
    },
  };
}

export const SHARE_SCHEMAS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "share_artifact",
      description:
        "Turn an artifact you stored into a URL the user can OPEN in a browser. Use it whenever " +
        "you have just produced a file the user will want to look at (a web page, an image, an " +
        "SVG, a report) and whenever they ask for a link. The artifact id you get back from " +
        "save_content or run_code is how you REFER to an artifact, not how anyone opens one: that " +
        "URL needs an Authorization header, which a browser cannot attach to a typed address or " +
        "an <img src>, so quoting it hands the user a 401. Returns {url, expiresAt}. Give the user " +
        "the url exactly as returned and say it expires; never edit it, and never construct such a " +
        "URL yourself, because the authorization in it can only be minted here. It is short-lived " +
        "and covers that one artifact. You can only share an artifact you are allowed to read, so " +
        "a failure here means the artifact is not yours, not that you asked wrongly.",
      parameters: {
        type: "object",
        properties: {
          artifact_id: { type: "string", description: "The artifactId returned by save_content, run_code with save_as, or generate_image." },
        },
        required: ["artifact_id"],
      },
    },
  },
];

export const SAVE_SCHEMAS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "save_content",
      description:
        "Store a DOCUMENT you have written as a file the user can open and keep: an HTML page, an " +
        "SVG, a report, a config, a CSV. This is the DEFAULT way to hand over a document. Use it " +
        "whenever the answer IS a document rather than " +
        "prose: \"create a web page\", \"write me a config\", \"draw an SVG\" all want this, and none " +
        "of them contain the word save. NOT for code: a program belongs in save_workspace, even a " +
        "single file, because a workspace can be RUN, keeps every version, and lets a verdict " +
        "attach to it, while an artifact is only bytes. Do not print your content through run_code " +
        "to store it either; that sends the same text twice and stores what you would have passed " +
        "here. Pass the exact content and a " +
        "filename; the media type comes from the extension unless media_type overrides it. For " +
        "binary formats, pass base64 and set encoding:\"base64\". Returns {artifactId, mediaType, " +
        "size}. To give the user something they can actually open, pass that artifactId to " +
        "share_artifact; the id alone is a reference, not a link. Only when the bytes must be " +
        "COMPUTED (a program derives them from data you do not already have in hand) use run_code " +
        "with save_as instead.",
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

/**
 * `save_workspace`: store a multi-file tree the assistant wrote, so `run_code` can run against it.
 *
 * The counterpart to `save_content` for something that is not one file. A program with an import,
 * a fixture and a test is three files and one relationship, and squeezing it into a single `code`
 * string loses the relationship, the paths, and any chance of changing one file at a time.
 *
 * Written as the WORKER, like `save_content`, but stamped with the SESSION's owner so the tree
 * belongs to whoever asked for it and a scoped grant can bind it.
 */
export function makeWorkspaceTools(client: RadiaClient): Record<string, Tool> {
  return {
    save_workspace: async (a, ctx?: ToolContext) => {
      const name = typeof a.name === "string" ? a.name.trim() : "";
      if (!name) return { error: "save_workspace needs a `name`" };
      const files = a.files;
      if (!files || typeof files !== "object" || Array.isArray(files)) {
        return { error: "save_workspace needs `files` as an object of path -> contents" };
      }
      const entries = Object.entries(files as Record<string, unknown>);
      if (entries.length === 0) return { error: "save_workspace needs at least one file" };
      const contents: Record<string, string> = {};
      for (const [path, v] of entries) {
        if (typeof v !== "string") return { error: `file ${JSON.stringify(path)} must be a string` };
        contents[path] = v;
      }
      try {
        const prev = await readWorkspace(client, name, ctx?.conversationId);
        const w = await writeWorkspace(client, {
          name,
          owner: ctx?.owner ?? "",
          conversationId: ctx?.conversationId,
          files: contents,
          basedOn: prev?.id,
        });
        return {
          workspace: name,
          treeDigest: w.treeDigest,
          files: w.files.map((f) => f.path),
          unchanged: w.deduped,
        };
      } catch (e) {
        // A rejected path is the model's to fix, and the message names which one and why.
        return { error: (e as Error).message };
      }
    },
  };
}

export const WORKSPACE_SCHEMAS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "save_workspace",
      description:
        "Store CODE as a named workspace, then run it with run_code's `workspace` argument. This is " +
        "where every program goes, whether it is one file or twenty: a workspace can be run, keeps " +
        "each version, and is what a verdict attaches to, so there is no case where a program is " +
        "better off as a loose artifact. Use it for a module and the script that imports it, code " +
        "plus a fixture, a single script the user will keep, anything you expect to fix and re-run. " +
        "Paths are relative (src/main.ts, lib/util.ts); absolute paths, '..', and '.git' are " +
        "refused. Saving the same name again replaces the tree and keeps the old version addressable, " +
        "so iterating means saving the whole tree again with your fix, not patching in place. " +
        "Returns {workspace, treeDigest, files, unchanged}; `unchanged: true` means the tree was " +
        "byte-identical to what was already there and nothing was written. The ONE thing that does " +
        "not belong here is a throwaway calculation whose answer is the output rather than the " +
        "program: pass that to run_code as `code` and keep nothing.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "A short name for this project, reused to update it." },
          files: {
            type: "object",
            description: "Path -> file contents. Relative paths only, e.g. {\"src/main.ts\": \"...\"}.",
          },
        },
        required: ["name", "files"],
      },
    },
  },
];
