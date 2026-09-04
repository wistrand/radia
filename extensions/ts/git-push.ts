// `git push` into a workspace: the pushed commits become versions, fast-forward only.
//
// The export-only decision (design-workspaces.md, "Git") rests on two things and this keeps both:
// git objects are never the storage of record, and git history is never rewritten here. A push is
// accepted by taking each commit's TREE and writing it as the next version through the same
// write-back the host uses after a run (`commitWorkspace`), so the space receives artifacts hashed
// with sha256 and a manifest, and learns nothing about SHA-1. Only a linear history that descends
// from the branch's current tip is taken, which is what a protected branch enforces and why no merge
// ever arises: anything else is refused with the reason, and the person rebases and pushes again.
//
// What each commit keeps is its BYTES (`WorkspaceManifest.git`), so the re-export reproduces the
// pusher's own ids and `git fetch` afterwards is a no-op. That is the difference between a
// write-back and a round trip.
//
// NOT ATOMIC ACROSS COMMITS, and honest about it: versions are written oldest first, so a chain
// refused at its third commit has recorded the first two. The refusal says so, and because their ids
// round-trip, the advertised tip is then the second commit and the remainder fast-forwards once the
// person fixes the third. Two pushes racing on one branch both land as a FORK, which is the design's
// answer to concurrent writers everywhere (`forksOf`): detected and reported, never merged.

import type { RadiaClient } from "../../sdk/ts/client.ts";
import { type GitObject, type GitRepo, parseCommit, parseTree } from "./git.ts";
import { ZERO_ID, type RefCommand } from "./git-pack.ts";
import {
  CAPTURE_LIMITS,
  commitWorkspace,
  forksOf,
  mediaTypeFor,
  sha256Hex,
  validatePath,
  type WorkspaceFile,
  type WorkspaceManifest,
} from "./workspace.ts";

export interface PushRefResult {
  ref: string;
  ok: boolean;
  message?: string;
  /** The version records written, oldest first. Non-empty on a refusal when the chain was recorded
   *  up to the commit that failed. */
  versions: string[];
}

/** How far one push may walk. A branch that is 200 commits ahead of its workspace is a history
 *  imported wholesale, which is the case the design refuses; push it in pieces. */
const MAX_COMMITS_PER_PUSH = 200;
/** A commit object stored on a version. Records are bounded, and a commit is a few hundred bytes
 *  unless somebody pasted a file into the message. */
const MAX_COMMIT_BYTES = 64 * 1024;

/** The manifest's own fields. Anything else on a version is an app label (a compartment), and is
 *  stamped on the artifacts a push writes so the bytes land where the tree lives. */
const MANIFEST_KEYS = new Set([
  "name", "owner", "conversationId", "treeDigest", "basedOn", "ignore", "entrypoint", "files", "retired", "git", "id",
]);

/**
 * Apply a push's ref updates to a workspace, one branch at a time, each independently.
 *
 * `objects` are what the push carried (already resolved, ids recomputed); `repo` is the history the
 * advertisement described, which is what `old` in every command refers to. Errors are answers, not
 * exceptions: git prints the `ng` line beside the ref, and that is where a person is looking.
 */
export async function acceptPush(
  client: RadiaClient,
  repo: GitRepo,
  workspace: string,
  objects: Map<string, GitObject>,
  commands: RefCommand[],
  opts: { conversationId?: string } = {},
): Promise<PushRefResult[]> {
  const results: PushRefResult[] = [];
  for (const cmd of commands) {
    results.push(await acceptOne(client, repo, workspace, objects, cmd, opts));
  }
  return results;
}

async function acceptOne(
  client: RadiaClient,
  repo: GitRepo,
  workspace: string,
  objects: Map<string, GitObject>,
  cmd: RefCommand,
  opts: { conversationId?: string },
): Promise<PushRefResult> {
  const written: string[] = [];
  const refuse = (message: string): PushRefResult => ({
    ref: cmd.ref,
    ok: false,
    versions: written,
    message: written.length > 0
      ? `${message} (the ${written.length} earlier commit${written.length === 1 ? " was" : "s were"} recorded; fetch, fix, and push the rest)`
      : message,
  });
  try {
    return await accept(client, repo, workspace, objects, cmd, opts, written, refuse);
  } catch (e) {
    return refuse((e as Error).message ?? String(e));
  }
}

