// A multi-file working tree as records: the manifest, and nothing that runs.
//
// An EXTENSION, not runtime and not application: the runtime has no opinion about files, and a
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

import type { Cursor, RadiaClient, RadiaRecord } from "../../sdk/ts/client.ts";

/**
 * The media type a path implies, `text/plain` when unknown.
 *
 * Every file in a tree used to be stored as `application/octet-stream`, which meant NO workspace
 * file could render in a browser — not a whole site, not even one page on its own. A live session
 * only got an HTML page to display by round-tripping it through a code runner and `save_as`, which
 * derives a type from a filename. A tree that can be run and exported and not looked at was a gap in
 * the shape of the data, not in the viewer.
 *
 * A CLAIM, not a fact, exactly as it is for `save_content`: the server validates the string and does
 * not verify the bytes. That is safe because rendering is decided by the SERVER's allowlist, and the
 * scriptable types are inline only on the isolated artifact origin — so a wrong or lying type
 * changes what a download is called, never whether something executes. Duplicated from
 * `examples/chat/util.ts` rather than shared: an extension may not import an example, and the two
 * are the same table for the same reason rather than one being the other's authority.
 */
export function mediaTypeFor(path: string): string {
  const ext = path.toLowerCase().split("/").pop()?.split(".").pop() ?? "";
  return ({
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "text/javascript",
    mjs: "text/javascript",
    json: "application/json",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    ico: "image/x-icon",
    md: "text/markdown",
    csv: "text/csv",
    txt: "text/plain",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
    wasm: "application/wasm",
    woff2: "font/woff2",
  } as Record<string, string>)[ext] ?? "text/plain";
}

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
  /**
   * The file this tree is RUN as, when it is run without one being named.
   *
   * A tree that says how it is run can be executed by anything holding it, which is what lets the
   * chat exercise the same file a host would rather than a driver the model improvised. Outside the
   * digest (see `validateEntrypoint`), a default rather than an authority: a `binding` names its own
   * and wins for an agent.
   */
  entrypoint?: string;
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
 * Reject an entrypoint that is not a file this tree actually contains.
 *
 * A manifest that names a missing entry is the same class of lie as one whose digests do not match
 * its artifacts, and it fails LATER: at run time, in a jail, as "module not found" from a program
 * nobody wrote. Checked on every write path, including a write-back that deleted the file.
 *
 * NOT part of the tree digest, deliberately. The digest attests WHICH FILES, and re-pointing an
 * entry would otherwise be a new digest and therefore a new promotion. A `binding` carries its own
 * entrypoint and stays authoritative for an agent; this is the tree's own default.
 */
