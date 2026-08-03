// The git projection's contract.
//
//   deno task extensions
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
import { operatorToken } from "../../examples/operator.ts";
import { writeWorkspace } from "../ts/workspace.ts";

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

async function withSpace<T>(fn: (c: RadiaClient) => Promise<T>): Promise<T> {
  const space = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  const probe = new RadiaClient(url);
  for (let i = 0; i < 100; i++) {
    try {
      await probe.health();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const c = new RadiaClient(url, { token: operatorToken(url) });
  await c.registerKind({
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
  await c.registerKind({
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
  try {
    return await fn(c);
  } finally {
    space.kill();
    await space.status;
  }
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
