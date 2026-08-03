// A workspace's version history, projected into a real git repository.
//
// EXPORT ONLY, and one way. The decision and its reasoning are in agent_docs/design-workspaces.md
// ("Git: what to borrow, what to emit, what to refuse"); the short version is that git objects must
// never become the storage of record, because `gc` deletes, rebase rewrites and refs move, while a
// record is immutable and the one erasure path is deliberate and operator-only. Import would accept
// trees whose history git can rewrite, which reopens exactly that from the outside.
//
// THE CORRESPONDENCE IS ALREADY THERE, which is why this file is small:
//
//   git blob    <-  an artifact (content-addressed, deduped by digest)
//   git tree    <-  the manifest's sorted path -> digest list
//   git commit  <-  one `workspace` manifest record: treeDigest, basedOn, created_by, created_at
//   git ref     <-  a head of the basedOn chain, the same latest-wins shape `activeByKey` has
//
// THE SHA-1 IS RECOMPUTED, NEVER STORED. Git hashes `<type> <len>\0<payload>` with SHA-1; this
// project's content address is sha256 over plaintext. Storing a git id beside a record would put
// SHA-1 into the attestation chain, and chosen-prefix SHA-1 collisions have been practical since
// 2017. So every id here is derived at export time and thrown away, and nothing downstream may
// depend on one.
//
// NORMATIVE. `gitObjectId` and the tree encoding are a spec with an implementation: an export from
// another language binding has to produce byte-identical objects, or two exports of one workspace
// are not comparable and `git log` across them is meaningless. `extensions/conformance/git.test.ts`
// holds known-answer vectors taken from the real `git` binary, and round-trips through it when it
// is installed. Changing the encoding is a compatibility break, not a refactor.
//
// NO DEPENDENCY, and none is needed: `crypto.subtle` does SHA-1 and `CompressionStream("deflate")`
// emits the zlib stream git expects. No `git` binary, no `--allow-run`, no packfile writer.
// Packfile READING is where git's real complexity lives (delta chains, negotiation) and export
// never touches it.

import { RadiaClientError } from "../../sdk/ts/client.ts";
import type { RadiaClient, RadiaRecord } from "../../sdk/ts/client.ts";
import { sha256Hex, validatePath, type WorkspaceManifest } from "./workspace.ts";

/** Git's spelling for a directory entry. Note there is no leading zero in the OBJECT, whatever
 *  `git cat-file -p` prints: `040000` is a display convention and hashing it produces a different
 *  tree. */
export const GIT_DIR_MODE = "40000";

export type GitObjectType = "blob" | "tree" | "commit";

export interface GitObject {
  id: string;
  type: GitObjectType;
  /** The object's content, WITHOUT the `<type> <len>\0` header. */
  payload: Uint8Array;
}

/**
 * The object id: SHA-1 over `<type> <len>\0<payload>`, lowercase hex.
 *
 * NORMATIVE. Matches `git hash-object` exactly; the conformance suite pins it against vectors the
 * real binary produced.
 */