async function accept(
  client: RadiaClient,
  repo: GitRepo,
  workspace: string,
  objects: Map<string, GitObject>,
  cmd: RefCommand,
  opts: { conversationId?: string },
  written: string[],
  refuse: (message: string) => PushRefResult,
): Promise<PushRefResult> {
  const m = /^refs\/heads\/(.+)$/.exec(cmd.ref);
  if (!m) return refuse("only branches are accepted: a workspace has no tags");
  const branch = m[1];
  const tip = repo.branches[branch];
  if (!tip) {
    return refuse(`no branch ${branch}: a workspace's branches are its heads (${Object.keys(repo.branches).sort().join(", ")}); push to one of them`);
  }
  if (cmd.new === ZERO_ID) return refuse("a branch is a workspace head and cannot be deleted; retire the workspace instead");
  if (cmd.old !== tip) return refuse(`stale: ${branch} is at ${tip.slice(0, 12)} now; fetch and rebase, then push again`);
  if (cmd.new === cmd.old) return { ref: cmd.ref, ok: true, versions: [] };

  const lookup = (id: string) => objects.get(id) ?? repo.objects.get(id);

  // The chain from the new tip back to the current one, along first parents. A commit with two
  // parents is a merge, which the design does not accept; one with none is a history that does not
  // descend from this branch at all.
  const chain: { id: string; tree: string; stored: { raw?: string; base64?: string } }[] = [];
  for (let id = cmd.new; id !== cmd.old;) {
    if (chain.length >= MAX_COMMITS_PER_PUSH) return refuse(`more than ${MAX_COMMITS_PER_PUSH} commits ahead; push in smaller pieces`);
    const obj = lookup(id);
    if (!obj) return refuse(`commit ${id.slice(0, 12)} is neither in the push nor in this history`);
    if (obj.type !== "commit") return refuse(`${id.slice(0, 12)} is a ${obj.type}, not a commit`);
    if (obj.payload.length > MAX_COMMIT_BYTES) return refuse(`commit ${id.slice(0, 12)} is ${obj.payload.length} bytes; the ceiling is ${MAX_COMMIT_BYTES}`);
    const c = parseCommit(obj.payload);
    if (c.parents.length > 1) {
      return refuse(`${id.slice(0, 12)} is a merge commit; a workspace never merges, so rebase onto ${branch} and push a linear history`);
    }
    if (c.parents.length === 0) return refuse(`${id.slice(0, 12)} has no parent: this history does not descend from ${branch}, so it is not a fast-forward`);
    chain.push({ id, tree: c.tree, stored: storable(obj.payload, c.raw) });
    id = c.parents[0];
  }
  chain.reverse();

  // The version the tip IS, with its manifest: a head of the workspace, found by the record id the
  // export attached to that commit. Read LIVE, not from the snapshot: a version that landed since
  // the advertisement makes this a stale push however well `old` matched.
  const exported = repo.versions.find((v) => v.commit === cmd.old);
  if (!exported) return refuse(`${branch}'s tip is not one of this workspace's versions`);
  const { heads } = await forksOf(client, workspace, opts.conversationId);
  let base = heads.find((h) => h.id === exported.recordId);
  if (!base) return refuse(`version ${exported.recordId} is no longer a head of ${workspace}; fetch and rebase`);

  // App labels the base carries (a team compartment, for one) go onto every artifact this push
  // writes, as the host's write-back stamps its outputs; the manifest inherits them by the spread
  // in `commitWorkspace`.
  const labels: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(base)) {
    if (!MANIFEST_KEYS.has(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) labels[k] = v;
  }

  for (const commit of chain) {
    const tree = flattenTree(commit.tree, lookup);
    if ("refused" in tree) return refuse(tree.refused);
    // The base names the file the tree RUNS AS. A push that removed it is refused here, where the
    // cause is visible, rather than silently dropping the entrypoint or failing inside a jail later.
    if (base.entrypoint && !tree.entries.some((e) => e.path === base!.entrypoint)) {
      return refuse(`commit ${commit.id.slice(0, 12)} removes ${base.entrypoint}, the file this workspace runs as; keep it, or re-point the entrypoint first`);
    }
    const before = new Map(base.files.map((f) => [f.path, f]));
    const files: WorkspaceFile[] = [];
    let bytes = 0;
    let changed = 0;
    for (const entry of tree.entries) {
      const blob = lookup(entry.id);
      if (!blob) return refuse(`blob ${entry.id.slice(0, 12)} for ${entry.path} is missing from the push`);
      if (blob.type !== "blob") return refuse(`${entry.path} points at a ${blob.type}`);
      bytes += blob.payload.length;
      if (bytes > CAPTURE_LIMITS.maxBytes) return refuse(`the tree at ${commit.id.slice(0, 12)} exceeds ${CAPTURE_LIMITS.maxBytes} bytes`);
      const digest = await sha256Hex(blob.payload);
      const prev = before.get(entry.path);
      if (prev && prev.digest === digest) {
        // Unchanged bytes keep their artifact, which is what makes a version cost what it changed.
        files.push({ path: entry.path, mode: entry.mode, digest, artifactId: prev.artifactId });
        if (prev.mode !== entry.mode) changed++;
        continue;
      }
      const art = await client.putArtifact(blob.payload, {
        mediaType: mediaTypeFor(entry.path),
        filename: entry.path.split("/").pop(),
        meta: { ...labels, conversationId: base.conversationId ?? "", owner: base.owner, workspace: base.name },
      });
      files.push({ path: entry.path, mode: entry.mode, digest: art.digest, artifactId: art.id });
      changed++;
    }
    const removed = base.files.length - [...before.keys()].filter((p) => tree.entries.some((e) => e.path === p)).length;
    if (changed === 0 && removed === 0) {
      return refuse(`commit ${commit.id.slice(0, 12)} changes no file; a workspace version is a tree, so it has nothing to record`);
    }
    const w = await commitWorkspace(client, base, { files, unchanged: false }, { git: commit.stored });
    if (!w) return refuse(`commit ${commit.id.slice(0, 12)} changes no file`); // unreachable: `unchanged` is false
    written.push(w.id);
    base = { ...base, id: w.id, treeDigest: w.treeDigest, basedOn: base.id, files };
    delete base.git;
  }
  return { ref: cmd.ref, ok: true, versions: written };
}

