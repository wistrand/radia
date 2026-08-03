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
  /**
   * Classification labels for this tree's contents (`file`/`net`/`foreign`).
   *
   * Raised on every file's artifact AND on the manifest. The manifest is what makes one parent edge
   * enough: a run naming a 5 000-file tree cannot list 5 000 parents, so the manifest carries the
   * union and a result that names it inherits the lot. Without that, materialising a classified
   * tree and reading it back would launder the labels through the filesystem, which is the same
   * hole as omitting a parent edge on a direct put.
   */
  taint?: string[];
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
): Promise<{ id: string; treeDigest: string; files: WorkspaceFile[]; deduped: boolean; forked: boolean }> {
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
        ...(input.taint?.length ? { taint: input.taint } : {}),
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
    return { id: before.id, treeDigest, files, deduped: true, forked: false };
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
  const { id } = await client.put(
    {
      kind: "workspace",
      body: body as unknown as Record<string, unknown>,
      // The predecessor is a data PARENT, not only a body field. `basedOn` alone makes the chain
      // queryable; the edge makes it a graph, so `lineage` walks a project's history and a fork is
      // a shape somebody can SEE rather than a coincidence of two body values.
      ...(input.basedOn ? { parentIds: [input.basedOn] } : {}),
      ...(input.taint?.length ? { taint: input.taint } : {}),
    },
    key,
  );
  // Asked AFTER the write, so the answer includes this version: one indexed query, and the honest
  // reading of "is this workspace forked" rather than "did I cause it".
  return { id, treeDigest, files, deduped: false, forked: await isForked(client, input.name, input.conversationId) };
}

/**
 * Is this workspace forked right now: does it have more than one head?
 *
 * The first version of this asked a narrower question — "did the manifest I am superseding already
 * have a successor" — which detects CREATING a fork and misses being ON one. Building on head A
 * while head B exists is the case a caller has to be told about, and it is the common one: the
 * writer that lost the race then keeps working, unaware, on a version nobody else can see.
 */
async function isForked(client: RadiaClient, name: string, conversationId?: string): Promise<boolean> {
  return (await forksOf(client, name, conversationId)).forked;
}

/**
 * The HEADS of a workspace: versions nothing supersedes. More than one means a fork.
 *
 * There is no compare-and-swap in the substrate, so two writers that read the same manifest both
 * succeed and latest-wins picks one. That is not data loss — the other version is still a record,
 * still addressable, and its whole history is intact, which is a permanent reflog rather than a
 * force-push. What was missing is DETECTION: without it the losing writer's work is merely somewhere
 * else, and nobody is told. Git's answer to concurrency is not CAS either; it is fork detection
 * plus explicit reconciliation, and this is the first half. There is no merge.
 */
export async function forksOf(
  client: RadiaClient,
  name: string,
  conversationId?: string,
): Promise<{ heads: (WorkspaceManifest & { id: string })[]; forked: boolean; versions: number }> {
  const match: Record<string, unknown> = { name };
  if (conversationId !== undefined) match.conversationId = conversationId;
  const rows = await client.query({ kind: "workspace", match }, 500, { dir: "desc" });
  const superseded = new Set(
    rows.map((r) => (r.body as unknown as WorkspaceManifest).basedOn).filter(Boolean) as string[],
  );
  const heads = rows
    .filter((r) => !superseded.has(r.id))
    .filter((r) => !(r.body as unknown as WorkspaceManifest).retired)
    .map((r) => ({ id: r.id, ...(r.body as unknown as WorkspaceManifest) }));
  return { heads, forked: heads.length > 1, versions: rows.length };
}

/** The current manifest for a name, or null. Exact and bounded: newest-first, one row.
 *
 *  When a name is FORKED this returns the highest id among the heads, which is a choice and not an
 *  answer: use `forksOf` when it matters which one, since the loser's work is not gone, only
 *  elsewhere. */
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