export async function gitObjectId(type: GitObjectType, payload: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", framed(type, payload));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The bytes as git stores a LOOSE object: zlib of the framed object. */
export async function gitLooseBytes(type: GitObjectType, payload: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([framed(type, payload) as BlobPart]).stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function framed(type: GitObjectType, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = new TextEncoder().encode(`${type} ${payload.length}\0`);
  const out = new Uint8Array(new ArrayBuffer(header.length + payload.length));
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

/** One leaf of the tree being built: a file with its git blob id already computed. */
export interface GitBlobEntry {
  path: string;
  mode: "100644" | "100755";
  blobId: string;
}

/**
 * Build every tree object for a flat path list, innermost first, and return the root's id.
 *
 * TWO ENCODING DETAILS THAT ARE EASY TO GET WRONG AND SILENT WHEN WRONG, since a mis-encoded tree
 * is still a valid object with a different hash:
 *
 *   - **A directory sorts as if its name ended in `/`.** git compares `a/` against `a.txt`, so the
 *     order is `a.txt`, `a`, `ab.txt` (`.` is 0x2E, `/` is 0x2F, `b` is 0x62). Sorting plain names
 *     puts the directory first and produces a tree git will never agree with.
 *   - **The comparison is over BYTES, not JS string order.** UTF-16 code-unit order and UTF-8 byte
 *     order disagree above the BMP, so a path with an emoji sorts differently in the two. Encoding
 *     first is the only way to match git for non-ASCII names.
 *
 * The id is a raw 20-byte value in the entry, not the hex text.
 */
export async function buildTrees(entries: GitBlobEntry[]): Promise<{ root: string; objects: GitObject[] }> {
  interface Dir {
    files: Map<string, { mode: string; id: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };

  for (const entry of entries) {
    validatePath(entry.path); // defence in depth: a `..` here would place an object outside the tree
    const parts = entry.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      // BOTH directions, and only one of them was caught at first. `a` then `a/b` walks through a
      // name already held as a file, and without this the tree gets two entries named `a` — an
      // object git rejects on `fsck` and only there, since building and hashing it succeed.
      if (node.files.has(part)) {
        throw new Error(`workspace path ${JSON.stringify(entry.path)} is both a file and a directory`);
      }
      let next = node.dirs.get(part);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    const leaf = parts[parts.length - 1];
    if (node.dirs.has(leaf)) {
      throw new Error(`workspace path ${JSON.stringify(entry.path)} is both a file and a directory`);
    }
    node.files.set(leaf, { mode: entry.mode, id: entry.blobId });
  }

  const objects: GitObject[] = [];
  const encoder = new TextEncoder();

  async function emit(dir: Dir): Promise<string> {
    const rows: { sortKey: Uint8Array; header: Uint8Array; id: string }[] = [];
    for (const [name, file] of dir.files) {
      rows.push({
        sortKey: encoder.encode(name),
        header: encoder.encode(`${file.mode} ${name}\0`),
        id: file.id,
      });
    }
    for (const [name, child] of dir.dirs) {
      rows.push({
        sortKey: encoder.encode(`${name}/`), // the trailing slash IS the rule
        header: encoder.encode(`${GIT_DIR_MODE} ${name}\0`),
        id: await emit(child), // depth first: a parent cannot be hashed before its children
      });
    }
    rows.sort((a, b) => compareBytes(a.sortKey, b.sortKey));

    let size = 0;
    for (const row of rows) size += row.header.length + 20;
    const payload = new Uint8Array(size);
    let at = 0;
    for (const row of rows) {
      payload.set(row.header, at);
      at += row.header.length;
      payload.set(hexToBytes(row.id), at);
      at += 20;
    }
    const id = await gitObjectId("tree", payload);
    objects.push({ id, type: "tree", payload });
    return id;
  }

  return { root: await emit(root), objects };
}

export interface GitIdentity {
  name: string;
  email: string;
  /** Unix seconds. */
  when: number;
  /** `+0000` and friends. Always UTC here, because the space's clock is the only clock. */
  tz: string;
}

/**
 * A commit object.
 *
 * Deterministic by construction: every field comes from the manifest record, so exporting the same
 * workspace twice produces the same ids. That is what makes an export comparable across machines,
 * and it is the reason nothing here reads a wall clock.
 */
export async function buildCommit(input: {
  tree: string;
  parents: string[];
  author: GitIdentity;
  committer: GitIdentity;
  message: string;
}): Promise<GitObject> {
  const stamp = (i: GitIdentity) => `${safeIdentity(i.name)} <${safeIdentity(i.email)}> ${i.when} ${i.tz}`;
  const lines = [
    `tree ${input.tree}`,
    ...input.parents.map((p) => `parent ${p}`),
    `author ${stamp(input.author)}`,
    `committer ${stamp(input.committer)}`,
    "",
    input.message.replace(/\n*$/, "\n"),
  ];
  const payload = new TextEncoder().encode(lines.join("\n"));
  return { id: await gitObjectId("commit", payload), type: "commit", payload };
}

/** `<` `>` and newlines end a field in git's header grammar, so a principal carrying one would let
 *  a record forge an author line. Stripped rather than escaped: there is no escape in that grammar. */
function safeIdentity(value: string): string {
  return value.replace(/[<>\n\r]/g, "").trim() || "unknown";
}

/**
 * A principal as a git author.
 *
 * The principal IS the identity, unchanged, because a git export is an audit artifact and renaming
 * `agent:chat-exec` to something friendlier there would be the export quietly disagreeing with the
 * event log. The domain is `.invalid` (RFC 2606), so nothing ever routes mail to a synthesised
 * address.
 */
export function principalIdentity(principal: string, createdAt: string): GitIdentity {
  return {
    name: principal,
    email: `${principal.replace(/[^A-Za-z0-9._:+-]/g, "-")}@radia.invalid`,
    when: Math.floor(Date.parse(createdAt) / 1000),
    tz: "+0000",
  };
}

export interface ExportedVersion {
  /** The `workspace` record this commit was built from. */
  recordId: string;
  treeDigest: string;
  commit: string;
  tree: string;
  files: number;
  retired: boolean;
  /** Paths omitted from this commit because their payload was erased. Empty unless `partial`. */
  erased: string[];
}

export interface GitExportResult {
  dir: string;
  /** Branch name -> commit id. More than one means the workspace FORKED. */
  branches: Record<string, string>;
  /** The branch `HEAD` points at. */
  head: string;
  versions: ExportedVersion[];
  objects: number;
  bytes: number;
  /** True when at least one entry was omitted. The repository is then a SUBSET of the workspace,
   *  and every commit that lost something says so in its own trailers. */
  partial: boolean;
  /** Every omission, so a caller can report what the reader will not find. */
  erased: { version: string; path: string; artifactId: string }[];
}

export interface GitExportOptions {
  conversationId?: string;
  /** Branch for the newest head. Others get `fork-<short record id>`. */
  branch?: string;
  /** Cap on how many pages of `workspace` records to read. A partial history is refused, not
   *  truncated: see the note in `collectVersions`. */
  maxPages?: number;
  /**
   * Export what survives when a payload has been ERASED, instead of refusing.
   *
   * The default refuses because the obvious repair is a lie: a placeholder blob would make the tree
   * hash to something the manifest never described, and `git log` would present invented bytes as
   * the audited ones. Omitting the entry is not that. A tree that does not contain `secret.txt`
   * makes no claim about `secret.txt`; it is simply a different tree, and the only dishonesty left
   * is silence about the difference. So every commit that lost an entry NAMES it in its own
   * trailers, the repository's `description` carries the list, and the result reports it.
   *
   * ERASURE ONLY. A 410 means the bytes were deliberately destroyed and are not coming back. An
   * integrity failure (a manifest claiming a digest its artifact does not hash to) stays fatal
   * whatever this is set to: that is not missing content, it is content disagreeing with its claim,
   * and skipping it quietly is how a forged tree becomes an export nobody questions. A permission
   * error stays fatal for the same reason — an export you are not allowed to read in full must not
   * come back looking complete.
   */
  partial?: boolean;
}

/**
 * Export every version of one workspace as a bare git repository at `dir`.
 *
 * BARE, deliberately. A working copy needs a valid `.git/index`, which is a binary format with its
 * own versions and extensions, and getting it subtly wrong produces a repository where `git status`
 * lies. Emitting a bare repository hands that job to git, where it belongs:
 *
 *     git clone <dir> my-checkout
 *
 * WHAT AN EXPORT COSTS. Every artifact in every version is fetched and hashed twice (sha256 to
 * verify the manifest, SHA-1 to name the git object). Blobs are deduped by artifact id across
 * versions, which is where the saving is: an iteration that changed one file in a fifty-file tree
 * re-fetches one file.
 */
export async function exportWorkspaceGit(
  client: RadiaClient,
  name: string,
  dir: string,
  opts: GitExportOptions = {},
): Promise<GitExportResult> {
  const versions = await collectVersions(client, name, opts);
  if (versions.length === 0) throw new Error(`no workspace named ${JSON.stringify(name)}`);

  const objects = new Map<string, GitObject>();
  // Keyed on the artifact and holding the digest that was VERIFIED for it, not just the blob id.
  // Holding only the id let the cache launder a forgery: version 1 fetches and verifies an artifact,
  // version 2 names the SAME artifact with a different claimed digest, the cache hits, and the check
  // never runs. A per-fetch check is not a per-entry check, and it is the entries that are claims.
  const verified = new Map<string, { digest: string; blobId: string }>();
  // Asked once. The same erased artifact appears in every version that carried the file, and
  // re-requesting it per version is N round trips to be told the same 410.
  const erasedArtifacts = new Map<string, string>();
  const erased: { version: string; path: string; artifactId: string }[] = [];
  const commitByRecord = new Map<string, string>();
  const manifestByRecord = new Map<string, WorkspaceManifest>();
  const exported: ExportedVersion[] = [];

  for (const version of versions) {
    const manifest = version.body as unknown as WorkspaceManifest;
    const entries: GitBlobEntry[] = [];
    const versionErased: string[] = [];

    for (const file of manifest.files ?? []) {
      if (erasedArtifacts.has(file.artifactId)) {
        erased.push({ version: version.id, path: file.path, artifactId: file.artifactId });
        versionErased.push(file.path);
        continue;
      }
      const seen = verified.get(file.artifactId);
      if (seen) {
        if (seen.digest !== file.digest) {
          throw new Error(
            `workspace ${JSON.stringify(name)} entry ${JSON.stringify(file.path)} claims digest ` +
              `${file.digest.slice(0, 16)}… but artifact ${file.artifactId} hashes to ${seen.digest.slice(0, 16)}…`,
          );
        }
        entries.push({ path: file.path, mode: file.mode, blobId: seen.blobId });
        continue;
      }
      {
        // ERASURE IS VISIBLE HERE, and it should be. A shredded payload makes its commit
        // unreconstructable, and git's answer to a missing object is a hard clone failure. A
        // synthetic placeholder would keep the export working by making it LIE: the tree would hash
        // to something the manifest never described, and every downstream `git log` would present
        // invented content as the audited one. So this fails, and names what is gone.
        let bytes: Uint8Array;
        try {
          bytes = await client.getArtifact(file.artifactId);
        } catch (e) {
          // 410 Gone is the runtime saying "this WAS here and was destroyed" (`src/server/handlers/
          // artifacts.ts`), which is exactly and only what `partial` is allowed to skip. Anything
          // else — 403, 404, a dead connection — is a different problem wearing the same shape, and
          // treating it as an erasure would hand back a repository that looks complete.
          const gone = e instanceof RadiaClientError && e.status === 410;
          if (gone && opts.partial) {
            erasedArtifacts.set(file.artifactId, file.path);
            erased.push({ version: version.id, path: file.path, artifactId: file.artifactId });
            versionErased.push(file.path);
            continue;
          }
          throw new Error(
            `workspace ${JSON.stringify(name)} version ${version.id} cannot be exported: the payload for ` +
              `${JSON.stringify(file.path)} (artifact ${file.artifactId}) is unreadable, which is what a shredded ` +
              `artifact looks like. A git export cannot represent an erased file: ${e instanceof Error ? e.message : e}` +
              (gone ? ". Pass partial to export everything that survives, with the gap recorded in each commit." : ""),
          );
        }
        // The same verification `materialize` does, for the same reason: an artifact's digest is
        // server-computed and cannot be forged, but a MANIFEST entry claiming that digest for those
        // bytes is ordinary record content and can be.
        const actual = await sha256Hex(bytes);
        if (actual !== file.digest) {
          throw new Error(
            `workspace ${JSON.stringify(name)} entry ${JSON.stringify(file.path)} claims digest ` +
              `${file.digest.slice(0, 16)}… but its artifact hashes to ${actual.slice(0, 16)}…`,
          );
        }
        const blobId = await gitObjectId("blob", bytes);
        objects.set(blobId, { id: blobId, type: "blob", payload: bytes });
        verified.set(file.artifactId, { digest: actual, blobId });
        entries.push({ path: file.path, mode: file.mode, blobId });
      }
    }

    const { root, objects: trees } = await buildTrees(entries);
    for (const t of trees) objects.set(t.id, t);

    const parent = manifest.basedOn ? commitByRecord.get(manifest.basedOn) : undefined;
    const previousManifest = manifest.basedOn ? manifestByRecord.get(manifest.basedOn) : undefined;
    const identity = principalIdentity(
      version.runtimeMeta.createdBy,
      version.runtimeMeta.createdAt,
    );
    const commit = await buildCommit({
      tree: root,
      parents: parent ? [parent] : [],
      author: identity,
      committer: identity,
      message: commitMessage(manifest, version, entries.length, previousManifest, versionErased),
    });
    objects.set(commit.id, commit);
    commitByRecord.set(version.id, commit.id);
    manifestByRecord.set(version.id, manifest);
    exported.push({
      recordId: version.id,
      treeDigest: manifest.treeDigest,
      commit: commit.id,
      tree: root,
      files: entries.length,
      retired: manifest.retired === true,
      erased: versionErased,
    });
  }

  // A HEAD is a version nothing is based on. There is normally one; two means the workspace forked,
  // and the design's position is that a fork is detected and never merged. Dropping the loser here
  // would be this layer inventing a merge policy, so every head becomes a branch and the divergence
  // is visible in the tool the reader already has (`git log --graph --all`).
  const basedOn = new Set(
    versions.map((v) => (v.body as unknown as WorkspaceManifest).basedOn).filter((x): x is string => !!x),
  );
  const heads = versions.filter((v) => !basedOn.has(v.id));
  const newest = heads[heads.length - 1];
  const mainBranch = opts.branch ?? "main";
  const branches: Record<string, string> = {};
  for (const head of heads) {
    const branch = head.id === newest.id ? mainBranch : `fork-${head.id.slice(-8).toLowerCase()}`;
    branches[branch] = commitByRecord.get(head.id)!;
  }

  const bytes = await writeBareRepo(dir, [...objects.values()], branches, mainBranch, erased);
  return {
    dir,
    branches,
    head: mainBranch,
    versions: exported,
    objects: objects.size,
    bytes,
    partial: erased.length > 0,
    erased,
  };
}

/** The commit message: a summary line, then trailers that lead back to the records.
 *
 *  Trailers rather than prose, so `git log --format=%(trailers:key=Radia-Workspace,valueonly)` walks
 *  an export straight back into the space. An export that cannot be traced to what it came from is
 *  a copy, not an audit artifact. */
function commitMessage(
  manifest: WorkspaceManifest,
  record: RadiaRecord,
  files: number,
  previous?: WorkspaceManifest,
): string {
  const summary = manifest.retired
    ? `${manifest.name}: retired`
    : previous
    ? `${manifest.name}: ${describeChange(previous, manifest)}`
    : `${manifest.name}: ${files} file${files === 1 ? "" : "s"}`;
  const trailers = [
    `Radia-Workspace: ${record.id}`,
    `Radia-Tree-Digest: ${manifest.treeDigest}`,
    ...(manifest.basedOn ? [`Radia-Based-On: ${manifest.basedOn}`] : []),
    ...(manifest.conversationId ? [`Radia-Conversation: ${manifest.conversationId}`] : []),
    `Radia-Owner: ${manifest.owner}`,
  ];
  return `${summary}\n\n${trailers.join("\n")}\n`;
}

/** What changed against the predecessor, for the subject line.
 *
 *  `git log --oneline` is the first thing anyone runs on an export, and a column of identical
 *  "primes: 2 files" tells them nothing about a history whose whole value is the sequence. The diff
 *  is already in hand (two manifests, both digest lists), so naming it costs one pass. */
function describeChange(previous: WorkspaceManifest, current: WorkspaceManifest): string {
  const before = new Map((previous.files ?? []).map((f) => [f.path, f.digest]));
  const after = new Map((current.files ?? []).map((f) => [f.path, f.digest]));
  const added = [...after.keys()].filter((p) => !before.has(p));
  const removed = [...before.keys()].filter((p) => !after.has(p));
  const changed = [...after.entries()].filter(([p, d]) => before.has(p) && before.get(p) !== d).map(([p]) => p);
  const touched = [...changed, ...added, ...removed].sort();
  if (touched.length === 0) return "no file changed";
  const shown = touched.slice(0, 3).join(", ");
  const rest = touched.length > 3 ? `, +${touched.length - 3} more` : "";
  const verb = added.length && !changed.length && !removed.length
    ? "add"
    : removed.length && !changed.length && !added.length
    ? "remove"
    : "update";
  return `${verb} ${shown}${rest}`;
}

/**
 * Every version of a name, oldest first.
 *
 * Pages to exhaustion and REFUSES a partial answer rather than returning a plausible prefix. This is
 * the stopping rule in CLAUDE.md: a bounded read treated as a population is the most repeated bug in
 * this codebase, and here it would silently produce a repository missing its early history, which
 * reads as "that is all there was".
 */
async function collectVersions(
  client: RadiaClient,
  name: string,
  opts: GitExportOptions,
): Promise<RadiaRecord[]> {
  const match: Record<string, unknown> = { name };
  if (opts.conversationId !== undefined) match.conversationId = opts.conversationId;
  const maxPages = opts.maxPages ?? 40;
  const PAGE = 500;
  const all: RadiaRecord[] = [];
  let after: string | undefined;
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const rows = await client.query({ kind: "workspace", match }, PAGE, { dir: "desc", after });
    all.push(...rows);
    if (rows.length < PAGE) {
      complete = true;
      break;
    }
    after = rows[rows.length - 1].id;
  }
  if (!complete) {
    throw new Error(
      `workspace ${JSON.stringify(name)} has more than ${maxPages * PAGE} versions; refusing to export a ` +
        `partial history. Raise maxPages if this is real.`,
    );
  }
  // Ids are monotonic ULIDs, so ascending id IS chronological, and a parent is always built before
  // the child that names it.
  return all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Write the loose objects and the refs that make them a repository git will clone.
 *
 * `info/refs` and `objects/info/packs` are not needed locally; they are what the dumb HTTP protocol
 * serves, and writing them costs two lines and makes the directory servable as-is.
 */
async function writeBareRepo(
  dir: string,
  objects: GitObject[],
  branches: Record<string, string>,
  head: string,
): Promise<number> {
  await Deno.mkdir(`${dir}/objects/info`, { recursive: true });
  await Deno.mkdir(`${dir}/refs/heads`, { recursive: true });
  await Deno.mkdir(`${dir}/info`, { recursive: true });

  let bytes = 0;
  for (const object of objects) {
    const loose = await gitLooseBytes(object.type, object.payload);
    const sub = `${dir}/objects/${object.id.slice(0, 2)}`;
    await Deno.mkdir(sub, { recursive: true });
    await Deno.writeFile(`${sub}/${object.id.slice(2)}`, loose);
    bytes += loose.length;
  }

  for (const [branch, commit] of Object.entries(branches)) {
    await Deno.writeTextFile(`${dir}/refs/heads/${branch}`, `${commit}\n`);
  }
  await Deno.writeTextFile(`${dir}/HEAD`, `ref: refs/heads/${head}\n`);
  await Deno.writeTextFile(
    `${dir}/config`,
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n",
  );
  await Deno.writeTextFile(
    `${dir}/description`,
    "A Radia workspace, exported. Read-only: nothing here flows back.\n",
  );
  // The dumb-protocol advertisement, sorted, one `<sha>\t<ref>` line each.
  const advert = Object.entries(branches)
    .map(([branch, commit]) => `${commit}\trefs/heads/${branch}\n`)
    .sort()
    .join("");
  await Deno.writeTextFile(`${dir}/info/refs`, advert);
  await Deno.writeTextFile(`${dir}/objects/info/packs`, "");
  return bytes;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