export function validateEntrypoint(entrypoint: string, files: { path: string }[]): void {
  validatePath(entrypoint);
  if (!files.some((f) => f.path === entrypoint)) {
    const near = files.map((f) => f.path).slice(0, 8).join(", ");
    throw new Error(`entrypoint ${JSON.stringify(entrypoint)} is not a file in this workspace (has: ${near}${files.length > 8 ? ", …" : ""})`);
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
  /**
   * path -> an artifact that ALREADY EXISTS, placed in the tree without moving its bytes.
   *
   * A workspace file is an artifact reference, so a payload produced elsewhere (an image a model
   * generated, an upload, the output of an earlier run) belongs in a tree by naming it. The
   * alternative was reading the bytes back out and writing them again, which for a 1.2 MB PNG means
   * carrying it through whatever called this, and for a sandboxed caller means it cannot be done at
   * all: the jail has no network and the artifact is not on disk.
   *
   * The classification labels of every attached artifact are unioned into the tree's, because the
   * manifest is the single parent edge a run inherits from. Attaching a tainted payload and getting
   * a clean tree would launder the label, which is the same hole as omitting a parent.
   */
  attach?: Record<string, string>;
  modes?: Record<string, "100644" | "100755">;
  ignore?: string[];
  /** The file this tree runs as. Must be one of `files` or `attach`. */
  entrypoint?: string;
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
  /** Who READS the predecessor, when that is a different credential from the one that writes.
   *  A caller under DELEGATION holds two: authoring a tree is the worker's own capability, while
   *  looking at the tree it is superseding must be bounded by the person it belongs to. Defaults to
   *  `client`, so every existing caller is unchanged. See agent_docs/plan-delegation.md. */
  reader: RadiaClient = client,
): Promise<{ id: string; treeDigest: string; files: WorkspaceFile[]; deduped: boolean; forked: boolean; entrypoint?: string }> {
  // Validate EVERY path before writing ANY bytes. A tree with one bad path must not leave half its
  // artifacts behind: the manifest is what makes them reachable, and there will be no manifest.
  const entries = Object.entries(input.files);
  const attached = Object.entries(input.attach ?? {});
  for (const [path] of entries) validatePath(path);
  for (const [path] of attached) validatePath(path);
  for (const [path] of attached) {
    if (path in input.files) {
      throw new Error(`'${path}' is given both contents and an artifact to attach; pick one`);
    }
  }

  // Bounded concurrency. Measured, a sequential write is ~1.8 ms per file, so a 6 000-file tree
  // took eleven seconds and the cost was entirely round trips rather than bytes. The bound exists
  // because an unbounded fan-out over a large tree is a self-inflicted load test.
  const files: WorkspaceFile[] = [];
  const CONCURRENCY = 16;
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = await Promise.all(entries.slice(i, i + CONCURRENCY).map(async ([path, contents]) => {
      const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
      const art = await client.putArtifact(bytes, {
        mediaType: mediaTypeFor(path),
        filename: path.split("/").pop(),
        // What a grant pattern binds, exactly as the chat's other writers stamp it.
        meta: { conversationId: input.conversationId ?? "", owner: input.owner, workspace: input.name },
        ...(input.taint?.length ? { taint: input.taint } : {}),
      });
      return { path, mode: input.modes?.[path] ?? "100644", digest: art.digest, artifactId: art.id } as WorkspaceFile;
    }));
    files.push(...batch);
  }
  // Attached artifacts: no bytes move, so this is one read per artifact to learn its content
  // address. An artifact that is not readable, or is not an artifact, fails the whole write rather
  // than landing a manifest entry that points at nothing.
  for (const [path, artifactId] of attached) {
    // Coordination plane, for the reason spelled out in `editWorkspace`: the ops plane is the
    // operator's, and this runs in workers.
    const meta = await client.artifactMeta(artifactId);
    if (!meta?.digest) {
      throw new Error(
        `no artifact ${artifactId} is readable by this principal (for '${path}'); if it exists, ` +
          `this is a missing read grant rather than a wrong id`,
      );
    }
    files.push({ path, mode: input.modes?.[path] ?? "100644", digest: meta.digest, artifactId });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (input.entrypoint) validateEntrypoint(input.entrypoint, files);
  const treeDigest = await treeDigestOf(files);

  const before = await readWorkspace(reader, input.name, input.conversationId);
  // The entrypoint is part of the comparison, and it has to be: it is deliberately OUTSIDE the tree
  // digest, so "same files, different entry" is a real change that this would otherwise dedupe into
  // doing nothing. Re-pointing a tree at another file is a version, not a no-op.
  if (before?.treeDigest === treeDigest && before.entrypoint === input.entrypoint) {
    // Identical tree: the manifest that exists already says this. Writing another would grow the
    // registry for no new information, which is the growth that makes reads expensive.
    return { id: before.id, treeDigest, files, deduped: true, forked: false, entrypoint: before.entrypoint };
  }

  const body: WorkspaceManifest = {
    name: input.name,
    owner: input.owner,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    treeDigest,
    ...(input.basedOn ? { basedOn: input.basedOn } : {}),
    ...(input.ignore?.length ? { ignore: input.ignore } : {}),
    ...(input.entrypoint ? { entrypoint: input.entrypoint } : {}),
    files,
  };
  // The tree digest is the content key. A REVIVE (writing a tree that a retirement superseded)
  // needs a key that differs from the record being revived, or the write replays the retirement:
  // the same `:after:` suffix the other registries use.
  // The entrypoint joins the key, or a re-point would collide with the record it is superseding and
  // be deduplicated by the idempotency row instead of written. Absent for a tree that declares none,
  // so keys for those are exactly what they were.
  const entry = input.entrypoint ? `:@${input.entrypoint}` : "";
  // The CONVERSATION is part of the key, because a manifest is scoped to one and two conversations
  // may hold the same tree under the same name. Without it their keys collide while their bodies
  // differ, which the space reports as `idempotency_conflict` on the second writer: a workspace
  // that simply cannot be created because somebody elsewhere created one like it.
  const scope = input.conversationId ? `:${input.conversationId}` : "";
  // …and so is the PREDECESSOR, because it lands in the body as `basedOn`. Editing a tree and then
  // editing it back returns to a digest that was written before, under a different base: same key,
  // different content, refused as `idempotency_conflict`. An identical re-save still deduplicates,
  // through the early return above rather than through this key.
  const on = input.basedOn ? `:on:${input.basedOn}` : "";
  const key = before?.retired
    ? `workspace:${input.name}${scope}:${treeDigest}${entry}${on}:after:${before.id}`
    : `workspace:${input.name}${scope}:${treeDigest}${entry}${on}`;
  const { id } = await client.put(
    {
      kind: "workspace",
      body: body as unknown as Record<string, unknown>,
      // The predecessor is a data PARENT, not only a body field. `basedOn` alone makes the chain
      // queryable; the edge makes it a graph, so `lineage` walks a project's history and a fork is
      // a shape somebody can SEE rather than a coincidence of two body values.
      // An ATTACHED artifact is a data parent of the manifest, which is not bookkeeping: the tree
      // is genuinely derived from a payload somebody else produced, so the runtime unions that
      // payload's labels into the manifest for free. Computing the union here by hand would work
      // today and drift the moment the label rules change.
      ...(input.basedOn || attached.length > 0
        ? { parentIds: [...(input.basedOn ? [input.basedOn] : []), ...attached.map(([, id]) => id)] }
        : {}),
      ...(input.taint?.length ? { taint: input.taint } : {}),
    },
    key,
  );
  // Asked AFTER the write, so the answer includes this version: one indexed query, and the honest
  // reading of "is this workspace forked" rather than "did I cause it".
  return {
    id,
    treeDigest,
    files,
    deduped: false,
    forked: await isForked(reader, input.name, input.conversationId),
    ...(input.entrypoint ? { entrypoint: input.entrypoint } : {}),
  };
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
 * There is no compare-and-swap in the space, so two writers that read the same manifest both
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
  const rows = await client.queryNewest({ kind: "workspace", match }, 500);
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
  const rows = await client.queryNewest({ kind: "workspace", match }, 1);
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
  const { all, complete } = await readAllManifests(client, maxPages);
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

/** Every `workspace` record, paged to exhaustion, with whether the answer is complete.
 *
 *  Shared so a listing and a summary read the SAME stream once. Two callers each doing their own
 *  paging is two chances to page differently, and the difference would show up as two commands
 *  disagreeing about what exists. */
async function readAllManifests(
  client: RadiaClient,
  maxPages: number,
): Promise<{ all: RadiaRecord[]; complete: boolean }> {
  const all: RadiaRecord[] = [];
  let cursor: Cursor | undefined;
  let complete = false;
  const PAGE = 500;
  for (let page = 0; page < maxPages; page++) {
    const r = await client.queryPage({ kind: "workspace" }, PAGE, cursor ? { cursor } : { dir: "desc" });
    all.push(...r.records);
    if (!r.nextCursor) {
      complete = true;
      break;
    }
    cursor = r.nextCursor;
  }
  return { all, complete };
}

/** One line per workspace: what it is now, plus the history behind it. */
export interface WorkspaceSummary {
  name: string;
  owner: string;
  conversationId?: string;
  /** The head this line describes. When `forked`, one of several, chosen as `readWorkspace` does. */
  id: string;
  treeDigest: string;
  files: number;
  /** Every path in the head, sorted. A count answers "how big"; only the paths answer "what is in
   *  it", and a caller with no way to ask that will answer it from somewhere less reliable. */
  paths: string[];
  /** Manifests written for this name, retirements included. The iteration count. */
  versions: number;
  /** Every version nothing supersedes. More than one is a fork. */
  heads: string[];
  forked: boolean;
}

/**
 * What workspaces exist, and what shape each one is in.
 *
 * The question `radia query workspace` cannot answer: a raw query returns every VERSION, so three
 * rows for one workspace read as three workspaces. The projection is the same latest-wins-minus-
 * retired rule every registry here uses, plus the fork detection `forksOf` does per name — computed
 * from the one paged read rather than a query per name, which would be N+1 round trips to say the
 * same thing.
 *
 * `complete: false` is REPORTED, never hidden. A partial list presented as a population is the most
 * repeated bug in this codebase, and a listing is exactly where it lands.
 */
export async function summarizeWorkspaces(
  client: RadiaClient,
  opts: { conversationId?: string; maxPages?: number } = {},
): Promise<{ workspaces: WorkspaceSummary[]; complete: boolean; scanned: number }> {
  const { all, complete } = await readAllManifests(client, opts.maxPages ?? 40);
  const byName = new Map<string, RadiaRecord[]>();
  for (const r of all) {
    const b = r.body as unknown as WorkspaceManifest;
    if (!b?.name) continue;
    if (opts.conversationId !== undefined && b.conversationId !== opts.conversationId) continue;
    const list = byName.get(b.name);
    if (list) list.push(r);
    else byName.set(b.name, [r]);
  }

  const workspaces: WorkspaceSummary[] = [];
  for (const [name, rows] of byName) {
    const superseded = new Set(
      rows.map((r) => (r.body as unknown as WorkspaceManifest).basedOn).filter(Boolean) as string[],
    );
    const heads = rows
      .filter((r) => !superseded.has(r.id))
      .filter((r) => !(r.body as unknown as WorkspaceManifest).retired)
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    if (heads.length === 0) continue; // withdrawn: every head carries `retired`
    const head = heads[0].body as unknown as WorkspaceManifest;
    workspaces.push({
      name,
      owner: head.owner,
      conversationId: head.conversationId,
      id: heads[0].id,
      treeDigest: head.treeDigest,
      files: head.files?.length ?? 0,
      paths: (head.files ?? []).map((f) => f.path).sort(),
      versions: rows.length,
      heads: heads.map((r) => r.id),
      forked: heads.length > 1,
    });
  }
  workspaces.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { workspaces, complete, scanned: all.length };
}

/**
 * One change to one file, addressed either by CONTENT or by POSITION.
 *
 * THE INVARIANT IS THAT EVERY EDIT CARRIES A PRECONDITION, and the two forms differ only in where it
 * comes from. `oldString` IS its own precondition: the content both addresses the edit and verifies
 * it, which is why it needs nothing else. A line range carries none — line 12 is whatever line 12
 * currently is — so a stale base would corrupt silently instead of failing, and `expectDigest` is
 * therefore REQUIRED there. That is one rule with two expressions rather than two ways to edit.
 *
 * Both exist because each is cheap where the other is not. Replacing a forty-line function by
 * content means emitting those forty lines verbatim as `oldString`, so string matching costs
 * O(size of the region) in the caller's output — the exact cost this operation exists to remove.
 * A range costs O(1) plus a digest. Conversely a one-word change by range needs a fresh numbered
 * read, where a string match needs nothing.
 */
export interface WorkspaceEdit {
  path: string;
  /** CONTENT form. Exact, and unique unless `replaceAll`. */
  oldString?: string;
  newString: string;
  /** Required when `oldString` occurs more than once. Absent, a non-unique match is a REFUSAL. */
  replaceAll?: boolean;
  /** POSITION form: 1-based, INCLUSIVE, matching every tool that prints line numbers. Requires
   *  `expectDigest` and the boundary assertions below, and ranges within one batch may not overlap. */
  startLine?: number;
  endLine?: number;
  /**
   * The lines the caller believes it is replacing, as a CONTENT check on a positional address.
   *
   * `expectDigest` proves the file has not changed. It cannot prove the range points where the
   * caller meant, and that is the failure that actually happened: a model aimed at lines 7-15
   * believing they were a `<style>` block, the digest matched because nothing had changed, and the
   * edit removed `</head>`, `<body>`, a `<canvas>` and the opening of a `<script>` as well.
   *
   * `expectLastLine` is the one that catches it. A caller knows what it is starting at; where the
   * region ENDS is what it miscounts. Required whenever the range spans more than one line, and
   * `expectFirstLine` is required always — together they cost two lines of output against the forty
   * the content form would have carried, so the cheap addressing stays cheap.
   */
  expectFirstLine?: string;
  expectLastLine?: string;
  /** The file's sha256 as the caller last saw it. Optional for the content form, REQUIRED for a
   *  range, because a range has no other way to know the file has not moved under it. */
  expectDigest?: string;
}

export interface EditInput {
  name: string;
  conversationId?: string;
  edits?: WorkspaceEdit[];
  /** New files, path -> contents. A path that already exists is a refusal, not an overwrite. */
  add?: Record<string, string | Uint8Array>;
  /** New files that ALREADY EXIST as artifacts, path -> artifact id. See `WriteInput.attach`: the
   *  bytes stay where they are, and the artifact becomes a data parent of the new manifest. */
  attach?: Record<string, string>;
  modes?: Record<string, "100644" | "100755">;
  /** Paths to drop. A path that is not there is a refusal, not a no-op. */
  remove?: string[];
  /** Set or change the file this tree runs as. Omit to keep whatever the head declared. */
  entrypoint?: string;
}

/**
 * Change a tree in place: edits, additions and removals, applied as ONE new version.
 *
 * The unit is one LOGICAL CHANGE rather than one string replacement, which is why adds and removes
 * are here instead of in a second call. Real code changes span them ("add a module and wire it into
 * main"), and splitting them would either leave "add one file to a twenty-file tree" costing a
 * whole-tree rewrite — the exact cost this exists to remove — or turn one change into two versions
 * a caller has to sequence. See agent_docs/plan-workspaces.md §10.1 for the alternatives declined.
 *
 * VALIDATE EVERYTHING, THEN WRITE ONCE. Every edit, add and remove is checked against the current
 * bytes before a single artifact is written, so all-or-nothing falls out of the ordering rather than
 * needing a mechanism, and there is no partial version to explain afterwards. Failures are reported
 * TOGETHER: a caller that learns one problem per round trip fixes one problem per round trip.
 *
 * EXACT STRINGS, never a regex, a diff or a line range. A regex is a search predicate that is code;
 * a diff puts a grammar between the caller and the file and fails partially; line ranges break under
 * the concurrent writers this design assumes. And a non-unique `oldString` is an ERROR rather than a
 * first-match, which is the safety property of the whole operation: silently editing the wrong
 * occurrence is what would make this worse than rewriting the file.
 *
 * Only touched files are re-uploaded; everything else keeps its existing artifact, so the cost of a
 * change is the size of the change. Labels need nothing explicit: the successor names its
 * predecessor as a data parent, so the tree's union is inherited (§10.0).
 */
export async function editWorkspace(
  client: RadiaClient,
  input: EditInput,
  /** Who READS, when that differs from who writes. Same split as `writeWorkspace`: under delegation
   *  authoring a tree is the worker's own capability and reading the one being edited is bounded by
   *  the caller. Covers the predecessor, its file bytes, and the fork check. Defaults to `client`. */
  reader: RadiaClient = client,
): Promise<
  {
    id: string;
    treeDigest: string;
    files: WorkspaceFile[];
    changed: string[];
    added: string[];
    removed: string[];
    /** A numbered window over what actually changed, per file. */
    preview: { path: string; text: string }[];
    forked: boolean;
  }
> {
  // EDIT WHAT YOU CAN READ. The conversation-scoped lookup first (a tree this conversation owns
  // wins over a same-named one elsewhere), then unscoped — the two-step `read_workspace` already
  // does. Seen live: the model read `nw`, was told "no workspace named nw to edit", and recovered
  // by SAVING a fresh tree over the name, discarding the content it had just read. Read and edit
  // disagreeing about what exists costs rounds and, worse, silently replaces work.
  //
  // The narrowing was never doing security work (same argument as `list_workspaces`): the query is
  // bounded by the caller's GRANT, so a scoped session sees its own trees and no one else's
  // whatever this passes, and a conversation-scoped session still cannot reach another
  // conversation's. The successor keeps `...head`'s own `conversationId`, so an edit adds a
  // version where the tree lives rather than moving it here.
  const head = await readWorkspace(reader, input.name, input.conversationId) ??
    await readWorkspace(reader, input.name);
  if (!head) throw new Error(`no workspace named ${JSON.stringify(input.name)} to edit`);

  const edits = input.edits ?? [];
  const adds = Object.entries(input.add ?? {});
  const attached = Object.entries(input.attach ?? {});
  const removes = input.remove ?? [];
  // Setting the entrypoint alone is a real change, because it is outside the tree digest: the files
  // stay identical and the manifest says something different about how they run.
  if (edits.length === 0 && adds.length === 0 && attached.length === 0 && removes.length === 0 && !input.entrypoint) {
    throw new Error("editWorkspace needs at least one of `edits`, `add`, `attach`, `remove` or `entrypoint`");
  }

  const byPath = new Map(head.files.map((f) => [f.path, f]));
  const problems: string[] = [];
  const rewritten = new Map<string, Uint8Array>();

  // ── validate ─────────────────────────────────────────────────────────────────────────────────
  // Fetch each edited file ONCE even when several edits touch it, and apply them in order so two
  // edits to one file compose instead of racing over the same original bytes.
  const editedPaths = [...new Set(edits.map((e) => e.path))];
  const current = new Map<string, string>();
  for (const path of editedPaths) {
    const file = byPath.get(path);
    if (!file) {
      problems.push(`${path}: not in this workspace`);
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await reader.getArtifact(file.artifactId);
    } catch (e) {
      const gone = (e as { status?: number }).status === 410;
      problems.push(
        gone
          ? `${path}: its payload was ERASED and cannot be edited; save a successor without this path`
          : `${path}: unreadable (${e instanceof Error ? e.message : e})`,
      );
      continue;
    }
    // Verified, not believed — the same check `materialize` makes. A manifest is an ordinary record
    // and its digests are claims; only the artifact's own digest is server-computed.
    const actual = await sha256Hex(bytes);
    if (actual !== file.digest) {
      problems.push(`${path}: the manifest claims ${file.digest.slice(0, 12)}… but the artifact hashes to ${actual.slice(0, 12)}…`);
      continue;
    }
    // A NUL means these are not text, and a string replacement over decoded binary would corrupt
    // it silently. Refuse rather than mangle.
    if (bytes.includes(0)) {
      problems.push(`${path}: not a text file (contains NUL); replace it with add/remove instead`);
      continue;
    }
    current.set(path, new TextDecoder().decode(bytes));
  }

  // RANGES LAST, AND DESCENDING. A range names a position, so applying one shifts every line below
  // it: two ranges in one batch applied top-down would leave the second pointing at whatever moved
  // into its place. Sorting descending means no edit ever moves a line an unapplied edit refers to,
  // and overlapping ranges are refused outright rather than silently resolved. Content edits run
  // first because they are position-independent, and any line numbers they shift are only consulted
  // by the ranges that follow — which is why those ranges are validated against the ORIGINAL text.
  const ordered = [...edits.entries()].sort(([, a], [, b]) => {
    const ra = a.startLine !== undefined, rb = b.startLine !== undefined;
    if (ra !== rb) return ra ? 1 : -1;
    return ra ? (b.startLine ?? 0) - (a.startLine ?? 0) : 0;
  });
  const original = new Map(current);
  const claimed = new Map<string, [number, number][]>();

  for (const [i, edit] of ordered) {
    const where = `edit ${i + 1} (${edit.path})`;
    if (!current.has(edit.path)) continue; // already reported above
    const byRange = edit.startLine !== undefined || edit.endLine !== undefined;
    const byContent = edit.oldString !== undefined;
    if (byRange === byContent) {
      problems.push(`${where}: give either oldString or startLine/endLine, not ${byContent ? "both" : "neither"}`);
      continue;
    }
    // The digest is optional for a content edit and REQUIRED for a range: content verifies itself,
    // a position cannot. Checked for both when present.
    if (byRange && !edit.expectDigest) {
      problems.push(`${where}: a line range needs expectDigest, because a position cannot tell that the file moved under it`);
      continue;
    }
    if (edit.expectDigest && edit.expectDigest !== byPath.get(edit.path)!.digest) {
      problems.push(
        `${where}: expected digest ${edit.expectDigest.slice(0, 12)}… but the file is now ` +
          `${byPath.get(edit.path)!.digest.slice(0, 12)}…; re-read it before editing`,
      );
      continue;
    }

    if (byRange) {
      // Validated against the ORIGINAL text: the numbers came from a read of that, and letting an
      // earlier content edit move them would make the range mean something the caller never saw.
      const lines = original.get(edit.path)!.split("\n");
      const hadTrailing = lines.length > 0 && lines[lines.length - 1] === "";
      const body = hadTrailing ? lines.slice(0, -1) : lines;
      const start = edit.startLine ?? 0;
      const end = edit.endLine ?? start;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        problems.push(`${where}: startLine/endLine must be whole numbers with startLine <= endLine (1-based, inclusive)`);
        continue;
      }
      if (end > body.length) {
        problems.push(`${where}: lines ${start}-${end} but the file has ${body.length}`);
        continue;
      }
      // The CONTENT check on a positional address. Compared after stripping a pasted `NNN\t`
      // prefix, because the numbers come from a numbered read and a caller will include them.
      const unnumber = (t: string) => t.replace(/^\s*\d+\t/, "");
      const boundary = (want: string | undefined, actual: string, which: string): boolean => {
        if (want === undefined) {
          problems.push(
            `${where}: a line range needs expect${which}Line — the digest proves the file has not ` +
              `changed, it cannot prove the range points where you meant`,
          );
          return false;
        }
        const wanted = unnumber(want);
        if (wanted !== actual) {
          // WHERE the quoted line actually is, when it is anywhere. Without it the message reads as
          // "your quote is wrong" and a caller re-guesses the quote; the fault is almost always the
          // RANGE. Seen live: five identical retries against a range whose end was 14 lines short,
          // each one guessing a new last line while the message already held the answer.
          const line = which === "First" ? start : end;
          const at = body.reduce<number[]>((hits, text, i) => (text === wanted && hits.length < 3 ? [...hits, i + 1] : hits), []);
          problems.push(
            `${where}: expect${which}Line does not match line ${line}. ` +
              `Expected ${JSON.stringify(wanted)}, found ${JSON.stringify(actual)}` +
              (at.length
                ? `. That line is ${at.join(" or ")}, not ${line} — correct the RANGE, not the quote`
                : `. That line is not in the file; re-read it before editing`),
          );
          return false;
        }
        return true;
      };
      if (!boundary(edit.expectFirstLine, body[start - 1], "First")) continue;
      // Only required when the range spans more than one line: for a single line the first check
      // already pinned it, and demanding the same string twice is friction with no evidence behind it.
      if (end !== start && !boundary(edit.expectLastLine, body[end - 1], "Last")) continue;

      const taken = claimed.get(edit.path) ?? [];
      if (taken.some(([s, e]) => start <= e && end >= s)) {
        problems.push(`${where}: lines ${start}-${end} overlap another edit in this batch`);
        continue;
      }
      taken.push([start, end]);
      claimed.set(edit.path, taken);
      // The replacement is spliced verbatim; a caller that wants a trailing newline includes one,
      // exactly as with the content form.
      const replacement = edit.newString === "" ? [] : edit.newString.replace(/\n$/, "").split("\n");
      const now = current.get(edit.path)!.split("\n");
      const nowBody = hadTrailing ? now.slice(0, -1) : now;
      nowBody.splice(start - 1, end - start + 1, ...replacement);
      current.set(edit.path, nowBody.join("\n") + (hadTrailing ? "\n" : ""));
      continue;
    }

    const oldString = edit.oldString!;
    if (oldString === edit.newString) {
      problems.push(`${where}: oldString and newString are identical, so this edit does nothing`);
      continue;
    }
    if (oldString === "") {
      problems.push(`${where}: oldString is empty; use \`add\` to create a file`);
      continue;
    }
    const text = current.get(edit.path)!;
    const count = text.split(oldString).length - 1;
    if (count === 0) {
      // The commonest cause once reads are numbered: the caller pasted the `NNN\t` prefix along
      // with the line. Say so, because "not found" alone sends them looking at whitespace.
      const stripped = oldString.replace(/^\s*\d+\t/gm, "");
      // NAME THE LIKELY CAUSE. "Not found" alone sent a live session hunting for a missing
      // permission: the model had guessed the text instead of reading it, got this error, decided it
      // was an access problem, and asked for a grant — which the human narrowed, breaking the read
      // access it did have. An error that does not say what to do next gets diagnosed creatively.
      // WHERE THE TEXT ACTUALLY IS, when it is anywhere. Telling a caller "read the file and copy
      // it" is useless advice to one that just did: seen live, a model read style.css, edited,
      // failed, and burned a third round before landing it. The same fix the line-range boundary
      // got — locate the near-miss and name it, so the next attempt is a correction rather than
      // another guess. Compared with runs of whitespace collapsed, since indentation and wrapping
      // are what a recalled string gets wrong while the words stay right.
      const flat = (s: string) => s.replace(/\s+/g, " ").trim();
      const wantFlat = flat(oldString);
      const near = wantFlat.length > 0 && flat(text).includes(wantFlat);
      const firstLine = flat(oldString.split("\n")[0] ?? "");
      const at = text.split("\n").reduce<number[]>(
        (hits, line, i) => (firstLine.length > 0 && flat(line).includes(firstLine) && hits.length < 3 ? [...hits, i + 1] : hits),
        [],
      );
      const hint = stripped !== oldString && text.includes(stripped)
        ? "; it matches once the line-number prefixes are removed, so send the file's own text"
        : near
        ? `. The file DOES contain this text${at.length ? ` (from line ${at.join(" or ")})` : ""}, ` +
          "differing only in whitespace or indentation. Copy those lines out of read_workspace " +
          "verbatim rather than re-typing them; this is a WHITESPACE mismatch, not a missing edit"
        : at.length
        ? `. Line ${at.join(" or ")} looks close but does not match exactly, so read the file with ` +
          "read_workspace and copy the text out of it rather than recalling it"
        : ". Whitespace and indentation are significant, so read the file with read_workspace and " +
          "copy the text out of it rather than recalling it. This is NOT a permissions problem: the " +
          "file was read successfully and does not contain that text";
      problems.push(`${where}: oldString not found${hint}`);
      continue;
    }
    if (count > 1 && !edit.replaceAll) {
      problems.push(`${where}: oldString appears ${count} times; add more surrounding context to make it unique, or pass replaceAll`);
      continue;
    }
    current.set(edit.path, edit.replaceAll ? text.split(oldString).join(edit.newString) : text.replace(oldString, edit.newString));
  }

  const removeSet = new Set(removes);
  for (const path of removes) {
    if (!byPath.has(path)) problems.push(`remove ${path}: not in this workspace`);
  }
  for (const [path] of adds) {
    try {
      validatePath(path);
    } catch (e) {
      problems.push(`add ${path}: ${(e as Error).message}`);
      continue;
    }
    // An add onto an existing path is a refusal rather than an overwrite: "create" and "replace the
    // contents of" are different intentions and the caller knows which one it meant.
    if (byPath.has(path) && !removeSet.has(path)) problems.push(`add ${path}: already exists; edit it, or remove it first`);
  }
  // Attached artifacts are resolved during validation, so an unreadable id fails the whole call
  // alongside every other problem rather than after the first artifact was already written.
  const attachedFiles = new Map<string, WorkspaceFile>();
  for (const [path, artifactId] of attached) {
    try {
      validatePath(path);
    } catch (e) {
      problems.push(`attach ${path}: ${(e as Error).message}`);
      continue;
    }
    if (path in (input.add ?? {})) {
      problems.push(`attach ${path}: also given contents by \`add\`; pick one`);
      continue;
    }
    if (byPath.has(path) && !removeSet.has(path)) {
      problems.push(`attach ${path}: already exists; remove it first`);
      continue;
    }
    // The COORDINATION plane, deliberately. The first version asked `getRecord`, which is
    // `/v0/ops/records/{id}`: operator-only, so this worked under an operator client in the tests
    // and failed for every worker that actually calls it. The reported symptom was "no artifact",
    // and a live session spent eight rounds hunting a missing record that was there all along.
    let meta;
    try {
      // The CALLER's read: attaching an artifact to a tree must not reach one they cannot see.
      meta = await reader.artifactMeta(artifactId);
    } catch (e) {
      // NAME THE LIKELY CAUSE. A refusal and an absence look identical from here, and "not found"
      // alone is what sent that session looking in the wrong place.
      const status = (e as { status?: number }).status;
      problems.push(
        `attach ${path}: cannot read artifact ${artifactId}` +
          (status === 403
            ? "; it is outside your read grant, so this is a permission problem rather than a missing record"
            : `; the space answered ${status ?? "an error"}`),
      );
      continue;
    }
    if (!meta) {
      problems.push(
        `attach ${path}: no artifact ${artifactId} is readable by this principal. If you know it ` +
          `exists, you may lack a read grant on artifacts rather than have the wrong id`,
      );
      continue;
    }
    if (!meta.digest) {
      problems.push(`attach ${path}: artifact ${artifactId} reported no digest`);
      continue;
    }
    attachedFiles.set(path, { path, mode: input.modes?.[path] ?? "100644", digest: meta.digest, artifactId });
  }

  if (problems.length > 0) {
    throw new Error(
      `editWorkspace(${JSON.stringify(input.name)}) made no changes; ${problems.length} problem` +
        `${problems.length === 1 ? "" : "s"}:\n  ${problems.join("\n  ")}`,
    );
  }

  // ── write ────────────────────────────────────────────────────────────────────────────────────
  // WHAT THE EDIT ACTUALLY DID, so the caller does not have to describe it from intent.
  //
  // The result used to carry only `changed` and a digest, deliberately: echoing content back would
  // undo the saving the whole operation exists for. That was one step too frugal. A model announced
  // "lines 8-14 are now ZZZZZ", described the outcome from what it MEANT rather than from what
  // happened, and only found on a later read that the edit had also removed `</head>`, `<body>` and
  // the opening of a `<script>`. A bounded window is a few dozen tokens and closes that gap in the
  // same call.
  //
  // Located by a common-prefix / common-suffix walk rather than by tracking where each edit landed:
  // ranges apply descending, so an edit's line number shifts as later ones are applied above it, and
  // a diff of the final text against the original needs no bookkeeping to stay correct.
  const CONTEXT = 2;
  const SPAN_CAP = 20;
  const preview: { path: string; text: string }[] = [];
  const windowFor = (before: string, after: string): string => {
    const a = before.split("\n");
    const b = after.split("\n");
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const from = Math.max(0, head - CONTEXT);
    const to = Math.min(b.length, b.length - tail + CONTEXT);
    const shown = b.slice(from, Math.min(to, from + SPAN_CAP + CONTEXT * 2));
    const clipped = to - from > shown.length;
    return shown.map((l, i) => `${String(from + i + 1).padStart(6)}\t${l}`).join("\n") +
      (clipped ? `\n  … ${to - from - shown.length} more changed lines` : "");
  };

  const changed: string[] = [];
  for (const [path, text] of current) {
    const bytes = new TextEncoder().encode(text);
    if (await sha256Hex(bytes) === byPath.get(path)!.digest) continue; // an edit that restored the original
    rewritten.set(path, bytes);
    changed.push(path);
    preview.push({ path, text: windowFor(original.get(path)!, text) });
  }
  const added: string[] = [];
  for (const [path, contents] of adds) {
    rewritten.set(path, typeof contents === "string" ? new TextEncoder().encode(contents) : contents);
    added.push(path);
  }

  const written = new Map<string, WorkspaceFile>();
  for (const [path, bytes] of rewritten) {
    const art = await client.putArtifact(bytes, {
      mediaType: mediaTypeFor(path),
      filename: path.split("/").pop(),
      meta: { conversationId: input.conversationId ?? head.conversationId ?? "", owner: head.owner, workspace: input.name },
    });
    written.set(path, {
      path,
      mode: input.modes?.[path] ?? byPath.get(path)?.mode ?? "100644",
      digest: art.digest,
      artifactId: art.id,
    });
  }

  // Untouched files keep their EXISTING artifact, which is the whole saving: the cost of a change is
  // the size of the change, not the size of the tree. An attached artifact costs the same as an
  // untouched one, because it is one.
  for (const [path, file] of attachedFiles) written.set(path, file);
  const files = head.files
    .filter((f) => !removeSet.has(f.path))
    .map((f) => written.get(f.path) ?? f)
    .concat([...written.values()].filter((f) => !byPath.has(f.path)));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const treeDigest = await treeDigestOf(files);
  // An edit may SET the entrypoint, and an edit that removes the file the tree runs as must not
  // leave a manifest pointing at nothing: `...head` would carry the stale name forward silently.
  const entrypoint = input.entrypoint ?? head.entrypoint;
  if (entrypoint) validateEntrypoint(entrypoint, files);
  const body: WorkspaceManifest = { ...head, treeDigest, basedOn: head.id, files, ...(entrypoint ? { entrypoint } : {}) };
  delete (body as { id?: string }).id;
  const { id } = await client.put(
    {
      kind: "workspace",
      body: body as unknown as Record<string, unknown>,
      // Inheritance rides this edge and nothing else: the successor carries the predecessor's label
      // union through `Space.computeTaint`. See §10.0. An attached artifact joins it as a parent,
      // so a tree that takes in a classified payload inherits its labels the same way.
      parentIds: [head.id, ...attached.map(([, id]) => id)],
    },
    `workspace:${input.name}:${treeDigest}:after:${head.id}`,
  );
  return {
    id,
    treeDigest,
    files,
    changed,
    added: [...added, ...attachedFiles.keys()],
    removed: removes,
    preview,
    // REPORTED, never refused: consistent with every other writer here. Both heads survive, and an
    // edit inherits every file it did not mention, so the caller needs to know its base moved.
    forked: await isForked(reader, input.name, input.conversationId),
  };
}

/**
 * Mint a browsable URL for one version of a tree.
 *
 * The whole implementation is "turn a manifest into a path index and hand it to the runtime", which
 * is the point: the runtime learned that a capability may carry an index, not what a workspace is.
 * Serving happens on the ISOLATED artifact origin, which exists precisely so model-written HTML
 * never renders beside the console.
 *
 * A SNAPSHOT of the version that is current when this is called, never a name that follows edits.
 * The tempting alternative — a URL that always shows the newest version — would serve content
 * authorized LATER, possibly written by somebody else, under a capability whose authorization was
 * decided at mint. Re-share after editing; the link is short-lived anyway.
 *
 * The link is short-lived and PROCESS-LOCAL (`Space.downloadCaps` is a map in memory), so it dies on
 * restart. That is a view, not storage: what makes a tree durable is the records, or
 * `radia workspace-git`, which turns one into a real git repository that outlives every process here.
 */
export async function shareWorkspace(
  client: RadiaClient,
  name: string,
  conversationId?: string,
): Promise<{ url: string; expiresAt: string; files: number; treeDigest: string; entry: string | null }> {
  const manifest = await readWorkspace(client, name, conversationId) ?? await readWorkspace(client, name);
  if (!manifest) throw new Error(`no workspace named ${JSON.stringify(name)} to share`);
  if (manifest.files.length === 0) throw new Error(`workspace ${JSON.stringify(name)} has no files to serve`);
  const r = await client.pathCapability(
    manifest.files.map((f) => ({ path: f.path, artifactId: f.artifactId })),
  );
  // `/` serves `index.html`; say whether there is one rather than handing back a URL that 404s.
  const entry = manifest.files.some((f) => f.path === "index.html") ? "index.html" : null;
  return {
    url: r.url,
    expiresAt: r.expiresAt,
    files: manifest.files.length,
    treeDigest: manifest.treeDigest,
    entry,
  };
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
  // Resolved for the escape COMPARISON below, never for the writes: the caller's write grant names
  // the path it was GIVEN (`--allow-write=<root>`), and on macOS the temp root is behind a symlink
  // (`/var/folders` -> `/private/var/folders`), so writing through the resolved form is a
  // permission error against the very grant the doc comment above asks the caller to hold.
  const realRoot = await Deno.realPath(root);
  let written = 0;
  let bytes = 0;
  for (const file of [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    validatePath(file.path);
    const target = `${root}/${file.path}`;
    const dir = target.slice(0, target.lastIndexOf("/"));
    await Deno.mkdir(dir, { recursive: true });
    // Resolve AFTER creating the directory: a symlink planted by an earlier entry resolves here,
    // and `..` that survived lexical validation would too. Compared with a trailing separator so
    // `/tmp/root-evil` cannot pass as being inside `/tmp/root`.
    const realDir = await Deno.realPath(dir);
    if (realDir !== realRoot && !realDir.startsWith(realRoot + "/")) {
      throw new Error(`workspace path ${JSON.stringify(file.path)} escapes the root via a link: ${realDir}`);
    }
    // Named, because the caller's failure message is otherwise "this artifact's content was
    // destroyed" with no indication of WHICH file, in a tree the caller may not have listed.
    let content: Uint8Array;
    try {
      content = await client.getArtifact(file.artifactId);
    } catch (e) {
      const status = (e as { status?: number }).status;
      throw new Error(
        `workspace ${JSON.stringify(manifest.name)} cannot be materialised: ${JSON.stringify(file.path)} ` +
          `(artifact ${file.artifactId}) is unreadable` +
          (status === 410
            ? `, because its payload was ERASED. That is permanent: save a successor tree without ` +
              `this path to make the workspace usable again.`
            : `: ${e instanceof Error ? e.message : e}`),
      );
    }
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

/** sha256 of bytes, lowercase hex: the same content address the runtime computes for an artifact.
 *
 *  Exported so the git projection verifies a manifest entry the SAME way materialisation does. Two
 *  implementations of "is this artifact what the manifest claims" is one implementation too many. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
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
/**
 * NO `taint` OPTION, deliberately, and the distinction is the whole classification model:
 *
 *   an explicit RAISE  — a caller asserting something the graph does not know ("this tree came off
 *     a filesystem") — is applied wherever the caller says, including every file artifact, because
 *     raising is monotone and needs no trust. That is `writeWorkspace({taint})`.
 *   INHERITANCE — a derived tree carrying what its predecessor carried — travels on the record
 *     graph and nowhere else. `commitWorkspace` writes `parentIds: [manifest.id]`, so
 *     `Space.computeTaint` unions the predecessor's labels into the successor with nothing
 *     explicit anywhere.
 *
 * A write-back is pure inheritance: it has nothing of its own to assert. Labelling the artifacts it
 * writes would be a denormalised copy of a graph fact, which is the thing `design-taint.md` argues
 * against. The parameter used to exist and its one caller passed
 * `{ taint: b.owner ? undefined : undefined }` — a dead ternary that read like a decision and was
 * mistaken for a laundering hole by two separate reviews. See agent_docs/plan-workspaces.md §10.0.
 */
export async function captureWorkspace(
  client: RadiaClient,
  manifest: WorkspaceManifest,
  root: string,
  /** Extra meta merged onto each captured file's artifact, WINNING over the defaults on a shared
   *  key. The host uses this to stamp outputs with fields from the claimed record (owner, dataset),
   *  because an output belongs to the request that asked for it, not to the agent that computed
   *  it, and a grant scoped `{owner}` must reach the bytes a worker produced for that person. */
  opts: { artifactMeta?: Record<string, string | number | boolean | null> } = {},
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
        mediaType: mediaTypeFor(rel),
        filename: entry.name,
        meta: { conversationId: manifest.conversationId ?? "", owner: manifest.owner, workspace: manifest.name, ...(opts.artifactMeta ?? {}) },
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
  /** A RAISE, never inheritance: labels the caller knows about and the graph does not (the run
   *  reached the network). Inheritance from the predecessor happens through `parentIds` below and
   *  needs nothing here. */
  opts: { taint?: string[]; parentIds?: string[] } = {},
  /** Who reads, when that is a different credential from the one that writes: the fork check below
   *  is a `workspace` query, and under delegation authoring is the worker's own capability while
   *  reading is bounded by the caller. Defaults to `client`. */
  reader: RadiaClient = client,
): Promise<{ id: string; treeDigest: string; forked: boolean } | null> {
  if (captured.unchanged) return null;
  const treeDigest = await treeDigestOf(captured.files);
  // A run that deleted the file its tree runs as: the spread below would carry the name forward and
  // the next run would fail inside a jail instead of here, where the cause is still visible.
  if (manifest.entrypoint) validateEntrypoint(manifest.entrypoint, captured.files);
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
      // The predecessor ALWAYS, plus whatever caused this version (the host passes the claimed
      // record). Lineage is how "what produced these bytes" is answered, and a version whose only
      // parent is the version before it can only answer "the one before that".
      parentIds: [manifest.id, ...(opts.parentIds ?? []).filter((p) => p !== manifest.id)],
      ...(opts.taint?.length ? { taint: opts.taint } : {}),
    },
    `workspace:${manifest.name}:${treeDigest}:after:${manifest.id}`,
  );
  return { id, treeDigest, forked: await isForked(reader, manifest.name, manifest.conversationId) };
}
