// The git projection's contract.
//
//   deno task test:extensions
//
// Two halves, and the split is the point.
//
// KNOWN-ANSWER VECTORS run everywhere and are the actual spec. Every id below was produced by the
// real `git` binary and pasted in; none was computed by the code under test, because a vector
// derived from the implementation tests that the implementation is self-consistent, which it always
// is. That mistake was made once already in this suite's workspace half, and the test passed while
// being worthless.
//
// A ROUND TRIP THROUGH REAL GIT runs where `git` is installed and skips where it is not, the same
// posture the bubblewrap tests take. It is the only thing that can catch an encoding this file's
// authors and its vectors are wrong about in the same way.
//
// What is NOT tested here: anything needing a running space. The exporter's record-level behaviour
// (version chains, forks as branches, erasure) lives in the suite that has a space to put records
// in; these are the pure functions that cross the trust boundary.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  buildCommit,
  buildTrees,
  exportWorkspaceGit,
  type GitBlobEntry,
  gitLooseBytes,
  gitObjectId,
} from "../ts/git.ts";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { writeWorkspace } from "../ts/workspace.ts";
import { bootSpace } from "./space.ts";
import { basicPassword, gitHandler } from "../ts/git-http.ts";

const enc = (s: string) => new TextEncoder().encode(s);

// ── the vectors, from `git hash-object` and `git write-tree` ─────────────────────────────────────
// $ printf '' | git hash-object -t blob --stdin
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
// $ printf 'hello\n' | git hash-object -t blob --stdin
const HELLO_BLOB = "ce013625030ba8dba906f756967f9e9ca394464a";
// A tree holding a.txt="A\n", a/b.txt="B\n", ab.txt="C\n", run.sh="X\n" mode 100755.
const A_BLOB = "f70f10e4db19068f79bc43844b49f3eece45c4e8"; // "A\n"
const B_BLOB = "223b7836fb19fdf64ba2d3cd6173c6a283141f78"; // "B\n"
const C_BLOB = "3cc58df83752123644fef39faab2393af643b1d2"; // "C\n"
const X_BLOB = "62d8fe9f6db631bd3a19140699101c9e281c9f9d"; // "X\n"
const SUBTREE = "45785efc36115bb31d7e861c101e58da45fbafac"; // the `a/` directory
const ROOT_TREE = "dac6469d0c479a7ee3413ec67df7bd4b9d2768c6";
// $ GIT_AUTHOR_DATE="1700000000 +0000" … git commit -m "attempt 1"
const COMMIT = "883be28faa5370e618d4348f4dd3ecd03c422604";

const SAMPLE: GitBlobEntry[] = [
  { path: "a.txt", mode: "100644", blobId: A_BLOB },
  { path: "a/b.txt", mode: "100644", blobId: B_BLOB },
  { path: "ab.txt", mode: "100644", blobId: C_BLOB },
  { path: "run.sh", mode: "100755", blobId: X_BLOB },
];

