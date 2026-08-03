// A multi-file working tree as records: the manifest, and nothing that runs.
//
// An EXTENSION, not runtime and not application: the substrate has no opinion about files, and a
// manifest is built entirely from `put`, `query` and `putArtifact`. It imports the SDK and never
// `src/`, which is the rule that keeps the tier real (see extensions/README.md).
//
// Phase 1 of agent_docs/plan-workspaces.md. The design (why a manifest plus per-file artifacts,
// why git is a projection rather than a store, why erasure granularity decides the shape) is in
// agent_docs/design-workspaces.md. This file is the manifest half only: no materialisation, no
// sandbox, no execution. That separation is deliberate, because the model stresses worth finding
// (registry churn, body size, erasability) are all reachable without running anything.
//
// SHAPE. One `workspace` record per version, projected latest-wins by name like `procedure`, with
// each file's bytes stored as an ordinary artifact. Reading one workspace is `limit 1, dir:desc`,
// which is exact and cheap; listing every workspace is a registry read that must page to
// exhaustion, which is the expensive direction and the one that needs `readRegistry`.
//
// The manifest holds the SOURCE tree only. A vendored dependency set belongs beside it as its own
// content-addressed artifact: bodies are bounded (Phase 0's record limit caps a manifest at roughly
// six thousand entries) and, unlike a body, an artifact can be erased.

import type { RadiaClient, RadiaRecord } from "../../sdk/ts/client.ts";

/** One file in a tree. `digest` is the artifact's content address, so two workspaces sharing a file
 *  share the blob and erasing it erases the payload for both. */
export interface WorkspaceFile {
  path: string;
  /** `100644` or `100755`, git's spelling. Nothing else: a device node or a setuid bit is not a
   *  thing a model-authored tree may ask for. */
  mode: "100644" | "100755";
  digest: string;
  artifactId: string;
}

export interface WorkspaceManifest {
  name: string;
  owner: string;
  conversationId?: string;
  /** sha256 over the sorted `path\0mode\0digest` lines. The identity of the TREE, so a `check` can
   *  attach to a specific reproducible input rather than to a call id. */
  treeDigest: string;
  /** The manifest record this one supersedes, or absent for the first. Makes a fork VISIBLE: two
   *  successors naming one predecessor are a divergence in the DAG instead of a silent
   *  last-writer-wins. Detection only; there is no merge. */
  basedOn?: string;
  /** Paths a run may produce that are not part of the tree (`.gitignore` by another name). Stored
   *  so write-back has a rule, and so it travels with the tree it belongs to. */
  ignore?: string[];
  files: WorkspaceFile[];
  retired?: boolean;
}

/**
 * Reject a path that is not a plain relative location inside the tree.
 *
 * Validated at WRITE, so an unsafe path never enters a manifest, and materialisation's own check
 * (Phase 2) is defence in depth rather than the only guard. The list is git's, learned from
 * `git checkout`'s CVE history rather than rediscovered: absolute paths, `..` traversal, a leading
 * or doubled separator, a Windows drive or backslash, a trailing dot or space (which some
 * filesystems silently strip, so two distinct entries collide), and anything named `.git` in any
 * case (`.Git` folds onto it on a case-insensitive filesystem, CVE-2014-9390).
 */
export function validatePath(path: string): void {
  const bad = (why: string) => {
    throw new Error(`workspace path ${JSON.stringify(path)} is not allowed: ${why}`);
  };
  if (typeof path !== "string" || path.length === 0) bad("empty");
  if (path.length > 512) bad("longer than 512 characters");
  if (path.startsWith("/")) bad("absolute");
  if (/^[a-zA-Z]:/.test(path) || path.includes("\\")) bad("a Windows path");
  if (path.includes("\0")) bad("contains NUL");
  if (path.includes("//")) bad("an empty path segment");
  for (const seg of path.split("/")) {
    if (seg === "." || seg === "..") bad("a relative segment");
    if (seg.length === 0) bad("an empty path segment");
    // A trailing dot or space is stripped by some filesystems, so `a ` and `a` become the same
    // file while the manifest believes they are two.
    if (/[. ]$/.test(seg)) bad("a segment ending in a dot or space");
    if (seg.toLowerCase() === ".git") bad("reserved: it would collide with an exported repository");
  }
}

/**
 * The algorithm version, carried IN the digest.
 *
 * A tree digest is what a `check` attests to, so it crosses a trust boundary: two implementations
 * must agree byte for byte, and a change to how it is computed must be VISIBLE. Without a tag, a
 * digest from a later algorithm is another 64 hex characters, indistinguishable from an older one
 * and silently incomparable. This codebase has paid for that once already: `grantKey` needed a
 * "g2" prefix after a field rename, because a value-based key produced the same key for a body
 * whose shape had changed. Bump this whenever the input to the hash changes; never reuse a tag.
 */
export const TREE_DIGEST_VERSION = "t1";

/**
 * The tree's identity: `t1:<sha256 hex>` over the sorted entries.
 *
 * Sorted so the digest is a property of the TREE rather than of the order somebody happened to
 * write the files in, and NUL-separated so no path, mode or digest can forge a field boundary.
 *
 * NORMATIVE. This is a spec with an implementation, not a helper: an attestation computed by a
 * different language binding has to produce the same string. Changing any of the input, the
 * separator, the sort or the encoding is a version bump.
 */
