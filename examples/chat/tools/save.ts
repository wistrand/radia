// `save_content`: persist something the assistant wrote as an artifact.
//
// The counterpart to a code runner's `save_as`, which only covers bytes a PROGRAM produced. Content
// the model composed directly (an SVG it drew in prose, a config it drafted, a summary worth
// keeping) has no other route out of the conversation, and telling it to re-emit the same text
// inside a `run_javascript` literal costs the identical tokens and lands in the thread identically. So
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
import { editWorkspace, readWorkspace, shareWorkspace, summarizeWorkspaces, writeWorkspace } from "../../../extensions/ts/workspace.ts";
import type { WorkspaceEdit } from "../../../extensions/ts/workspace.ts";

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
        "SVG, a report) and whenever they ask for a link. For a multi-file SITE use share_workspace " +
        "instead: this opens exactly one artifact, so a page needing a separate stylesheet or " +
        "script would arrive without them. The artifact id you get back from " +
        "save_content or a code runner is how you REFER to an artifact, not how anyone opens one: that " +
        "URL needs an Authorization header, which a browser cannot attach to a typed address or " +
        "an <img src>, so quoting it hands the user a 401. Returns {url, expiresAt}. Give the user " +
        "the url exactly as returned and say it expires; never edit it, and never construct such a " +
        "URL yourself, because the authorization in it can only be minted here. It is short-lived " +
        "and covers that one artifact. You can only share an artifact you are allowed to read, so " +
        "a failure here means the artifact is not yours, not that you asked wrongly.",
      parameters: {
        type: "object",
        properties: {
          artifact_id: { type: "string", description: "The artifactId returned by save_content, a code runner with save_as, or generate_image." },
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
        "attach to it, while an artifact is only bytes. Do not print your content through a code runner " +
        "(run_javascript, run_python) to store it either; that sends the same text twice and stores what you would have passed " +
        "here. Pass the exact content and a " +
        "filename; the media type comes from the extension unless media_type overrides it. For " +
        "binary formats, pass base64 and set encoding:\"base64\". Returns {artifactId, mediaType, " +
        "size}. To give the user something they can actually open, pass that artifactId to " +
        "share_artifact; the id alone is a reference, not a link. Only when the bytes must be " +
        "COMPUTED (a program derives them from data you do not already have in hand) use a code runner " +
        "(run_javascript, run_python) with save_as instead.",
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
 * `save_workspace`: store a multi-file tree the assistant wrote, so a code runner can run against it.
 *
 * The counterpart to `save_content` for something that is not one file. A program with an import,
 * a fixture and a test is three files and one relationship, and squeezing it into a single `code`
 * string loses the relationship, the paths, and any chance of changing one file at a time.
 *
 * Written as the WORKER, like `save_content`, but stamped with the SESSION's owner so the tree
 * belongs to whoever asked for it and a scoped grant can bind it.
 */
/** `cat -n` numbering: right-aligned in six columns, tab, then the line. The format every tool that
 *  prints line numbers uses, so a model reads it without being told what it is. */
function numbered(text: string): string {
  const lines = text.split("\n");
  const last = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  return lines.slice(0, last).map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join("\n") +
    (last < lines.length ? "\n" : "");
}

/** How many paths a listing shows per workspace before it just reports the remainder. */
const PATHS_SHOWN = 25;
/** Same cap `read_file` uses: a tool result goes into a context window. */
const MAX_WORKSPACE_READ = 64 * 1024;

/**
 * A note carried BY THE RESULT when a tree looks like a site.
 *
 * A tool description is only attended to once the model is already considering that tool, and a
 * model holding a freshly split three-file page was not: it reasoned, correctly for the world of a
 * week ago, that "artifact URLs are opaque hashes so `href=\"styles.css\"` cannot resolve" and told
 * the user it could not hand over a link — while `share_workspace` sat in its tool list, unused.
 *
 * So the affordance travels with the thing it applies to, at the moment it applies. Same move as
 * `forked` and `incomplete`: the answer says what the caller can do next rather than relying on
 * recall.
 */
function siteHint(paths: string[]): { site?: true; note?: string } {
  if (!paths.includes("index.html")) return {};
  return {
    site: true,
    note: "this tree has an index.html, so it is a browsable site: share_workspace gives one URL " +
      "where relative links between these files resolve. share_artifact opens a single file and " +
      "would leave the others unreachable.",
  };
}

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
          // Carried forward when this save does not restate it: a wholesale replace should not
          // silently drop how the project is run.
          ...(typeof a.entrypoint === "string" && a.entrypoint.trim()
            ? { entrypoint: a.entrypoint.trim() }
            : prev?.entrypoint && prev.entrypoint in contents
            ? { entrypoint: prev.entrypoint }
            : {}),
          basedOn: prev?.id,
        });
        const paths = w.files.map((f) => f.path);
        return {
          workspace: name,
          treeDigest: w.treeDigest,
          files: paths,
          unchanged: w.deduped,
          ...(w.entrypoint ? { entrypoint: w.entrypoint } : {}),
          ...siteHint(paths),
          // A fork is REPORTED, never silently resolved. Two writers on one base both succeed and
          // both versions survive; saying so is the difference between divergence and one of them
          // quietly being somewhere else.
          ...(w.forked ? { forked: true, note: "another version already superseded the one this was based on; both now exist as separate heads" } : {}),
        };
      } catch (e) {
        // A rejected path is the model's to fix, and the message names which one and why.
        return { error: (e as Error).message };
      }
    },

    // The counterpart `save_workspace` shipped without, and the gap had a cost: an assistant that
    // can only WRITE trees cannot resume one. It re-saved from scratch each time, because asking
    // "what did I already build" had no answer — the same discovery-not-hardcode rule that governs
    // tools and models, failing in the direction that spends tokens.
    //
    // EVERYTHING THE SESSION MAY READ, marked by conversation — not this conversation only.
    //
    // Conversation scoping looked like "relevance" and behaved like a contradiction. In a live
    // session `space_count {kind: workspace}` answered 8 and `list_workspaces` answered none, both
    // correctly, because the session's GRANT is owner-scoped while this tool was not. The model
    // could not reconcile the two and spent eight tool rounds trying, ending with no answer.
    //
    // The narrowing was never doing security work either: the query is bounded by the grant, so a
    // session sees its own trees and no one else's whatever this passes. Scoping it twice only hid
    // rows from the caller most likely to need them.
    // READING a tree, which is what was missing and what the absence cost. Faced with "show
    // hello.txt" and no way to read a workspace file, the model reconstructed the text from its
    // context, stored the reconstruction with save_content, and presented it as the file — saying
    // so, but presenting it. A tool that can save, list and run trees but not read one leaves
    // fabrication as the only route to an answer.
    // SNAKE_CASE on the wire, camelCase inside. The extension file is TypeScript and every field
    // there is camelCase; the tool schema is what a MODEL fills in, and `old_string`/`new_string`/
    // `replace_all` are the names it has been trained on. Those two fields carry long verbatim text
    // copied out of a read, which is exactly where a trained habit does the work and a novel name
    // makes the model improvise. One convention per layer, three lines of mapping between them.
    edit_workspace: async (a, ctx?: ToolContext) => {
      const name = typeof a.workspace === "string" ? a.workspace.trim() : "";
      if (!name) return { error: "edit_workspace needs a `workspace`" };
      const raw = Array.isArray(a.edits) ? a.edits as Record<string, unknown>[] : [];
      const edits: WorkspaceEdit[] = raw.map((e) => ({
        path: String(e.path ?? ""),
        ...(typeof e.old_string === "string" ? { oldString: e.old_string } : {}),
        newString: String(e.new_string ?? ""),
        ...(e.replace_all === true ? { replaceAll: true } : {}),
        ...(typeof e.start_line === "number" ? { startLine: e.start_line } : {}),
        ...(typeof e.end_line === "number" ? { endLine: e.end_line } : {}),
        ...(typeof e.expect_first_line === "string" ? { expectFirstLine: e.expect_first_line } : {}),
        ...(typeof e.expect_last_line === "string" ? { expectLastLine: e.expect_last_line } : {}),
        ...(typeof e.expect_digest === "string" ? { expectDigest: e.expect_digest } : {}),
      }));
      const add = a.add && typeof a.add === "object" && !Array.isArray(a.add)
        ? Object.fromEntries(Object.entries(a.add as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : undefined;
      const attach = a.attach && typeof a.attach === "object" && !Array.isArray(a.attach)
        ? Object.fromEntries(Object.entries(a.attach as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : undefined;
      const remove = Array.isArray(a.remove) ? (a.remove as unknown[]).map(String) : undefined;
      try {
        const entrypoint = typeof a.entrypoint === "string" && a.entrypoint.trim() ? a.entrypoint.trim() : undefined;
        const r = await editWorkspace(client, { name, conversationId: ctx?.conversationId, edits, add, attach, remove, entrypoint });
        const touched = new Set([...r.changed, ...r.added]);
        return {
          workspace: name,
          treeDigest: r.treeDigest,
          changed: r.changed,
          added: r.added,
          removed: r.removed,
          // The new digest for everything this call touched, so a follow-up range edit needs no
          // second read. Without it the cheap form costs a full re-read per iteration and stops
          // being cheap.
          digests: Object.fromEntries(r.files.filter((f) => touched.has(f.path)).map((f) => [f.path, f.digest])),
          ...siteHint(r.files.map((f) => f.path)),
          // What actually changed, numbered. Without it the caller describes the outcome from what
          // it MEANT, which is how a range edit that removed six structural tags got reported as
          // "the style block is now ZZZZZ".
          preview: r.preview,
          ...(r.forked
            ? { forked: true, note: "another version superseded the one this was based on; both exist as separate heads" }
            : {}),
        };
      } catch (e) {
        // The message lists EVERY problem, which is the point of validating the batch whole.
        return { error: (e as Error).message };
      }
    },

    // The counterpart to `share_artifact` for a whole tree. `share_artifact` opens ONE file, so a
    // page whose stylesheet is a second file could never be shown — the link rendered a document
    // with no CSS and a broken script tag.
    share_workspace: async (a, ctx?: ToolContext) => {
      const name = typeof a.workspace === "string" ? a.workspace.trim() : "";
      if (!name) return { error: "share_workspace needs a `workspace`" };
      try {
        const r = await shareWorkspace(client, name, ctx?.conversationId);
        return {
          ...r,
          ...(r.entry
            ? {}
            : {
              note: "this tree has no index.html, so the base URL will not open anything; " +
                "add one, or hand over a URL naming a specific file",
            }),
        };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },

    read_workspace: async (a, ctx?: ToolContext) => {
      const name = typeof a.workspace === "string" ? a.workspace.trim() : "";
      const path = typeof a.path === "string" ? a.path.trim() : "";
      if (!name || !path) return { error: "read_workspace needs a `workspace` and a `path`" };
      const manifest = await readWorkspace(client, name, ctx?.conversationId) ??
        await readWorkspace(client, name);
      if (!manifest) return { error: `no workspace named ${JSON.stringify(name)} that you can see` };
      const file = manifest.files.find((f) => f.path === path);
      if (!file) {
        return {
          error: `no file ${JSON.stringify(path)} in workspace ${JSON.stringify(name)}`,
          paths: manifest.files.map((f) => f.path).slice(0, PATHS_SHOWN),
        };
      }
      let bytes: Uint8Array;
      try {
        bytes = await client.getArtifact(file.artifactId);
      } catch (e) {
        // The case that started all this. An erased payload must produce an EXPLANATION, because
        // the alternative the model reaches for is reconstructing the content from memory.
        const gone = (e as { status?: number }).status === 410;
        return {
          error: gone
            ? `${JSON.stringify(path)} cannot be read: its payload was ERASED, permanently. Do not ` +
              `reconstruct it — say it was erased. To make the tree usable again, save a successor ` +
              `with save_workspace containing the other files and not this one.`
            : (e as Error).message,
          erased: gone ? true : undefined,
        };
      }
      const truncated = bytes.length > MAX_WORKSPACE_READ;
      const text = new TextDecoder().decode(truncated ? bytes.slice(0, MAX_WORKSPACE_READ) : bytes);
      return {
        workspace: name,
        path,
        size: bytes.length,
        treeDigest: manifest.treeDigest,
        // The FILE's digest, which `edit_workspace` needs as a precondition. Returned on every read
        // so an edit never has to ask for it separately.
        digest: file.digest,
        truncated,
        // NUMBERED, `cat -n` style, because a line-range edit is unusable without it and this is the
        // format models are trained to read. It costs the string-match path something: a caller will
        // paste the `NNN\t` prefix into old_string, which edit_workspace diagnoses by name rather
        // than reporting a bare "not found".
        content: numbered(text),
      };
    },

    list_workspaces: async (a, ctx?: ToolContext) => {
      const here = ctx?.conversationId;
      const r = await summarizeWorkspaces(client, {
        conversationId: a.conversation_only === true ? here : undefined,
      });
      return {
        workspaces: r.workspaces.map((w) => ({
          name: w.name,
          files: w.files,
          versions: w.versions,
          treeDigest: w.treeDigest,
          // The PATHS, not just how many. "show files in X" had no data source without them, so the
          // model answered from conversation memory — and once it was answering a question about a
          // tree from memory, answering the NEXT one (what is IN a file) from memory too was a short
          // step. Capped, because a manifest holds thousands of entries and a listing is not a place
          // to spend a context window.
          paths: w.paths.slice(0, PATHS_SHOWN),
          ...(w.paths.length > PATHS_SHOWN ? { morePaths: w.paths.length - PATHS_SHOWN } : {}),
          // The runner only materialises a tree from ITS conversation, so a listing that did not
          // say which is which would hand the model a name it cannot use and no way to know why.
          ...(here !== undefined && w.conversationId === here ? { thisConversation: true } : {}),
          // Reported, never resolved. A fork means somebody else wrote a successor to the version
          // this one was based on; both survive and neither was merged.
          ...(w.forked ? { forked: true, heads: w.heads.length } : {}),
        })),
        // A truncated list must not read as a complete one: "I have no workspace called X" and
        // "I could not see all of them" are different answers, and only one of them is safe to act
        // on by re-creating X.
        ...(r.complete ? {} : { incomplete: true, note: `stopped after ${r.scanned} records; this list may be missing workspaces` }),
      };
    },
  };
}

export const WORKSPACE_SCHEMAS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "edit_workspace",
      description:
        "Change a saved workspace IN PLACE: edit existing files, add new ones, remove old ones, in " +
        "one call that becomes one new version. READ THE FILE FIRST with read_workspace and copy " +
        "`old_string` out of what it returns \u2014 text you remember or expect is the single " +
        "commonest reason an edit fails, and the failure looks like nothing else, so do not guess. " +
        "Use this for every change to a tree that already " +
        "exists \u2014 save_workspace REPLACES the whole tree, so using it to change one line means " +
        "retyping every file, and any file you leave out is DROPPED from the tree. Two ways to say " +
        "where a change goes, and you may mix them across edits: give `old_string` and `new_string` " +
        "to replace exact text (must appear exactly once, or add surrounding lines until it does, " +
        "or pass replace_all), or give `start_line`/`end_line` with `new_string` to replace a whole " +
        "region without retyping it \u2014 far cheaper for a big block, and it needs `expect_digest` " +
        "because a line number cannot tell that the file moved, plus `expect_first_line` and (when " +
        "the range is more than one line) `expect_last_line`, quoting those two lines as you read " +
        "them. Those are not ceremony: the digest only proves the file has not changed, and quoting " +
        "the LAST line is what catches a range reaching further than you meant \u2014 which is how " +
        "one edit removed a </head>, a <body> and the start of a <script> while reporting that it " +
        "had replaced a style block. read_workspace gives you the " +
        "numbered lines and the `digest` to pass. Do NOT include the line-number prefix in " +
        "`old_string`; send the file's own text. Everything is checked before anything is written, " +
        "so a failure changes nothing and reports every problem at once \u2014 fix them all and " +
        "retry. Returns {changed, added, removed, treeDigest, digests, preview}; `preview` is a " +
        "numbered window over what actually changed \u2014 read it before describing the result, " +
        "rather than reporting what you intended. `digests` are the new " +
        "per-file digests, so a follow-up line-range edit needs no second read. `forked: true` " +
        "means someone else superseded the version this was based on: both exist, say so.",
      parameters: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "The workspace name, as list_workspaces reports it." },
          edits: {
            type: "array",
            description: "Changes to existing files. Each names ONE form: old_string, or start_line/end_line.",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "A path inside the tree, e.g. 'src/main.py'." },
                old_string: { type: "string", description: "Exact text to replace, from the file itself and WITHOUT the line-number prefix. Must be unique unless replace_all." },
                new_string: { type: "string", description: "What replaces it. Empty string deletes the text or the line range." },
                replace_all: { type: "boolean", description: "Replace every occurrence. Only when you mean all of them; the default refusal is there to stop the wrong one being edited." },
                start_line: { type: "integer", description: "First line to replace, 1-based and inclusive, as read_workspace numbers them." },
                end_line: { type: "integer", description: "Last line to replace, inclusive. Ranges in one call may not overlap." },
                expect_first_line: { type: "string", description: "The text of start_line as you read it, without the number prefix. Required with start_line." },
                expect_last_line: { type: "string", description: "The text of end_line as you read it. Required when the range covers more than one line \u2014 this is the one that catches a range reaching further than you meant." },
                expect_digest: { type: "string", description: "The file `digest` read_workspace returned. Required with start_line/end_line; optional with old_string." },
              },
              required: ["path", "new_string"],
            },
          },
          add: {
            type: "object",
            description: "New files, as path -> contents. A path that already exists is refused: edit it instead.",
          },
          attach: {
            type: "object",
            description:
              "Put an artifact that ALREADY EXISTS into the tree, as path -> artifact_id. This is " +
              "how an image you generated, a file the user uploaded, or output an earlier run " +
              "stored becomes a real file in the project: {\"cat.png\": \"01KZ78BH…\"}. Nothing is " +
              "copied and you never handle the bytes, so size does not matter and it works for " +
              "binaries you cannot read. Use this instead of referencing a shared URL from your " +
              "HTML: a share link expires within the hour and the page breaks when it does, while " +
              "an attached file is part of the tree, is served with it, and is still there next " +
              "week. A path that already exists is refused; remove it first.",
          },
          remove: { type: "array", items: { type: "string" }, description: "Paths to delete from the tree." },
          entrypoint: {
            type: "string",
            description:
              "Set or change the file this project RUNS as. Omit to keep whatever it already " +
              "declares. Must name a file the tree has after this edit.",
          },
        },
        required: ["workspace"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "share_workspace",
      description:
        "Turn a whole workspace into a URL the user can OPEN in a browser \u2014 the way to show a " +
        "multi-file page, where share_artifact can only ever open ONE file and would leave the " +
        "stylesheet and scripts unreachable. Use it whenever what you built is a site rather than a " +
        "single document: index.html plus CSS, scripts, images. The base URL serves index.html, and " +
        "relative links inside the page resolve against it, so `<link href=\"style.css\">` works. " +
        "Returns {url, expiresAt, files, treeDigest, entry}. Give the user the url exactly as " +
        "returned and say it expires. It is a SNAPSHOT of the tree as it is now: edit the workspace " +
        "and the old link keeps showing the old version, so share again after changing something. " +
        "If `entry` is null there is no index.html and the base URL opens nothing \u2014 say so " +
        "rather than handing it over. Only files IN the workspace are reachable through it. " +
        // A capability the assistant kept DENYING, because nothing served it as a tool: asked how
        // to get a tree into git it answered that Radia workspaces are not git repos and offered
        // copy-paste. They are: the history is exportable as real git objects. Nobody can put that
        // in a capability record (both are CLI verbs, client-side, with no worker behind them), so
        // it belongs in the description of the tool the question arrives at.
        "GETTING THE FILES OUT is not limited to this link: a workspace's history exports as a REAL " +
        "git repository with `radia workspace-git <name> --dir <out>`, and `radia git-serve` serves " +
        "it so the person can `git clone` it. Both are commands they run in their own terminal, not " +
        "tools you can call, so say the command rather than offering to paste file contents.",
      parameters: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "The workspace name, as list_workspaces reports it." },
        },
        required: ["workspace"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_workspace",
      description:
        "Read one file out of a saved workspace, exactly as it was stored. Lines come back NUMBERED " +
        "(`     1\u0009the line`) so you can point edit_workspace at a line range; the numbers are " +
        "added for reference and are NOT part of the file \u2014 strip them before showing the " +
        "content to anyone, and never include them in an edit's `old_string`. The reply also carries " +
        "`digest`, which a line-range edit needs. This is how you answer " +
        "\"show me X\" about anything in a tree: read_file does NOT reach workspaces, only the " +
        "sandbox directories on disk. NEVER reproduce a workspace file's contents from memory or " +
        "from earlier in this conversation, not even when you are confident and not even with a " +
        "caveat: what you write is then your reconstruction presented as the file, and the user " +
        "cannot tell the difference. If you cannot read it, say so. Returns {content, size, " +
        "treeDigest, truncated}; `truncated: true` means you got the first part only. If the reply " +
        "carries `erased: true`, the payload was permanently destroyed — report that it was erased, " +
        "do not reconstruct it, and offer to save a successor tree without that path.",
      parameters: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "The workspace name, as list_workspaces reports it." },
          path: { type: "string", description: "A path inside the tree, e.g. 'src/main.py'. list_workspaces reports the paths." },
        },
        required: ["workspace", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_workspaces",
      description:
        "What code you have already saved, newest version of each, across every conversation you " +
        "can see. Use it " +
        "BEFORE save_workspace whenever you might be continuing something rather than starting " +
        "it: the user saying \"fix the bug\" or \"add a test\" refers to a tree that already " +
        "exists, and re-creating it from memory loses every file you are not currently thinking " +
        "about. Also use it when asked what you have built, or when you need a name to pass to a " +
        "code runner's `workspace` argument and are not certain of it. Returns {workspaces:[{name, " +
        "files, versions, paths, treeDigest}]}; `paths` is what is actually in the tree, so answer " +
        "\"what files are in X\" from it rather than from memory (`morePaths` counts any beyond the " +
        "first few). Use read_workspace to see what is IN one of those files. `versions` is how " +
        "many times that tree has been saved, so " +
        "a high count is an iteration history you can still read. `forked: true` on an entry means " +
        "another version superseded the one a save was based on and both now exist: say so rather " +
        "than picking one silently. To CHANGE one of these, use edit_workspace; save_workspace " +
        "replaces a whole tree. `thisConversation: true` marks the trees a code runner can " +
        "actually take as its `workspace` argument: a runner only materialises a tree from the " +
        "conversation it is running in, so to use one from elsewhere, read its files and " +
        "save_workspace them here first, and say that is what you are doing. Pass " +
        "conversation_only:true to hide the rest. If the reply carries `incomplete: true`, a name " +
        "being absent does NOT mean it does not exist, so do not overwrite on that basis.",
      parameters: {
        type: "object",
        properties: {
          conversation_only: {
            type: "boolean",
            description: "List only this conversation's trees. Off by default, because the session can read all of its own and hiding them contradicts what the space_* tools report.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_workspace",
      description:
        "Store CODE as a NEW workspace, or replace an existing one wholesale, then run it with a " +
        "code runner's `workspace` argument (run_javascript, run_python). To CHANGE a tree that " +
        "already exists, use edit_workspace instead: this call replaces the whole tree, so any file " +
        "you do not include is dropped, and retyping unchanged files to alter one line is wasted " +
        "work you will get wrong eventually. This is " +
        "where every program goes, whether it is one file or twenty: a workspace can be run, keeps " +
        "each version, and is what a verdict attaches to, so there is no case where a program is " +
        "better off as a loose artifact. Use it for a module and the script that imports it, code " +
        "plus a fixture, a single script the user will keep, anything you expect to fix and re-run. " +
        "Paths are relative (src/main.ts, lib/util.ts); absolute paths, '..', and '.git' are " +
        "refused. Saving the same name again replaces the tree and keeps the old version addressable, " +
        "so an old version is never lost. Iterating on a tree is edit_workspace's job, not this one. " +
        "Returns {workspace, treeDigest, files, unchanged}; `unchanged: true` means the tree was " +
        "byte-identical to what was already there and nothing was written. The ONE thing that does " +
        "not belong here is a throwaway calculation whose answer is the output rather than the " +
        "program: pass that to a code runner as `code` and keep nothing. If the reply carries " +
        "`forked: true`, something else changed this workspace while you were working: both " +
        "versions exist and neither was lost, but you are no longer building on the newest one. " +
        "Say so rather than continuing silently.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "A short name for this project, reused to update it." },
          files: {
            type: "object",
            description: "Path -> file contents. Relative paths only, e.g. {\"src/main.ts\": \"...\"}.",
          },
          entrypoint: {
            type: "string",
            description:
              "The file this project RUNS as, e.g. 'src/main.ts'. Set it for anything meant to be " +
              "run rather than only read: a code runner can then execute the tree with no `code` " +
              "at all, and it is the same file an agent bound to this tree would run. Must be one " +
              "of the paths in `files`.",
          },
        },
        required: ["name", "files"],
      },
    },
  },
];