Deno.test("[git] a blob id is SHA-1 over the framed object, matching git hash-object", async () => {
  assertEquals(await gitObjectId("blob", enc("")), EMPTY_BLOB);
  assertEquals(await gitObjectId("blob", enc("hello\n")), HELLO_BLOB);
  assertEquals(await gitObjectId("blob", enc("A\n")), A_BLOB);
  // The header is part of the hash, which is the whole reason a git id is not a content address in
  // this project's sense: the same bytes hash differently as a blob and as raw content.
  const rawSha1 = [...new Uint8Array(await crypto.subtle.digest("SHA-1", enc("hello\n")))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  assert(rawSha1 !== HELLO_BLOB, "a git blob id must not be a bare SHA-1 of the content");
});

Deno.test("[git] a tree matches git's, including the sort rule a directory obeys", async () => {
  const { root, objects } = await buildTrees(SAMPLE);
  assertEquals(root, ROOT_TREE);
  assert(objects.some((o) => o.id === SUBTREE), "the nested directory is its own tree object");
  assertEquals(objects.length, 2, "one tree per directory, root included");
});

Deno.test("[git] a directory sorts as if its name ended in a slash", async () => {
  // The discriminating case, and the reason it is here: `.` (0x2E) < `/` (0x2F) < `b` (0x62), so
  // the order is a.txt, a/, ab.txt. Sorting bare names puts `a` first and yields a different hash
  // that is still a perfectly valid tree object, so nothing but a vector catches it.
  const { objects } = await buildTrees(SAMPLE);
  const rootTree = objects.find((o) => o.id === ROOT_TREE)!;
  const names = [...new TextDecoder().decode(rootTree.payload).matchAll(/(?:^|\0.{20})\d+ ([^\0]+)/gs)]
    .map((m) => m[1]);
  assertEquals(names, ["a.txt", "a", "ab.txt", "run.sh"]);
});

Deno.test("[git] a directory entry's mode has no leading zero", async () => {
  // `git cat-file -p` prints 040000 and the object contains 40000. Writing what the display shows
  // produces a tree git never agrees with, and the error is invisible without a vector.
  const { objects } = await buildTrees(SAMPLE);
  const rootTree = objects.find((o) => o.id === ROOT_TREE)!;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(rootTree.payload);
  assertStringIncludes(text, "40000 a\0");
  assert(!text.includes("040000"), "a leading zero would change the hash");
});

Deno.test("[git] tree entries carry the raw 20-byte id, not its hex text", async () => {
  const { objects } = await buildTrees([SAMPLE[0]]);
  const tree = objects[0];
  // `100644 a.txt\0` is 13 bytes; 13 + 20 = 33. Hex would make it 53.
  assertEquals(tree.payload.length, 33);
});

Deno.test("[git] a commit matches git's, byte for byte", async () => {
  const identity = { name: "Radia", email: "agent@radia.invalid", when: 1700000000, tz: "+0000" };
  const commit = await buildCommit({
    tree: ROOT_TREE,
    parents: [],
    author: identity,
    committer: identity,
    message: "attempt 1",
  });
  assertEquals(commit.id, COMMIT);
});

Deno.test("[git] a commit is deterministic, so two exports of one workspace compare", async () => {
  // Nothing here reads a wall clock; every field comes from the record. An export that varied per
  // run could not be diffed against another machine's, which is most of the point of exporting.
  const identity = { name: "agent:chat-user", email: "agent-chat-user@radia.invalid", when: 1700000000, tz: "+0000" };
  const make = () => buildCommit({ tree: ROOT_TREE, parents: [], author: identity, committer: identity, message: "x" });
  assertEquals((await make()).id, (await make()).id);
});

Deno.test("[git] a principal cannot forge an author line", async () => {
  // `<`, `>` and newline END a field in git's header grammar and it has no escape, so a principal
  // carrying one would inject a header into someone else's commit. Stripped, not escaped.
  const evil = {
    name: "a> <real@victim.example> 0 +0000\ncommitter x",
    email: "e@x.invalid",
    when: 0,
    tz: "+0000",
  };
  const commit = await buildCommit({
    tree: ROOT_TREE,
    parents: [],
    author: evil,
    committer: evil,
    message: "m",
  });
  const text = new TextDecoder().decode(commit.payload);
  assertEquals(text.split("\n").filter((l) => l.startsWith("committer ")).length, 1);
  assertEquals(text.split("\n").filter((l) => l.startsWith("author ")).length, 1);
});

Deno.test("[git] a loose object is a zlib stream, and inflates back to the framed bytes", async () => {
  const loose = await gitLooseBytes("blob", enc("hello\n"));
  // 0x78 is the zlib CMF byte; a raw deflate stream (what `deflate-raw` produces) has no header,
  // and git rejects it. The two differ by two bytes and by nothing visible.
  assertEquals(loose[0], 0x78);
  const back = new Uint8Array(
    await new Response(
      new Blob([loose as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate")),
    ).arrayBuffer(),
  );
  assertEquals(new TextDecoder().decode(back), "blob 6\0hello\n");
});

Deno.test("[git] a path that is both a file and a directory is refused", async () => {
  await assertRejects(
    () =>
      buildTrees([
        { path: "a", mode: "100644", blobId: A_BLOB },
        { path: "a/b", mode: "100644", blobId: B_BLOB },
      ]),
    Error,
    "both a file and a directory",
  );
});

Deno.test("[git] an unsafe path is refused here too, not only at write", async () => {
  // Defence in depth. A manifest is an ordinary record; if one ever carried `..`, the tree builder
  // is the last place before an object lands outside the tree it claims to describe.
  await assertRejects(
    () => buildTrees([{ path: "../escape", mode: "100644", blobId: A_BLOB }]),
    Error,
    "not allowed",
  );
});

// ── the round trip, where a real git exists ──────────────────────────────────────────────────────

async function haveGit(): Promise<boolean> {
  try {
    return (await new Deno.Command("git", { args: ["--version"], stdout: "null", stderr: "null" }).output()).success;
  } catch {
    return false;
  }
}

Deno.test("[git] real git accepts what this writes, and reads back the same tree", async () => {
  if (!await haveGit()) {
    console.log("    (skipped: no git binary)");
    return;
  }
  const dir = await Deno.makeTempDir({ prefix: "radia-git-" });
  try {
    // Hand-build the sample repository through the same primitives the exporter uses, then let git
    // be the judge. This is the only check that does not depend on the vectors above being right.
    const blobs: Record<string, string> = { "a.txt": "A\n", "a/b.txt": "B\n", "ab.txt": "C\n", "run.sh": "X\n" };
    await Deno.mkdir(`${dir}/objects/info`, { recursive: true });
    await Deno.mkdir(`${dir}/refs/heads`, { recursive: true });
    const write = async (type: "blob" | "tree" | "commit", payload: Uint8Array) => {
      const id = await gitObjectId(type, payload);
      await Deno.mkdir(`${dir}/objects/${id.slice(0, 2)}`, { recursive: true });
      await Deno.writeFile(`${dir}/objects/${id.slice(0, 2)}/${id.slice(2)}`, await gitLooseBytes(type, payload));
      return id;
    };
    for (const content of Object.values(blobs)) await write("blob", enc(content));
    const { root, objects } = await buildTrees(SAMPLE);
    for (const tree of objects) await write("tree", tree.payload);
    const identity = { name: "Radia", email: "agent@radia.invalid", when: 1700000000, tz: "+0000" };
    const commit = await buildCommit({ tree: root, parents: [], author: identity, committer: identity, message: "attempt 1" });
    await write("commit", commit.payload);
    await Deno.writeTextFile(`${dir}/refs/heads/main`, `${commit.id}\n`);
    await Deno.writeTextFile(`${dir}/HEAD`, "ref: refs/heads/main\n");
    await Deno.writeTextFile(`${dir}/config`, "[core]\n\trepositoryformatversion = 0\n\tbare = true\n");

    // `fsck` verifies every object's hash and the reachability graph: if any encoding were wrong,
    // this is where it surfaces, with git's own opinion rather than ours.
    const fsck = await new Deno.Command("git", {
      args: ["--git-dir", dir, "fsck", "--strict"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(
      fsck.success,
      `git fsck rejected the export: ${new TextDecoder().decode(fsck.stderr)}`,
    );

    // And a real clone, which is the thing a person will actually do with it.
    const work = `${dir}-work`;
    const clone = await new Deno.Command("git", {
      args: ["clone", "--quiet", dir, work],
      stdout: "null",
      stderr: "piped",
    }).output();
    try {
      assert(clone.success, `git clone failed: ${new TextDecoder().decode(clone.stderr)}`);
      for (const [path, content] of Object.entries(blobs)) {
        assertEquals(await Deno.readTextFile(`${work}/${path}`), content, path);
      }
      // The executable bit is a tree entry's mode, so it survives the projection or it does not.
      const mode = (await Deno.stat(`${work}/run.sh`)).mode ?? 0;
      assert((mode & 0o111) !== 0, "mode 100755 must arrive as an executable file");
      const log = await new Deno.Command("git", {
        args: ["-C", work, "log", "--format=%H %an <%ae> %at%n%s"],
        stdout: "piped",
      }).output();
      assertStringIncludes(new TextDecoder().decode(log.stdout), `${COMMIT} Radia <agent@radia.invalid> 1700000000`);
    } finally {
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── the exporter, against a real space ───────────────────────────────────────────────────────────
// These need records, so they carry the cost of a space. The pure-function contract above does not,
// and keeping the two apart is what lets the spec half run anywhere.

const PORT = 7819;
const url = `http://127.0.0.1:${PORT}`;
const OWNER = "human:alice";

// One space for the whole file (isolation comes from each test's own workspace NAME, which every
// query and export here already scopes by).
const shared = await bootSpace(PORT);
await shared.registerKind({
  kind: "workspace",
  indexedPaths: [
    { path: "name", type: "keyword" },
    { path: "owner", type: "keyword" },
    { path: "conversationId", type: "keyword" },
    { path: "treeDigest", type: "keyword" },
    { path: "basedOn", type: "keyword" },
  ],
  claimable: false,
});
await shared.registerKind({
  kind: "artifact",
  indexedPaths: [
    { path: "digest", type: "keyword" },
    { path: "mediaType", type: "keyword" },
    { path: "owner", type: "keyword" },
    { path: "conversationId", type: "keyword" },
    { path: "workspace", type: "keyword" },
  ],
  claimable: false,
});

async function withSpace<T>(fn: (c: RadiaClient) => Promise<T>): Promise<T> {
  return await fn(shared);
}

async function git(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const r = await new Deno.Command("git", { args, stdout: "piped", stderr: "piped" }).output();
  return {
    ok: r.success,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
}

Deno.test("[git] an iteration history exports as a commit chain a person can bisect", async () => {
  const hasGit = await haveGit();
  await withSpace(async (c) => {
    const dir = await Deno.makeTempDir({ prefix: "radia-export-" });
    try {
      // Three attempts on one workspace: the shape a code-generation loop produces.
      const v1 = await writeWorkspace(c, {
        name: "primes",
        owner: OWNER,
        files: { "main.py": "print(1)\n", "lib/util.py": "X = 1\n" },
      });
      const v2 = await writeWorkspace(c, {
        name: "primes",
        owner: OWNER,
        basedOn: v1.id,
        files: { "main.py": "print(2)\n", "lib/util.py": "X = 1\n" },
      });
      const v3 = await writeWorkspace(c, {
        name: "primes",
        owner: OWNER,
        basedOn: v2.id,
        files: { "main.py": "print(3)\n", "lib/util.py": "X = 1\n", "run.sh": "#!/bin/sh\n" },
        modes: { "run.sh": "100755" },
      });

      const result = await exportWorkspaceGit(c, "primes", dir);
      assertEquals(result.versions.length, 3);
      assertEquals(Object.keys(result.branches), ["main"], "a linear history is one branch");
      assertEquals(result.versions.map((v) => v.recordId), [v1.id, v2.id, v3.id], "oldest first");

      // The unchanged file is ONE blob across three commits. That dedup is the whole reason a
      // per-file store beats storing the tree as one artifact, and it should show up in the export.
      const objects: string[] = [];
      for await (const bucket of Deno.readDir(`${dir}/objects`)) {
        if (bucket.name === "info") continue;
        for await (const o of Deno.readDir(`${dir}/objects/${bucket.name}`)) objects.push(bucket.name + o.name);
      }
      assertEquals(new Set(objects).size, objects.length, "no object written twice");
      assertEquals(objects.length, result.objects);

      if (!hasGit) {
        console.log("    (git checks skipped: no git binary)");
        return;
      }
      assert((await git(["--git-dir", dir, "fsck", "--strict"])).ok, "git fsck must accept the export");

      // `git log --oneline` is the first thing anyone runs on an export, and a column of identical
      // subjects tells them nothing about a history whose whole value is the sequence. The subject
      // names what changed against the parent; only the root, which has no parent, counts files.
      const log = await git(["--git-dir", dir, "log", "--format=%s", "main"]);
      assertEquals(log.out.trim().split("\n"), [
        "primes: update main.py, run.sh",
        "primes: update main.py",
        "primes: 2 files",
      ], "one commit per version, newest first, each saying what it changed");

      // The trailers are what make the export traceable back into the space. Without them it is a
      // copy of some files, not an audit artifact.
      const trailers = await git(["--git-dir", dir, "log", "--format=%(trailers:key=Radia-Workspace,valueonly)", "main"]);
      assertEquals(trailers.out.split("\n").filter(Boolean), [v3.id, v2.id, v1.id]);

      const digests = await git(["--git-dir", dir, "log", "--format=%(trailers:key=Radia-Tree-Digest,valueonly)", "-1", "main"]);
      assertEquals(digests.out.trim(), v3.treeDigest);

      // `git diff` across attempts is the thing this buys that a pile of artifacts does not.
      const diff = await git(["--git-dir", dir, "diff", "--stat", "HEAD~2", "HEAD"]);
      assertStringIncludes(diff.out, "main.py");
      assertStringIncludes(diff.out, "run.sh");
      assert(!diff.out.includes("util.py"), "an untouched file must not appear in the diff");

      // The author is `created_by`, which is SERVER-ASSIGNED, and never the manifest's `owner`,
      // which is an application field a client submits. Provenance is not authority: an export whose
      // author line came from the body would let a record name whoever it liked as its writer. The
      // owner claim still travels, as a trailer, where it reads as the claim it is.
      const author = await git(["--git-dir", dir, "log", "--format=%an", "-1", "main"]);
      const writer = (await c.query({ kind: "workspace", match: { name: "primes" } }, 1, { dir: "desc" }))[0].runtimeMeta.createdBy;
      assertEquals(author.out.trim(), writer);
      assert(author.out.trim() !== OWNER, "the body's owner field must not become the git author");
      const ownerTrailer = await git(["--git-dir", dir, "log", "--format=%(trailers:key=Radia-Owner,valueonly)", "-1", "main"]);
      assertEquals(ownerTrailer.out.trim(), OWNER);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("[git] a fork exports as two branches rather than a silently dropped head", async () => {
  const hasGit = await haveGit();
  await withSpace(async (c) => {
    const dir = await Deno.makeTempDir({ prefix: "radia-fork-" });
    try {
      const base = await writeWorkspace(c, { name: "forked", owner: OWNER, files: { "a.txt": "base\n" } });
      // Two successors naming one predecessor: the divergence `forksOf` detects. Picking a winner
      // here would be this layer inventing a merge policy the design deliberately does not have.
      await writeWorkspace(c, { name: "forked", owner: OWNER, basedOn: base.id, files: { "a.txt": "left\n" } });
      await writeWorkspace(c, { name: "forked", owner: OWNER, basedOn: base.id, files: { "a.txt": "right\n" } });

      const result = await exportWorkspaceGit(c, "forked", dir);
      assertEquals(result.versions.length, 3);
      const branches = Object.keys(result.branches).sort();
      assertEquals(branches.length, 2, `expected two heads, got ${branches.join(", ")}`);
      assert(branches.includes("main"), "the newest head is main");
      assert(branches.some((b) => b.startsWith("fork-")), "the other head keeps its own branch");

      if (!hasGit) {
        console.log("    (git checks skipped: no git binary)");
        return;
      }
      assert((await git(["--git-dir", dir, "fsck", "--strict"])).ok, "a forked export must still be a valid repo");
      // One commit, two children: git's own graph shows the divergence with no new vocabulary.
      const graph = await git(["--git-dir", dir, "log", "--all", "--format=%H %P"]);
      const parents = graph.out.trim().split("\n").map((l) => l.split(" ")[1]).filter(Boolean);
      assertEquals(new Set(parents).size, 1, "both heads descend from the same commit");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("[git] a forged manifest digest is refused, not exported", async () => {
  await withSpace(async (c) => {
    const dir = await Deno.makeTempDir({ prefix: "radia-forge-" });
    try {
      const real = await writeWorkspace(c, { name: "forge", owner: OWNER, files: { "a.txt": "real\n" } });
      // An artifact's digest is server-computed and cannot be forged. A MANIFEST ENTRY claiming that
      // digest for those bytes is ordinary record content and can be, so the export verifies rather
      // than believes — the same check materialisation makes, for the same reason.
      await c.put({
        kind: "workspace",
        body: {
          name: "forge",
          owner: OWNER,
          treeDigest: real.treeDigest,
          basedOn: real.id,
          files: [{ ...real.files[0], digest: "f".repeat(64) }],
        },
      });
      await assertRejects(
        () => exportWorkspaceGit(c, "forge", dir),
        Error,
        "hashes to",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("[git] --partial exports what survives, and says so where it cannot be missed", async () => {
  const hasGit = await haveGit();
  await withSpace(async (c) => {
    const dir = await Deno.makeTempDir({ prefix: "radia-partial-" });
    try {
      const v1 = await writeWorkspace(c, { name: "leaky", owner: OWNER, files: { "app.py": "v1\n", "secret.txt": "OOPS\n" } });
      const v2 = await writeWorkspace(c, { name: "leaky", owner: OWNER, basedOn: v1.id, files: { "app.py": "v2\n", "secret.txt": "OOPS\n" } });
      await writeWorkspace(c, { name: "leaky", owner: OWNER, basedOn: v2.id, files: { "app.py": "v3\n" } });
      await c.shredArtifact(v1.files.find((f) => f.path === "secret.txt")!.artifactId, {
        acknowledgeShared: true,
        reason: "leaked",
      });

      // The default is still to refuse, and now it names the way forward. An option nobody can find
      // is the same as no option.
      const refused = await assertRejects(() => exportWorkspaceGit(c, "leaky", dir), Error);
      assertStringIncludes(refused.message, "Pass partial");

      const r = await exportWorkspaceGit(c, "leaky", dir, { partial: true });
      assertEquals(r.partial, true);
      // Two versions carried the file, so two entries were omitted — the count is per VERSION, not
      // per path, because that is what a reader of the history loses.
      assertEquals(r.erased.length, 2);
      assertEquals([...new Set(r.erased.map((e) => e.path))], ["secret.txt"]);
      assertEquals(r.versions.map((v) => v.erased.length), [1, 1, 0]);

      // The repository's own description carries it, which is the only channel that survives the
      // directory being passed to somebody who never saw the console output.
      assertStringIncludes(await Deno.readTextFile(`${dir}/description`), "PARTIAL:");
      assertStringIncludes(await Deno.readTextFile(`${dir}/description`), "secret.txt");

      if (!hasGit) {
        console.log("    (git checks skipped: no git binary)");
        return;
      }
      // Still a VALID repository. Omitting an entry is a different tree, not a broken one; a
      // placeholder blob would have been the broken-by-lying alternative.
      assert((await git(["--git-dir", dir, "fsck", "--strict"])).ok, "a partial export is still a valid repo");

      // The path is ABSENT from the tree rather than present with invented bytes.
      const tree = await git(["--git-dir", dir, "ls-tree", "--name-only", "main~2"]);
      assertEquals(tree.out.trim().split("\n"), ["app.py"]);

      // `git log --oneline` is what a reader scans, so the gap has to be in the SUBJECT, not only
      // in a trailer nobody expands.
      const log = await git(["--git-dir", dir, "log", "--format=%s", "main"]);
      assertEquals(log.out.trim().split("\n").filter((l) => l.includes("[1 erased]")).length, 2);

      // And machine-readable, naming which path, on the commit that lost it.
      const trailers = await git([
        "--git-dir",
        dir,
        "log",
        "--format=%(trailers:key=Radia-Erased,valueonly)",
        "main~2",
        "-1",
      ]);
      assertEquals(trailers.out.trim(), "secret.txt");
      const partial = await git(["--git-dir", dir, "log", "--format=%(trailers:key=Radia-Partial,valueonly)", "main", "-1"]);
      assertEquals(partial.out.trim(), "", "the version that never carried the file is NOT marked partial");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("[git] --partial skips ERASURE only, never a failure that merely looks like one", async () => {
  await withSpace(async (c) => {
    const dir = await Deno.makeTempDir({ prefix: "radia-notgone-" });
    try {
      const real = await writeWorkspace(c, { name: "strict", owner: OWNER, files: { "a.txt": "real\n" } });

      // A 410 means the runtime deliberately destroyed the bytes and they are not coming back. A 404
      // does not: it is a manifest pointing at something that never existed, which is a broken tree
      // rather than an erased one. Skipping it would hand back a repository that looks complete.
      await c.put({
        kind: "workspace",
        body: {
          name: "strict",
          owner: OWNER,
          treeDigest: real.treeDigest,
          basedOn: real.id,
          files: [{ ...real.files[0], path: "ghost.txt", artifactId: "01JJJJJJJJJJJJJJJJJJJJJJJJ" }],
        },
      });
      const err = await assertRejects(() => exportWorkspaceGit(c, "strict", dir, { partial: true }), Error);
      assertStringIncludes(err.message, "ghost.txt");
      assert(!err.message.includes("Pass partial"), "a 404 must not advertise partial as the fix");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("[git] --partial does not launder a forged manifest digest", async () => {
  await withSpace(async (c) => {
    const dir = await Deno.makeTempDir({ prefix: "radia-forge2-" });
    try {
      const real = await writeWorkspace(c, { name: "forge2", owner: OWNER, files: { "a.txt": "real\n" } });
      await c.put({
        kind: "workspace",
        body: {
          name: "forge2",
          owner: OWNER,
          treeDigest: real.treeDigest,
          basedOn: real.id,
          files: [{ ...real.files[0], digest: "f".repeat(64) }],
        },
      });
      // Content that DISAGREES with its claim is not content that is missing. Letting `partial`
      // cover it is how a forged tree becomes an export nobody questions.
      await assertRejects(() => exportWorkspaceGit(c, "forge2", dir, { partial: true }), Error, "hashes to");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("[git] an erased payload fails the export loudly instead of inventing content", async () => {
  await withSpace(async (c) => {
    const dir = await Deno.makeTempDir({ prefix: "radia-shred-" });
    try {
      const ws = await writeWorkspace(c, { name: "erased", owner: OWNER, files: { "secret.txt": "oops\n" } });
      await c.shredArtifact(ws.files[0].artifactId);
      // The alternative is a placeholder blob, which would keep the export working by making it LIE:
      // the tree would hash to something the manifest never described, and `git log` would present
      // invented bytes as the audited ones. The git projection inherits erasure; it cannot undo it.
      const err = await assertRejects(() => exportWorkspaceGit(c, "erased", dir), Error);
      assertStringIncludes(err.message, "secret.txt");
      assertStringIncludes(err.message, "shredded");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
});

// ── serving it over HTTP (plan-workspaces.md §12) ────────────────────────────────────────────────
//
// The acceptance test was written before the server, and it drives the real `git` binary against a
// real socket. That is the only judge worth having here: the protocol is only "correct" in the sense
// that a client nobody controls agrees, and Phase 8 already learned that an encoding can be
// plausible, self-consistent and rejected by `git fsck`.
//
// What is under test is the INTEGRATION, not the protocol. Dumb HTTP was measured before any of this
// was written: git 2.55 probes for smart, falls back, and asks for `info/refs`, `HEAD` and one
// object per request. The open question was whether a URL works end to end against a live space
// under a real credential.

/** Serve `handler` on an ephemeral port for the duration of `fn`. */
async function withGitServer<T>(
  handler: (req: Request) => Promise<Response>,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, handler);
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try {
    return await fn(base);
  } finally {
    await server.shutdown();
  }
}

Deno.test("[git] a workspace clones over HTTP, and the checkout matches the manifest", async () => {
  if (!await haveGit()) {
    console.log("    (skipped: no git binary)");
    return;
  }
  await withSpace(async (c) => {
    const work = await Deno.makeTempDir({ prefix: "radia-clone-" });
    try {
      const v1 = await writeWorkspace(c, {
        name: "site",
        owner: OWNER,
        files: { "index.html": "<h1>one</h1>\n", "css/style.css": "body{}\n" },
      });
      await writeWorkspace(c, {
        name: "site",
        owner: OWNER,
        basedOn: v1.id,
        files: { "index.html": "<h1>two</h1>\n", "css/style.css": "body{}\n" },
      });

      const seen: string[] = [];
      await withGitServer(gitHandler(() => c, {}, (e) => seen.push(`${e.status} ${e.path}`)), async (base) => {
        const clone = await git(["clone", "--quiet", `${base}/site.git`, `${work}/site`]);
        assert(clone.ok, `git clone failed: ${clone.err}`);
        // The checkout is the NEWEST version, byte for byte.
        assertEquals(await Deno.readTextFile(`${work}/site/index.html`), "<h1>two</h1>\n");
        assertEquals(await Deno.readTextFile(`${work}/site/css/style.css`), "body{}\n");
        // Both versions, as a history a person can walk.
        const log = await git(["-C", `${work}/site`, "log", "--oneline"]);
        assertEquals(log.out.trim().split("\n").length, 2, log.out);
        // git's own verdict on every object and the reachability graph.
        assert((await git(["-C", `${work}/site`, "fsck", "--strict"])).ok, "git fsck must accept what was served");
      });
      // TWO requests, which is the whole point of the smart protocol: the advertisement, then one
      // POST that returns a packfile. Under the dumb walk this same clone was an advertisement, a
      // HEAD and one request per object, and that is the shape this assertion exists to notice if it
      // ever comes back (a content type typo is enough — git falls back silently, and slowly).
      assert(seen.some((s) => s.includes("info/refs")), seen.join("\n"));
      assert(seen.some((s) => s.includes("git-upload-pack")), `expected a smart fetch, saw:\n${seen.join("\n")}`);
      assertEquals(
        seen.filter((s) => s.includes("/objects/")).length,
        0,
        `a smart clone fetches no loose objects, saw:\n${seen.join("\n")}`,
      );
    } finally {
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("[git] the clone is the CALLER's, and push is refused in words", async () => {
  await withSpace(async (c) => {
    // Authorization is per request, so the server never lends its own reach to a caller. Here the
    // credential resolver refuses, which is what an unauthenticated `git clone` meets.
    await withGitServer(gitHandler(() => null), async (base) => {
      const res = await fetch(`${base}/site.git/info/refs?service=git-upload-pack`);
      assertEquals(res.status, 401);
      // Without a realm `git` fails outright instead of asking for a password.
      assertStringIncludes(res.headers.get("www-authenticate") ?? "", "Basic");
      assertStringIncludes(await res.text(), "definition token");
    });

    await withGitServer(gitHandler(() => c), async (base) => {
      // A 404 would read as a missing feature and send someone looking for a flag. Push is not
      // missing: it reopens the export-only decision, so it is refused with the reason and the verb
      // that does the job instead.
      const res = await fetch(`${base}/site.git/git-receive-pack`, { method: "POST" });
      assertEquals(res.status, 403);
      assertStringIncludes(await res.text(), "edit_workspace");

      // A workspace nobody can see and one that does not exist answer the same, so a clone URL is
      // not an existence oracle for somebody else's trees.
      const missing = await fetch(`${base}/nope.git/info/refs`);
      assertEquals(missing.status, 404);
    });
  });
});

Deno.test("[git] a definition token in the URL is what git stores, and it authenticates", async () => {
  if (!await haveGit()) {
    console.log("    (skipped: no git binary)");
    return;
  }
  await withSpace(async (c) => {
    const work = await Deno.makeTempDir({ prefix: "radia-clone-auth-" });
    try {
      await writeWorkspace(c, { name: "priv", owner: OWNER, files: { "a.txt": "A\n" } });
      // The whole reason this phase waited: git persists a static secret and cannot renew, so the
      // password has to be the DURABLE half. A definition token cannot read or write anything by
      // itself, which is what makes it safe in a `.git/config`; the server exchanges it per
      // connection for a run token that can.
      const { definitionToken } = await c.createAgentDefinition("agent:git-reader", [
        { principal: "agent:git-reader", kind: "workspace", operations: ["query", "read_one"] },
        { principal: "agent:git-reader", kind: "artifact", operations: ["read_one"] },
      ]);
      // The same shape `radia git-serve` uses: one client per credential, re-authenticated when a
      // fetch starts. Without the cache a dumb clone exchanges once per OBJECT and writes an
      // `agent_run` record each time; without the re-authentication a revoked token keeps cloning
      // until the cached run expires.
      const clients = new Map<string, RadiaClient>();
      const handler = gitHandler(async (req, { startsFetch }) => {
        const password = basicPassword(req);
        if (!password) return null;
        if (startsFetch) clients.delete(password);
        const cached = clients.get(password);
        if (cached) return cached;
        const fresh = new RadiaClient(url, { definitionToken: password });
        await fresh.ensureCredential();
        clients.set(password, fresh);
        return fresh;
      });
      await withGitServer(handler, async (base) => {
        const authed = base.replace("http://", `http://reader:${definitionToken}@`);
        const clone = await git(["clone", "--quiet", `${authed}/priv.git`, `${work}/priv`]);
        assert(clone.ok, `git clone with a definition token failed: ${clone.err}`);
        assertEquals(await Deno.readTextFile(`${work}/priv/a.txt`), "A\n");

        // And the off switch works on a clone URL: revoking stops the next fetch, immediately,
        // because credentials resolve from records per request rather than from a cache.
        await c.revokeDefinition("agent:git-reader");
        const again = await git(["clone", "--quiet", `${authed}/priv.git`, `${work}/priv2`]);
        assert(!again.ok, "a revoked definition must not be able to clone");
      });
    } finally {
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("[git] the dumb routes still serve, for anything that is not git", async () => {
  await withSpace(async (c) => {
    await writeWorkspace(c, { name: "dumb", owner: OWNER, files: { "a.txt": "A\n" } });
    await withGitServer(gitHandler(() => c), async (base) => {
      // No `?service=`, so this is the plain file a static mirror or a `curl` would read. It costs
      // two `if`s to keep and it is the only thing a client without git can use.
      const refs = await (await fetch(`${base}/dumb.git/info/refs`)).text();
      assertStringIncludes(refs, "\trefs/heads/main");
      assertEquals((await (await fetch(`${base}/dumb.git/HEAD`)).text()).trim(), "ref: refs/heads/main");

      // And the loose object the advertisement names, at git's own layout.
      const commit = refs.split("\t")[0];
      const object = await fetch(`${base}/dumb.git/objects/${commit.slice(0, 2)}/${commit.slice(2)}`);
      assertEquals(object.status, 200);
      assertEquals(object.headers.get("content-type"), "application/x-git-loose-object");
      assert((await object.arrayBuffer()).byteLength > 0);
    });
  });
});

Deno.test("[git] the smart advertisement says which branch to check out", async () => {
  await withSpace(async (c) => {
    await writeWorkspace(c, { name: "adv", owner: OWNER, files: { "a.txt": "A\n" } });
    await withGitServer(gitHandler(() => c), async (base) => {
      const body = await (await fetch(`${base}/adv.git/info/refs?service=git-upload-pack`)).text();
      // The service header, then a flush, then the refs. Getting this order wrong makes git fall
      // back to the dumb walk without saying anything.
      assert(body.startsWith("001e# service=git-upload-pack\n0000"), JSON.stringify(body.slice(0, 40)));
      // Capabilities ride on the FIRST ref line after a NUL, not on a line of their own, and
      // `symref` is how a clone learns the default branch rather than guessing at it.
      assertStringIncludes(body, "\0symref=HEAD:refs/heads/main");
      assertStringIncludes(body, " HEAD\0");
      assert(body.endsWith("0000"), JSON.stringify(body.slice(-8)));
    });
  });
});

Deno.test("[git] a want this history does not hold is refused, not silently omitted", async () => {
  await withSpace(async (c) => {
    await writeWorkspace(c, { name: "want", owner: OWNER, files: { "a.txt": "A\n" } });
    await withGitServer(gitHandler(() => c), async (base) => {
      // A client working from an advertisement that has moved on, or pointed at the wrong history.
      // Sending a pack that just lacks the object gets reported by git as "did not send all
      // necessary objects", which names neither the object nor the reason.
      const want = `0032want ${"9".repeat(40)}\n00000009done\n`;
      const res = await fetch(`${base}/want.git/git-upload-pack`, { method: "POST", body: want });
      assertEquals(res.status, 200);
      const body = await res.text();
      assertStringIncludes(body, "ERR ");
      assertStringIncludes(body, "9".repeat(40));
    });
  });
});

Deno.test("[git] a challenge is not a failure, and is reported as neither", async () => {
  await withSpace(async (c) => {
    await writeWorkspace(c, { name: "chal", owner: OWNER, files: { "a.txt": "A\n" } });
    const seen: { status: number; challenge?: true }[] = [];
    // HTTP Basic OPENS with a 401: git asks, is challenged, asks again with the password. Every
    // authenticated clone therefore produces one, and reporting it as an error turned a working
    // clone into a wall of alarming lines — under the dumb walk, one per object.
    const handler = gitHandler(
      (req) => (basicPassword(req) ? c : null),
      {},
      (e) => seen.push({ status: e.status, ...(e.challenge ? { challenge: true } : {}) }),
    );
    await withGitServer(handler, async (base) => {
      await fetch(`${base}/chal.git/info/refs?service=git-upload-pack`); // no credentials
      await fetch(`${base}/chal.git/info/refs?service=git-upload-pack`, {
        headers: { authorization: `Basic ${btoa("u:whatever")}` },
      });
    });
    assertEquals(seen.length, 2);
    assertEquals(seen[0], { status: 401, challenge: true }, "an empty-handed 401 is the opening move");
    assertEquals(seen[1].status, 200, "credentials get served");
    assert(!seen[1].challenge);
  });
});
