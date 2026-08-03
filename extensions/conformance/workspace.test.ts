// The workspace convention's contract: what any implementation must satisfy.
//
//   deno task extensions
//
// Two of these are NORMATIVE rather than convenient (see ../README.md). `treeDigestOf` is what a
// `check` attests to, so a verdict computed by another language binding is comparable only if the
// digest matches byte for byte. `validatePath` is a security boundary, and a rule that differs
// between implementations is a hole rather than an inconsistency. Both are specified here: this
// file is the contract, not a regression net for one implementation.
//
// The rest answers Phase 1 of agent_docs/plan-workspaces.md: does a churning tree-as-records hold
// up, and where does the record body limit bite. No execution, no sandbox, no materialisation.

import { assert, assertEquals } from "@std/assert";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../../examples/operator.ts";
import {
  captureWorkspace,
  CAPTURE_LIMITS,
  commitWorkspace,
  listWorkspaces,
  readWorkspace,
  TREE_DIGEST_VERSION,
  treeDigestOf,
  validatePath,
  materialize,
  type WorkspaceFile,
  type WorkspaceManifest,
  writeWorkspace,
} from "../ts/workspace.ts";
import { runCode } from "../ts/sandbox.ts";

const PORT = 7815;
const url = `http://127.0.0.1:${PORT}`;
const OWNER = "human:alice";

/** One space for the whole file: these are contract checks, not isolation checks, and a space per
 *  test would spend more time booting than asserting. */
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

// ── NORMATIVE: the tree digest ───────────────────────────────────────────────────────────────────

Deno.test("workspace: the tree digest is a fixed function of the tree, and carries its version", async () => {
  const files: WorkspaceFile[] = [
    { path: "src/a.ts", mode: "100644", digest: "a".repeat(64), artifactId: "x" },
    { path: "src/b.ts", mode: "100644", digest: "b".repeat(64), artifactId: "y" },
  ];
  const d = await treeDigestOf(files);

  // The VERSION is in the digest. Without it, a digest from a later algorithm is another 64 hex
  // characters: indistinguishable from an older one and silently incomparable. `grantKey` needed
  // exactly this prefix after a field rename, for exactly this reason.
  assert(d.startsWith(`${TREE_DIGEST_VERSION}:`), `expected a version prefix, got ${d}`);
  assertEquals(d.split(":")[1].length, 64);
  assert(/^[0-9a-f]{64}$/.test(d.split(":")[1]), "lowercase hex, no padding");

  // A property of the TREE, not of write order.
  assertEquals(await treeDigestOf([files[1], files[0]]), d);

  // Every input participates: path, mode and content each change it.
  assert(await treeDigestOf([{ ...files[0], path: "src/c.ts" }, files[1]]) !== d, "path");
  assert(await treeDigestOf([{ ...files[0], mode: "100755" }, files[1]]) !== d, "mode");
  assert(await treeDigestOf([{ ...files[0], digest: "c".repeat(64) }, files[1]]) !== d, "content");

  // The artifact id does NOT: the same bytes stored twice are two records and one tree.
  assertEquals(await treeDigestOf([{ ...files[0], artifactId: "other" }, files[1]]), d);

  // NUL-separated, so no field can forge a boundary: a path containing the separator between the
  // other fields must not collide with a different tree.
  const forged = await treeDigestOf([{ path: "src/a.ts\u0000100644", mode: "100644", digest: "a".repeat(64), artifactId: "x" }]);
  const plain = await treeDigestOf([{ path: "src/a.ts", mode: "100644", digest: "a".repeat(64), artifactId: "x" }]);
  assert(forged !== plain, "a path may not impersonate a field boundary");

  // A KNOWN-ANSWER vector, computed rather than asserted from memory, so a second implementation
  // has something to check itself against without running this one. Input: a single entry
  // `a\0100644\0` + sixty-four zeros, sha256, prefixed with the version.
  assertEquals(
    await treeDigestOf([{ path: "a", mode: "100644", digest: "0".repeat(64), artifactId: "" }]),
    "t1:a0054683443a3545bfc1aecb8d04b729deb3d2412bafb5ac7ecd83b274acc898",
  );
});

// ── NORMATIVE: path safety ───────────────────────────────────────────────────────────────────────