/** The commit's bytes as a record can hold them: text when they are UTF-8, base64 otherwise. */
function storable(payload: Uint8Array, raw: string): { raw?: string; base64?: string } {
  const back = new TextEncoder().encode(raw);
  if (back.length === payload.length && back.every((b, i) => b === payload[i])) return { raw };
  let s = "";
  for (const b of payload) s += String.fromCharCode(b);
  return { base64: btoa(s) };
}

/** Every file under a tree, with the path rules a workspace enforces on any other write path. */
function flattenTree(
  root: string,
  lookup: (id: string) => GitObject | undefined,
): { entries: { path: string; mode: "100644" | "100755"; id: string }[] } | { refused: string } {
  const entries: { path: string; mode: "100644" | "100755"; id: string }[] = [];
  const seen = new Set<string>();
  const walk = (id: string, prefix: string, depth: number): string | undefined => {
    if (depth > 64) return "the tree nests deeper than 64 directories";
    const obj = lookup(id);
    if (!obj) return `tree ${id.slice(0, 12)} is missing from the push`;
    if (obj.type !== "tree") return `${id.slice(0, 12)} is a ${obj.type} where a tree was expected`;
    for (const e of parseTree(obj.payload)) {
      // A name is one path segment. Git never writes a separator into one, but a pack is bytes from
      // outside, and a name carrying one would alias another entry's path.
      if (e.name === "" || e.name.includes("/") || e.name === "." || e.name === "..") return `tree ${id.slice(0, 12)} holds an entry named ${JSON.stringify(e.name)}`;
      const path = prefix + e.name;
      if (e.mode === "40000") {
        const err = walk(e.id, path + "/", depth + 1);
        if (err) return err;
        continue;
      }
      if (e.mode === "120000") return `${path} is a symlink; a workspace holds files only`;
      if (e.mode === "160000") return `${path} is a submodule; a workspace holds files only`;
      if (e.mode !== "100644" && e.mode !== "100755") return `${path} has mode ${e.mode}, which a workspace does not accept`;
      try {
        validatePath(path);
      } catch (err) {
        return (err as Error).message;
      }
      if (seen.has(path)) return `${path} appears twice in the tree`;
      seen.add(path);
      entries.push({ path, mode: e.mode, id: e.id });
      if (entries.length > CAPTURE_LIMITS.maxFiles) return `more than ${CAPTURE_LIMITS.maxFiles} files`;
    }
    return undefined;
  };
  const err = walk(root, "", 0);
  if (err) return { refused: err };
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries };
}