/**
 * Write a tree into a directory, so a sandbox can read it.
 *
 * This is `git checkout`, and it is the DANGEROUS direction, which is easy to miss because it looks
 * like the safe one. Execution runs untrusted code inside a jail; materialisation runs the TRUSTED
 * worker over model-influenced paths, outside any jail, creating files. Every entry is therefore
 * re-validated here even though `writeWorkspace` already refused an unsafe path: a manifest may have
 * been written by an older build, or by something else entirely, and this is the last check before
 * a path becomes a filesystem operation.
 *
 * Two guards, and neither is redundant:
 *
 *   - `validatePath` on every entry, which is the lexical check (traversal, absolute, `.git`,
 *     trailing dot or space, Windows separators).
 *   - A REALPATH containment check on the directory each file lands in. Lexical validation cannot
 *     see a symlink, and a symlink is how checkout has historically been escaped: an earlier entry
 *     creates one, a later entry writes through it. Resolving the parent and requiring it to stay
 *     under the root closes that, and it is why files are written in sorted order (deterministic,
 *     so a failure reproduces) rather than concurrently.
 *
 * Read-only by intent: nothing here writes back, and the caller is expected to hand the sandbox
 * `--allow-read=<root>` and nothing else.
 */
export async function materialize(
  client: RadiaClient,
  manifest: WorkspaceManifest,
  root: string,
): Promise<{ root: string; written: number; bytes: number; treeDigest: string }> {
  const realRoot = await Deno.realPath(root);
  let written = 0;
  let bytes = 0;
  for (const file of [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    validatePath(file.path);
    const target = `${realRoot}/${file.path}`;
    const dir = target.slice(0, target.lastIndexOf("/"));
    await Deno.mkdir(dir, { recursive: true });
    // Resolve AFTER creating the directory: a symlink planted by an earlier entry resolves here,
    // and `..` that survived lexical validation would too. Compared with a trailing separator so
    // `/tmp/root-evil` cannot pass as being inside `/tmp/root`.
    const realDir = await Deno.realPath(dir);
    if (realDir !== realRoot && !realDir.startsWith(realRoot + "/")) {
      throw new Error(`workspace path ${JSON.stringify(file.path)} escapes the root via a link: ${realDir}`);
    }
    const content = await client.getArtifact(file.artifactId);
    // VERIFY, because a manifest is an ordinary record and its digests are whatever the writer
    // said. An artifact's digest is server-computed and cannot be forged; a manifest ENTRY claiming
    // that digest for those bytes can be. Hashing what we just fetched costs nothing (the bytes are
    // in hand) and is what turns `treeDigest` from a claim into something worth attesting to.
    const actual = await sha256Hex(content);
    if (actual !== file.digest) {
      throw new Error(
        `workspace ${JSON.stringify(manifest.name)} entry ${JSON.stringify(file.path)} claims digest ` +
          `${file.digest.slice(0, 16)}… but its artifact hashes to ${actual.slice(0, 16)}…`,
      );
    }
    await Deno.writeFile(target, content, { mode: file.mode === "100755" ? 0o755 : 0o644 });
    written++;
    bytes += content.byteLength;
  }
  // …and the TREE digest, recomputed from the entries rather than believed. A manifest whose
  // `treeDigest` does not describe its own file list is not something a verdict may attach to.
  const recomputed = await treeDigestOf(manifest.files);
  if (recomputed !== manifest.treeDigest) {
    throw new Error(
      `workspace ${JSON.stringify(manifest.name)} claims treeDigest ${manifest.treeDigest} but its ` +
        `files hash to ${recomputed}`,
    );
  }
  return { root: realRoot, written, bytes, treeDigest: recomputed };
}

/** sha256 of bytes, lowercase hex: the same content address the runtime computes for an artifact. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Does this path fall under an ignore entry? Exact match, or anything under a directory prefix. */
function ignored(path: string, ignore: string[] | undefined): boolean {
  if (!ignore?.length) return false;
  return ignore.some((i) => path === i || path.startsWith(i.endsWith("/") ? i : i + "/"));
}

/** Bounds on what a run may hand back. A program that fills a disk is a trivial denial of service,
 *  and "whatever it produced" is not a size anyone chose. */
export const CAPTURE_LIMITS = { maxFiles: 2_000, maxBytes: 32 * 1024 * 1024 };

/**
 * Read a materialised tree back and store what CHANGED.
 *
 * Hash before, hash after, store the difference: the same operation `git status` performs, and the
 * reason the manifest borrows git's model. An unchanged file costs nothing (its artifact is already
 * there and blobs dedupe by digest), so the cost of an attempt is what it edited.
 *
 * Three rules that are safety rather than bookkeeping:
 *
 *   - SYMLINKS ARE SKIPPED, never followed. A program can create one pointing anywhere, and
 *     following it would capture a file from outside the tree into a record. This is the mirror of
 *     the containment check materialising does, on the way back.
 *   - Ignored paths are dropped, so build output does not become a version.
 *   - A count and a byte budget, both refused rather than truncated: a partial capture presented as
 *     a tree is the bounded-read-as-population bug wearing a filesystem.
 */
export async function captureWorkspace(
  client: RadiaClient,
  manifest: WorkspaceManifest,
  root: string,
  opts: { taint?: string[] } = {},
): Promise<{ files: WorkspaceFile[]; changed: string[]; removed: string[]; unchanged: boolean }> {
  const before = new Map(manifest.files.map((f) => [f.path, f]));
  const found: WorkspaceFile[] = [];
  const changed: string[] = [];
  let count = 0;
  let bytes = 0;

  const walk = async (dir: string, prefix: string): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymlink) continue; // never followed: it can point outside the tree
      if (ignored(rel, manifest.ignore)) continue;
      if (entry.isDirectory) {
        await walk(`${dir}/${entry.name}`, rel);
        continue;
      }
      if (!entry.isFile) continue;
      if (++count > CAPTURE_LIMITS.maxFiles) {
        throw new Error(`workspace produced more than ${CAPTURE_LIMITS.maxFiles} files; refusing to capture`);
      }
      // The path came from the FILESYSTEM this time, not from a manifest, but it is about to become
      // a manifest entry, so it faces the same rules.
      validatePath(rel);
      const content = await Deno.readFile(`${dir}/${entry.name}`);
      bytes += content.byteLength;
      if (bytes > CAPTURE_LIMITS.maxBytes) {
        throw new Error(`workspace produced more than ${CAPTURE_LIMITS.maxBytes} bytes; refusing to capture`);
      }
      const digest = await sha256Hex(content);
      const was = before.get(rel);
      const mode: "100644" | "100755" = (Deno.build.os !== "windows" &&
          ((await Deno.stat(`${dir}/${entry.name}`)).mode ?? 0) & 0o111)
        ? "100755"
        : "100644";
      if (was && was.digest === digest && was.mode === mode) {
        found.push(was); // untouched: reuse the artifact that already holds these bytes
        continue;
      }
      const art = await client.putArtifact(content, {
        mediaType: "application/octet-stream",
        filename: entry.name,
        meta: { conversationId: manifest.conversationId ?? "", owner: manifest.owner, workspace: manifest.name },
        ...(opts.taint?.length ? { taint: opts.taint } : {}),
      });
      found.push({ path: rel, mode, digest, artifactId: art.id });
      changed.push(rel);
    }
  };
  await walk(root, "");

  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const nowPaths = new Set(found.map((f) => f.path));
  const removed = manifest.files.map((f) => f.path).filter((p) => !nowPaths.has(p) && !ignored(p, manifest.ignore));
  return { files: found, changed, removed, unchanged: changed.length === 0 && removed.length === 0 };
}

/** Commit a captured tree as the next version of a workspace. Returns null when nothing changed,
 *  so an attempt that only READ does not manufacture a version. */
export async function commitWorkspace(
  client: RadiaClient,
  manifest: WorkspaceManifest & { id: string },
  captured: { files: WorkspaceFile[]; unchanged: boolean },
  opts: { taint?: string[] } = {},
): Promise<{ id: string; treeDigest: string; forked: boolean } | null> {
  if (captured.unchanged) return null;
  const treeDigest = await treeDigestOf(captured.files);
  const body: WorkspaceManifest = {
    ...manifest,
    treeDigest,
    basedOn: manifest.id,
    files: captured.files,
  };
  delete (body as { id?: string }).id;
  const { id } = await client.put(
    {
      kind: "workspace",
      body: body as unknown as Record<string, unknown>,
      parentIds: [manifest.id],
      ...(opts.taint?.length ? { taint: opts.taint } : {}),
    },
    `workspace:${manifest.name}:${treeDigest}:after:${manifest.id}`,
  );
  return { id, treeDigest, forked: await isForked(client, manifest.name, manifest.conversationId) };
}