Deno.test("workspace: path validation is git's checkout list, not one rediscovered per incident", () => {
  // Materialisation is the TRUSTED worker writing model-influenced paths outside any jail, so an
  // unsafe path must never enter a manifest. Each entry names a real class of failure.
  const refused: [string, string][] = [
    ["/etc/passwd", "absolute"],
    ["../escape", "traversal"],
    ["src/../../out", "traversal mid-path"],
    ["C:\\win", "windows drive"],
    ["a\\b", "backslash separator"],
    ["src//a.ts", "empty segment"],
    ["src/a.ts ", "trailing space (some filesystems strip it, so two entries collide)"],
    ["src/a.", "trailing dot (same)"],
    [".git/config", "would collide with an exported repository"],
    [".GIT/config", "case folding, CVE-2014-9390"],
    ["src/.Git/x", "case folding, nested"],
    ["", "empty"],
    ["a\u0000b", "NUL"],
    ["x".repeat(513), "unbounded length"],
  ];
  for (const [path, why] of refused) {
    let ok = false;
    try {
      validatePath(path);
      ok = true;
    } catch { /* expected */ }
    assert(!ok, `${JSON.stringify(path)} must be refused: ${why}`);
  }
  for (const path of ["a.ts", "src/a.ts", "a/b/c/d.txt", "src/.hidden", "with space/x.ts", "a.git"]) {
    validatePath(path); // throws on failure
  }
});

// ── the convention against a real space ──────────────────────────────────────────────────────────

Deno.test("workspace: identical bytes share a blob, and re-writing a tree writes nothing", async () => {
  await withSpace(async (c) => {
    const a = await writeWorkspace(c, {
      name: "ws",
      owner: OWNER,
      files: { "src/b.ts": "console.log(2)", "src/a.ts": "console.log(1)" },
    });
    const b = await writeWorkspace(c, {
      name: "ws2",
      owner: OWNER,
      files: { "src/a.ts": "console.log(1)", "src/b.ts": "console.log(2)" },
    });
    assertEquals(a.treeDigest, b.treeDigest, "the same tree, whatever the write order");
    assertEquals(a.files[0].path, "src/a.ts", "stored sorted, so a manifest reads the same way twice");

    // One blob, two artifact records. This is what makes per-file erasure meaningful and keeps a
    // shared dependency tree from costing its size once per workspace.
    assertEquals(a.files[0].digest, b.files[0].digest);
    assert(a.files[0].artifactId !== b.files[0].artifactId);

    // A workspace churns per attempt, and unbounded growth is what makes a bounded read dangerous.
    const again = await writeWorkspace(c, {
      name: "ws",
      owner: OWNER,
      files: { "src/a.ts": "console.log(1)", "src/b.ts": "console.log(2)" },
    });
    assert(again.deduped && again.id === a.id, "an identical tree is not a new version");

    // A tree with ONE bad path leaves no artifacts behind, because there will be no manifest to
    // make them reachable.
    let wrote = true;
    try {
      await writeWorkspace(c, { name: "evil", owner: OWNER, files: { "../out": "x" } });
    } catch {
      wrote = false;
    }
    assert(!wrote);
    assertEquals(await readWorkspace(c, "evil"), null);
  });
});

Deno.test("workspace: churn stays cheap to read, and listing is honest about completeness", async () => {
  await withSpace(async (c) => {
    const CHURN = 40;
    let prev: string | undefined;
    for (let i = 0; i < CHURN; i++) {
      prev = (await writeWorkspace(c, {
        name: "churn",
        owner: OWNER,
        files: { "src/main.ts": `export const attempt = ${i}\n`, "README.md": "stable\n" },
        basedOn: prev,
      })).id;
    }

    // The question CLAUDE.md's stopping rule asks. Reading one workspace is keyed and bounded, so
    // depth does not matter; it is LISTING that has to page.
    const t = performance.now();
    const cur = await readWorkspace(c, "churn");
    const readMs = performance.now() - t;
    assert(readMs < 100, `reading after ${CHURN} versions took ${readMs.toFixed(1)}ms`);
    const body = await c.getArtifact(cur!.files.find((f) => f.path === "src/main.ts")!.artifactId);
    assert(new TextDecoder().decode(body).includes(`= ${CHURN - 1}`), "the newest version wins");
    assert(cur!.basedOn, "each version names the one it supersedes, so a fork is visible");

    // Nothing is lost: every version stays addressable. This is why last-writer-wins is divergence
    // rather than data loss.
    assertEquals((await c.query({ kind: "workspace", match: { name: "churn" } }, 100)).length, CHURN);

    // Churn costs what CHANGED. The unchanged file is one blob across every version.
    const all = await c.query({ kind: "workspace", match: { name: "churn" } }, 100);
    const digests = new Set(
      all.map((r) => (r.body as { files: WorkspaceFile[] }).files.find((f) => f.path === "README.md")!.digest),
    );
    assertEquals(digests.size, 1);

    const listed = await listWorkspaces(c);
    assert(listed.complete, "a complete scan says so");
    assertEquals(listed.workspaces.filter((w) => w.name === "churn").length, 1, "latest-wins per name");
    // …and an incomplete one says THAT, rather than returning a plausible prefix.
    assertEquals((await listWorkspaces(c, 0)).complete, false);
  });
});