export async function treeDigestOf(files: WorkspaceFile[]): Promise<string> {
  const lines = files
    .map((f) => `${f.path}\0${f.mode}\0${f.digest}`)
    .sort()
    .join("\n");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lines));
  const hex = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${TREE_DIGEST_VERSION}:${hex}`;
}

export interface WriteInput {
  name: string;
  owner: string;
  conversationId?: string;
  /** path -> contents. Bytes go to artifacts; only the references land in the manifest. */
  files: Record<string, string | Uint8Array>;
  modes?: Record<string, "100644" | "100755">;
  ignore?: string[];
  /** The manifest being superseded. Omit for a new workspace. */
  basedOn?: string;
}

/**
 * Store a tree: each file as an artifact, then one manifest record referencing them.
 *
 * Content-keyed on the tree digest, so re-writing an identical tree is a no-op rather than a new
 * record. That matters more here than for the other registries: a workspace churns per attempt, and
 * unbounded growth is what makes a bounded read dangerous in the first place.
 */
export async function writeWorkspace(
  client: RadiaClient,
  input: WriteInput,
): Promise<{ id: string; treeDigest: string; files: WorkspaceFile[]; deduped: boolean }> {
  // Validate EVERY path before writing ANY bytes. A tree with one bad path must not leave half its
  // artifacts behind: the manifest is what makes them reachable, and there will be no manifest.
  const entries = Object.entries(input.files);
  for (const [path] of entries) validatePath(path);

  // Bounded concurrency. Measured, a sequential write is ~1.8 ms per file, so a 6 000-file tree
  // took eleven seconds and the cost was entirely round trips rather than bytes. The bound exists
  // because an unbounded fan-out over a large tree is a self-inflicted load test.
  const files: WorkspaceFile[] = [];
  const CONCURRENCY = 16;
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = await Promise.all(entries.slice(i, i + CONCURRENCY).map(async ([path, contents]) => {
      const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
      const art = await client.putArtifact(bytes, {
        mediaType: "application/octet-stream",
        filename: path.split("/").pop(),
        // What a grant pattern binds, exactly as the chat's other writers stamp it.
        meta: { conversationId: input.conversationId ?? "", owner: input.owner, workspace: input.name },
      });
      return { path, mode: input.modes?.[path] ?? "100644", digest: art.digest, artifactId: art.id } as WorkspaceFile;
    }));
    files.push(...batch);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const treeDigest = await treeDigestOf(files);

  const before = await readWorkspace(client, input.name, input.conversationId);
  if (before?.treeDigest === treeDigest) {
    // Identical tree: the manifest that exists already says this. Writing another would grow the
    // registry for no new information, which is the growth that makes reads expensive.
    return { id: before.id, treeDigest, files, deduped: true };
  }

  const body: WorkspaceManifest = {
    name: input.name,
    owner: input.owner,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    treeDigest,
    ...(input.basedOn ? { basedOn: input.basedOn } : {}),
    ...(input.ignore?.length ? { ignore: input.ignore } : {}),
    files,
  };
  // The tree digest is the content key. A REVIVE (writing a tree that a retirement superseded)
  // needs a key that differs from the record being revived, or the write replays the retirement:
  // the same `:after:` suffix the other registries use.
  const key = before?.retired
    ? `workspace:${input.name}:${treeDigest}:after:${before.id}`
    : `workspace:${input.name}:${treeDigest}`;
  const { id } = await client.put({ kind: "workspace", body: body as unknown as Record<string, unknown> }, key);
  return { id, treeDigest, files, deduped: false };
}

/** The current manifest for a name, or null. Exact and bounded: newest-first, one row. */
export async function readWorkspace(
  client: RadiaClient,
  name: string,
  conversationId?: string,
): Promise<(WorkspaceManifest & { id: string }) | null> {
  const match: Record<string, unknown> = { name };
  if (conversationId !== undefined) match.conversationId = conversationId;
  const rows = await client.query({ kind: "workspace", match }, 1, { dir: "desc" });
  if (rows.length === 0) return null;
  return { id: rows[0].id, ...(rows[0].body as unknown as WorkspaceManifest) };
}

/** Every live workspace, and whether the answer is complete.
 *
 *  This is the expensive direction, and the one the stopping rule in CLAUDE.md is about: a bounded
 *  read here would return the OLDEST manifests and silently omit the rest. `complete: false` is
 *  reported rather than hidden, because a partial list presented as a population is the single most
 *  repeated bug in this codebase. */
export async function listWorkspaces(
  client: RadiaClient,
  maxPages = 40,
): Promise<{ workspaces: (WorkspaceManifest & { id: string })[]; complete: boolean; scanned: number }> {
  const all: RadiaRecord[] = [];
  let after: string | undefined;
  let complete = false;
  const PAGE = 500;
  for (let page = 0; page < maxPages; page++) {
    const rows = await client.query({ kind: "workspace" }, PAGE, { dir: "desc", after });
    all.push(...rows);
    if (rows.length < PAGE) {
      complete = true;
      break;
    }
    after = rows[rows.length - 1].id;
  }
  // Newest per name, retirements dropped. Compares ids rather than trusting arrival order.
  const newest = new Map<string, RadiaRecord>();
  for (const r of all) {
    const b = r.body as unknown as WorkspaceManifest;
    if (!b?.name) continue;
    const prev = newest.get(b.name);
    if (!prev || prev.id < r.id) newest.set(b.name, r);
  }
  const workspaces = [...newest.values()]
    .filter((r) => !(r.body as unknown as WorkspaceManifest).retired)
    .map((r) => ({ id: r.id, ...(r.body as unknown as WorkspaceManifest) }));
  return { workspaces, complete, scanned: all.length };
}