Deno.test("workspace: the record body limit caps a manifest, which forces dependencies out of line", async () => {
  await withSpace(async (c) => {
    // The number this phase owed. A manifest is a record body, and a body cannot be erased, so the
    // limit is what turns "put the dependency tree beside the manifest" from a preference into a
    // wall. Two points bracket it rather than a full ladder: the contract is that a limit EXISTS
    // and bites in this range, not the exact file count.
    const tree = (n: number) => {
      const files: Record<string, string> = {};
      for (let i = 0; i < n; i++) files[`src/mod${Math.floor(i / 100)}/f${i}.ts`] = `export const x = ${i}\n`;
      return files;
    };
    const ok = await writeWorkspace(c, { name: "under", owner: OWNER, files: tree(3000) });
    const rec = await c.getRecord(ok.id);
    const bytes = new TextEncoder().encode(JSON.stringify(rec!.body)).length;
    assert(bytes < 1024 * 1024, `3000 files is ${Math.round(bytes / 1024)} KiB, under the limit`);

    let refused = "";
    try {
      await writeWorkspace(c, { name: "over", owner: OWNER, files: tree(10000) });
    } catch (e) {
      refused = (e as Error).message;
    }
    assert(/record_too_large/.test(refused), `10000 files must be refused, got: ${refused || "accepted"}`);
  });
});

// ── Phase 2: materialise, read-only ──────────────────────────────────────────────────────────────

Deno.test("workspace: materialising writes exactly the tree, and a run can read it", async () => {
  await withSpace(async (c) => {
    await writeWorkspace(c, {
      name: "mat",
      owner: OWNER,
      files: {
        "src/main.ts": "export const answer = 42\n",
        "src/lib/util.ts": "export const two = 2\n",
        "README.md": "docs\n",
      },
      modes: { "src/main.ts": "100755" },
    });
    const m = (await readWorkspace(c, "mat"))!;
    const root = await Deno.makeTempDir({ prefix: "radia-ws-" });
    try {
      const out = await materialize(c, m, root);
      assertEquals(out.written, 3);

      // Exactly the tree: contents, nesting and mode.
      assertEquals(await Deno.readTextFile(`${out.root}/src/main.ts`), "export const answer = 42\n");
      assertEquals(await Deno.readTextFile(`${out.root}/src/lib/util.ts`), "export const two = 2\n");
      if (Deno.build.os !== "windows") {
        assertEquals((await Deno.stat(`${out.root}/src/main.ts`)).mode! & 0o777, 0o755, "executable bit survives");
        assertEquals((await Deno.stat(`${out.root}/README.md`)).mode! & 0o777, 0o644);
      }

      // And a sandbox can READ it with nothing else granted: the point of materialising at all.
      const r = await runCode(
        `const t = Deno.readTextFileSync(${JSON.stringify(out.root)} + "/src/main.ts"); console.log(t.trim())`,
        { readRoots: [out.root] },
      );
      assert(r.ok, `run failed: ${r.stderr}`);
      assertEquals(r.stdout.trim(), "export const answer = 42");

      // …and cannot WRITE, which is what "read-only" means here rather than a convention.
      const w = await runCode(`Deno.writeTextFileSync(${JSON.stringify(out.root)} + "/x", "no")`, { readRoots: [out.root] });
      assert(!w.ok, "the sandbox must not be able to write into a materialised tree");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

Deno.test("workspace: materialising refuses to escape the root, including through a symlink", async () => {
  await withSpace(async (c) => {
    const root = await Deno.makeTempDir({ prefix: "radia-ws-" });
    const outside = await Deno.makeTempDir({ prefix: "radia-outside-" });
    try {
      await Deno.writeTextFile(`${outside}/secret`, "original\n");
      const art = await c.putArtifact(new TextEncoder().encode("overwritten\n"), { mediaType: "text/plain" });

      // A manifest whose path is lexically fine but resolves outside, because an entry earlier in
      // sort order planted a link. This is how `git checkout` has historically been escaped, and it
      // is why lexical validation alone is not enough.
      await Deno.symlink(outside, `${root}/link`);
      const hostile: WorkspaceManifest = {
        name: "hostile",
        owner: OWNER,
        treeDigest: "t1:" + "0".repeat(64),
        files: [{ path: "link/secret", mode: "100644", digest: art.digest, artifactId: art.id }],
      };
      let refused = "";
      try {
        await materialize(c, hostile, root);
      } catch (e) {
        refused = (e as Error).message;
      }
      assert(/escapes the root/.test(refused), `a symlinked path must be refused, got: ${refused || "written"}`);
      assertEquals(await Deno.readTextFile(`${outside}/secret`), "original\n", "and nothing outside was touched");

      // A lexically bad path is refused too, even though `writeWorkspace` would never produce one:
      // a manifest can arrive from an older build, so this is the last check before a filesystem op.
      const traversal: WorkspaceManifest = {
        ...hostile,
        files: [{ path: "../escape", mode: "100644", digest: art.digest, artifactId: art.id }],
      };
      let lexical = "";
      try {
        await materialize(c, traversal, root);
      } catch (e) {
        lexical = (e as Error).message;
      }
      assert(/not allowed/.test(lexical), `traversal must be refused, got: ${lexical || "written"}`);
    } finally {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  });
});

Deno.test("workspace: a classified tree does not launder its labels through the filesystem", async () => {
  await withSpace(async (c) => {
    // THE Phase 2 question. Bytes go to disk, code reads them, output comes back — and the
    // substrate cannot observe a filesystem. So the labels have to travel on the RECORD graph, and
    // the manifest is what makes that affordable: one parent edge instead of one per file.
    await writeWorkspace(c, {
      name: "classified",
      owner: OWNER,
      files: { "data.txt": "from a file read\n" },
      taint: ["file"],
    });
    const m = (await readWorkspace(c, "classified"))!;

    // Every file carries the label, so erasing or barring one is possible per file…
    const art = await c.getRecord(m.files[0].artifactId);
    assertEquals(art!.runtimeMeta.taint, ["file"]);
    // …and the MANIFEST carries the union, so one edge speaks for the tree.
    assertEquals((await c.getRecord(m.id))!.runtimeMeta.taint, ["file"]);

    // A result that names the manifest inherits it. This is the anti-laundering property: the run
    // read those bytes off a disk the substrate cannot see, and the classification still arrives.
    await c.registerKind({ kind: "run_result", indexedPaths: [], claimable: false });
    const result = await c.put({ kind: "run_result", body: { stdout: "from a file read" }, parentIds: [m.id] });
    assertEquals((await c.getRecord(result.id))!.runtimeMeta.taint, ["file"]);

    // And the hole this leaves, stated rather than hidden: a result that does NOT name the manifest
    // launders. Same shape as omitting any parent edge, and not something materialising can fix.
    const laundered = await c.put({ kind: "run_result", body: { stdout: "from a file read" } });
    assertEquals((await c.getRecord(laundered.id))!.runtimeMeta.taint, []);
  });
});

// ── Phase 3: verification and write-back ─────────────────────────────────────────────────────────

Deno.test("workspace: materialising REFUSES a manifest that lies about its digests", async () => {
  await withSpace(async (c) => {
    // The client-asserted link in the attestation chain. An artifact's digest is server-computed
    // and cannot be forged; a manifest ENTRY claiming that digest for those bytes can be, because a
    // manifest is an ordinary record. If nothing recomputes, a `check` attests to a tree that never
    // existed, and the whole point of binding a verdict to a treeDigest is lost.
    await writeWorkspace(c, { name: "honest", owner: OWNER, files: { "a.txt": "real\n" } });
    const m = (await readWorkspace(c, "honest"))!;
    const root = await Deno.makeTempDir({ prefix: "radia-ws-" });
    try {
      // Honest manifest: materialises, and hands back the digest it VERIFIED rather than the one
      // it was told.
      const ok = await materialize(c, m, root);
      assertEquals(ok.treeDigest, m.treeDigest);

      // An entry whose digest does not match its artifact's bytes.
      const lying: WorkspaceManifest = { ...m, files: [{ ...m.files[0], digest: "b".repeat(64) }] };
      let e1 = "";
      try {
        await materialize(c, lying, root);
      } catch (e) {
        e1 = (e as Error).message;
      }
      assert(/hashes to/.test(e1), `a forged entry digest must be refused, got: ${e1 || "accepted"}`);

      // A tree digest that does not describe its own file list.
      const wrongTree: WorkspaceManifest = { ...m, treeDigest: "t1:" + "c".repeat(64) };
      let e2 = "";
      try {
        await materialize(c, wrongTree, root);
      } catch (e) {
        e2 = (e as Error).message;
      }
      assert(/claims treeDigest/.test(e2), `a forged tree digest must be refused, got: ${e2 || "accepted"}`);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

Deno.test("workspace: write-back stores what changed and nothing else", async () => {
  await withSpace(async (c) => {
    await writeWorkspace(c, {
      name: "wb",
      owner: OWNER,
      files: { "keep.txt": "unchanged\n", "edit.txt": "before\n", "gone.txt": "bye\n" },
      ignore: ["out"],
    });
    const m = (await readWorkspace(c, "wb"))!;
    const root = await Deno.makeTempDir({ prefix: "radia-ws-" });
    try {
      await materialize(c, m, root);

      // A run edits one file, creates one, deletes one, and drops something in an ignored path.
      await Deno.writeTextFile(`${root}/edit.txt`, "after\n");
      await Deno.writeTextFile(`${root}/new.txt`, "fresh\n");
      await Deno.remove(`${root}/gone.txt`);
      await Deno.mkdir(`${root}/out`, { recursive: true });
      await Deno.writeTextFile(`${root}/out/build.js`, "artifact of building\n");
      // …and a symlink pointing outside, which must never be followed into a record.
      await Deno.symlink("/etc/hostname", `${root}/link.txt`);

      const cap = await captureWorkspace(c, m, root);
      assertEquals(cap.changed.sort(), ["edit.txt", "new.txt"], "only what changed becomes a new artifact");
      assertEquals(cap.removed, ["gone.txt"]);
      const paths = cap.files.map((f) => f.path).sort();
      assertEquals(paths, ["edit.txt", "keep.txt", "new.txt"], "ignored paths and symlinks are not captured");

      // The untouched file reuses the artifact that already holds those bytes: an attempt costs
      // what it edited, not the size of the tree.
      assertEquals(cap.files.find((f) => f.path === "keep.txt")!.artifactId, m.files.find((f) => f.path === "keep.txt")!.artifactId);

      const next = await commitWorkspace(c, m, cap);
      assert(next, "a changed tree commits a successor");
      assertEquals(next!.treeDigest, await treeDigestOf(cap.files));
      const now = (await readWorkspace(c, "wb"))!;
      assertEquals(now.basedOn, m.id, "and it names the version it supersedes");
      assertEquals(new TextDecoder().decode(await c.getArtifact(now.files.find((f) => f.path === "edit.txt")!.artifactId)), "after\n");

      // A run that changes NOTHING must not manufacture a version.
      const root2 = await Deno.makeTempDir({ prefix: "radia-ws-" });
      try {
        await materialize(c, now, root2);
        const cap2 = await captureWorkspace(c, now, root2);
        assert(cap2.unchanged);
        assertEquals(await commitWorkspace(c, now, cap2), null);
      } finally {
        await Deno.remove(root2, { recursive: true });
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

Deno.test("workspace: capture refuses rather than truncates when a run exceeds its budget", async () => {
  await withSpace(async (c) => {
    // A partial capture presented as a tree is the bounded-read-as-population bug wearing a
    // filesystem: the manifest would describe a project that never existed.
    await writeWorkspace(c, { name: "budget", owner: OWNER, files: { "a.txt": "a\n" } });
    const m = (await readWorkspace(c, "budget"))!;
    const root = await Deno.makeTempDir({ prefix: "radia-ws-" });
    try {
      await materialize(c, m, root);
      for (let i = 0; i < CAPTURE_LIMITS.maxFiles + 5; i++) {
        await Deno.writeTextFile(`${root}/f${i}.txt`, "x");
      }
      let refused = "";
      try {
        await captureWorkspace(c, m, root);
      } catch (e) {
        refused = (e as Error).message;
      }
      assert(/more than .* files/.test(refused), `a file-count budget must refuse, got: ${refused || "captured"}`);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
