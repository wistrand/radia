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
  forksOf,
  listWorkspaces,
  readWorkspace,
  summarizeWorkspaces,
  TREE_DIGEST_VERSION,
  treeDigestOf,
  validatePath,
  materialize,
  type WorkspaceFile,
  type WorkspaceManifest,
  writeWorkspace,
} from "../ts/workspace.ts";
import { bwrapSandbox, denoSandbox, probeSandbox, runBwrap, runCode } from "../ts/sandbox.ts";
import { declareSandbox, listSandboxes, readSandbox, SANDBOX_KIND, verifySandbox } from "../ts/sandbox-registry.ts";

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

Deno.test("workspace: a summary answers what EXISTS, which a raw query cannot", async () => {
  await withSpace(async (c) => {
    // The gap this closes. `query workspace` returns every VERSION, so a tree saved three times
    // reads as three trees; counting rows answers a question nobody asked.
    let prev: string | undefined;
    for (const body of ["a\n", "b\n", "c\n"]) {
      prev = (await writeWorkspace(c, { name: "iterated", owner: OWNER, basedOn: prev, files: { "f.txt": body } })).id;
    }
    await writeWorkspace(c, { name: "single", owner: OWNER, files: { "x.txt": "1\n", "y.txt": "2\n" } });

    const raw = await c.query({ kind: "workspace", match: { name: "iterated" } }, 100);
    assertEquals(raw.length, 3, "three records, as the substrate should have");

    const s = await summarizeWorkspaces(c);
    assert(s.complete, "a complete scan says so");
    const iterated = s.workspaces.find((w) => w.name === "iterated")!;
    assertEquals(iterated.versions, 3, "the history is COUNTED, not listed as separate workspaces");
    assertEquals(iterated.files, 1);
    assertEquals(iterated.forked, false);
    assertEquals(s.workspaces.filter((w) => w.name === "iterated").length, 1, "one line per name");
    assertEquals(s.workspaces.find((w) => w.name === "single")!.files, 2);
    // Sorted by name, so two runs against one space produce the same output and a diff means a
    // change rather than an ordering.
    assertEquals([...s.workspaces].map((w) => w.name).sort(), s.workspaces.map((w) => w.name));

    // A fork is reported per entry, computed from the SAME paged read rather than a query per name.
    const base = await writeWorkspace(c, { name: "diverged", owner: OWNER, files: { "z": "0\n" } });
    await writeWorkspace(c, { name: "diverged", owner: OWNER, basedOn: base.id, files: { "z": "L\n" } });
    await writeWorkspace(c, { name: "diverged", owner: OWNER, basedOn: base.id, files: { "z": "R\n" } });
    const forked = (await summarizeWorkspaces(c)).workspaces.find((w) => w.name === "diverged")!;
    assertEquals(forked.forked, true);
    assertEquals(forked.heads.length, 2, "both heads survive; neither is merged or dropped");

    // A withdrawn workspace leaves the listing, the same rule `activeByKey` applies everywhere.
    const gone = await writeWorkspace(c, { name: "withdrawn", owner: OWNER, files: { "q": "1\n" } });
    assert((await summarizeWorkspaces(c)).workspaces.some((w) => w.name === "withdrawn"));
    await c.put({
      kind: "workspace",
      body: { name: "withdrawn", owner: OWNER, treeDigest: gone.treeDigest, basedOn: gone.id, files: [], retired: true },
    });
    assert(!(await summarizeWorkspaces(c)).workspaces.some((w) => w.name === "withdrawn"), "retired leaves the list");

    // INCOMPLETE is reported, never hidden. "I found no workspace called X" and "I could not see
    // all of them" are different answers, and only one is safe to act on by re-creating X.
    const partial = await summarizeWorkspaces(c, { maxPages: 0 });
    assertEquals(partial.complete, false);
    assertEquals(partial.workspaces, []);
  });
});

Deno.test("workspace: a summary scoped to a conversation shows only that conversation's trees", async () => {
  await withSpace(async (c) => {
    await writeWorkspace(c, { name: "mine", owner: OWNER, conversationId: "conv-a", files: { "a": "1\n" } });
    await writeWorkspace(c, { name: "theirs", owner: OWNER, conversationId: "conv-b", files: { "b": "1\n" } });
    await writeWorkspace(c, { name: "loose", owner: OWNER, files: { "c": "1\n" } });

    // RELEVANCE, not authorization: a session's grant already limits what it may read. The scope
    // keeps a long-lived space from answering "what am I working on" with every tree anyone made.
    const scoped = await summarizeWorkspaces(c, { conversationId: "conv-a" });
    assertEquals(scoped.workspaces.map((w) => w.name), ["mine"]);
    assertEquals((await summarizeWorkspaces(c)).workspaces.map((w) => w.name).sort(), ["loose", "mine", "theirs"]);
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

// ── Phase 4: fork detection ──────────────────────────────────────────────────────────────────────

Deno.test("workspace: two writers on one base fork VISIBLY rather than one vanishing", async () => {
  await withSpace(async (c) => {
    // There is no compare-and-swap here, so two writers that read the same manifest both succeed
    // and latest-wins picks one. That is not data loss: the other version is still a record with
    // its history intact, which is a permanent reflog rather than a force-push. What was missing is
    // DETECTION, because without it the losing writer's work is merely somewhere else and nobody
    // is told.
    await writeWorkspace(c, { name: "race", owner: OWNER, files: { "a.txt": "base\n" } });
    const base = (await readWorkspace(c, "race"))!;
    assertEquals((await forksOf(c, "race")).forked, false, "one head to start with");

    // Both writers read the SAME base, as two agents in one conversation would.
    const first = await writeWorkspace(c, { name: "race", owner: OWNER, files: { "a.txt": "from A\n" }, basedOn: base.id });
    assertEquals(first.forked, false, "the first successor is not a fork");
    const second = await writeWorkspace(c, { name: "race", owner: OWNER, files: { "a.txt": "from B\n" }, basedOn: base.id });
    assertEquals(second.forked, true, "the second one is, and says so at write time");

    const f = await forksOf(c, "race");
    assertEquals(f.forked, true);
    assertEquals(f.heads.length, 2, "both writes are heads; neither was overwritten");
    assertEquals(f.heads.map((h) => h.basedOn).filter((b) => b === base.id).length, 2, "and both name the same base");

    // Nothing was lost. Each head's content is still readable, which is the difference between
    // divergence and a lost write.
    const contents = new Set<string>();
    for (const h of f.heads) {
      contents.add(new TextDecoder().decode(await c.getArtifact(h.files[0].artifactId)));
    }
    assertEquals([...contents].sort(), ["from A\n", "from B\n"]);

    // `readWorkspace` still answers, and its answer is a CHOICE among heads rather than the truth.
    const cur = await readWorkspace(c, "race");
    assert(f.heads.some((h) => h.id === cur!.id), "it returns one of the heads");

    // `forked` means "this workspace HAS more than one head", not "I just created a second one".
    // The narrower reading missed the case that matters: the writer that lost the race keeps
    // working, unaware, on a head nobody else can see. A later write onto EITHER head still reports
    // it, because building on one does not resolve the other.
    const later = await writeWorkspace(c, {
      name: "race",
      owner: OWNER,
      files: { "a.txt": "from A again\n" },
      basedOn: first.id,
    });
    assertEquals(later.forked, true, "still forked after extending one side");
    assertEquals((await forksOf(c, "race")).heads.length, 2, "and there are still exactly two heads");
  });
});

Deno.test("workspace: a version chain is a DAG, so lineage walks a project's history", async () => {
  await withSpace(async (c) => {
    // `basedOn` alone makes the chain queryable; the EDGE makes it a graph. Without it, lineage on
    // a manifest showed nothing and "a visible fork in the DAG" was aspirational.
    await writeWorkspace(c, { name: "chain", owner: OWNER, files: { "a.txt": "1\n" } });
    const v1 = (await readWorkspace(c, "chain"))!;
    await writeWorkspace(c, { name: "chain", owner: OWNER, files: { "a.txt": "2\n" }, basedOn: v1.id });
    const v2 = (await readWorkspace(c, "chain"))!;
    await writeWorkspace(c, { name: "chain", owner: OWNER, files: { "a.txt": "3\n" }, basedOn: v2.id });
    const v3 = (await readWorkspace(c, "chain"))!;

    const ids = (await c.getLineage(v3.id)).map((n) => n.record.id);
    assert(ids.includes(v2.id) && ids.includes(v1.id), `lineage from the head reaches every version: ${ids.length} records`);

    // And downward: who superseded this one. That is the query fork detection is built on.
    const children = await c.getChildren(v1.id);
    assertEquals(children.map((r) => r.id), [v2.id]);
  });
});

// ── Phase 5: a sandbox as a record, with the probe that makes it worth anything ──────────────────

Deno.test("sandbox: the spec describes the jail runCode actually builds", () => {
  const bare = denoSandbox();
  assertEquals(bare.network, false);
  assertEquals(bare.processes, false);
  assertEquals(bare.env, false);
  assertEquals(bare.readonlyPaths, [], "no filesystem unless a caller granted roots");
  assertEquals(bare.writablePaths, [], "and no write, which is the posture every run had before workspaces");
  assert(bare.runtime.startsWith("deno "), "the runtime is named, because a guarantee is only as old as its build");

  // A configured jail describes what it GOT, not what was intended: a record that always claimed
  // "no filesystem" would be the prose problem with extra steps.
  const withTree = denoSandbox({ readRoots: ["/tmp/x"], writeRoots: ["/tmp/x"] });
  assertEquals(withTree.readonlyPaths, ["/tmp/x"]);
  assertEquals(withTree.writablePaths, ["/tmp/x"]);
});

Deno.test("sandbox: the probe actually tries to escape, and the jail holds", async () => {
  // A description nobody tested is a more convincing version of an unenforced sentence, because
  // structured data LOOKS authoritative. Each attempt is a real operation a program would make, and
  // the probe passes only when it FAILS inside the jail.
  const spec = denoSandbox();
  const results = await probeSandbox(spec);
  const claims = results.map((r) => r.claim).sort();
  assertEquals(claims, ["env", "filesystem", "network", "processes", "writable"], "every boolean claim is tested");
  for (const r of results) {
    assert(r.held, `the jail did not hold for ${r.claim}: ${r.detail}`);
  }
  assertEquals(await verifySandbox(spec), [], "nothing to report when every claim holds");

  // …and the probe is not vacuous: granting a capability makes the matching claim untestable rather
  // than passing silently, so a jail that CAN write is never reported as one that cannot.
  const open = denoSandbox({ writeRoots: ["/tmp"] });
  const openResults = await probeSandbox(open, { writeRoots: ["/tmp"] });
  assert(!openResults.some((r) => r.claim === "writable"), "a claim that was not made is not probed");
});

Deno.test("sandbox: a declaration is a record an operator can query and a policy can bind", async () => {
  await withSpace(async (c) => {
    await c.registerKind(SANDBOX_KIND);
    const spec = denoSandbox({ name: "deno-strict" });
    const { id } = await declareSandbox(c, spec);
    assert(id);

    // Content-keyed: a fleet restarting must not append a record per boot, because this registry is
    // read to decide what may execute and unbounded growth is what makes a bounded read dangerous.
    const again = await declareSandbox(c, spec);
    assertEquals(again.id, id, "the same jail declared twice is one record");

    const read = await readSandbox(c, "deno-strict");
    assertEquals(read!.isolation, "deno-permissions");
    assertEquals(read!.network, false);
    assertEquals((await listSandboxes(c)).length, 1, "one entry per name, latest wins");

    // THE reason this is a record rather than prose: a policy can bind the property that matters.
    const noNetwork = await c.query({ kind: "sandbox", match: { network: false } }, 10);
    assertEquals(noNetwork.length, 1, "'which of my sandboxes cannot reach the network' is a query");

    // A changed jail is a successor, not a conflict: the guarantee moved, and the old claim stays
    // readable so a verdict reached under it still means something.
    await declareSandbox(c, { ...spec, memoryMb: 64 });
    assertEquals((await readSandbox(c, "deno-strict"))!.memoryMb, 64);
    assertEquals((await c.query({ kind: "sandbox", match: { name: "deno-strict" } }, 10)).length, 2);
  });
});

// ── Phase 6: a second backend, and the reason the probe exists ───────────────────────────────────

Deno.test("sandbox: bubblewrap runs another language, and describes what it ACTUALLY got", async () => {
  const spec = bwrapSandbox({ command: ["python3", "-"], language: "python", name: "py" });
  assertEquals(spec.isolation, "bubblewrap");
  assertEquals(spec.language, "python");

  const r = await runBwrap("print(6*7)", { command: ["python3", "-"] });
  assert(r.ok, `bwrap python failed: ${r.stderr}`);
  assertEquals(r.stdout.trim(), "42");

  // The spec states the trade rather than flattering the jail. Making an interpreter reachable
  // means binding the host's /usr, so this jail sees a filesystem where the Deno one sees nothing
  // — measured at ~4 200 binaries against zero. A record claiming otherwise would be the prose
  // problem with extra steps.
  assert(spec.readonlyPaths.includes("/usr"), "the binds an interpreter needs ARE its filesystem");
  assertEquals(denoSandbox().readonlyPaths, [], "…and the Deno jail genuinely has none");

  // Likewise the ephemeral root: bwrap's root is a tmpfs, so a program CAN write. It reaches
  // nothing outside and vanishes with the process, but "cannot write" would be false, and the
  // probe caught exactly that claim on its first run.
  assert(spec.writablePaths.includes("/"), "an ephemeral writable root is declared, not hidden");
  assertEquals(denoSandbox().writablePaths, []);

  assertEquals(await verifySandbox(spec, { bwrap: { command: ["python3", "-"] } }), [], "and every claim it DOES make holds");
});

Deno.test("sandbox: the probe catches a jail that lies, which is why fail-open is survivable", async () => {
  // THE Phase 6 question. Under Deno, "no network" is the ABSENCE of --allow-net: forget every flag
  // and you get the safe answer. Under bubblewrap it is the PRESENCE of --unshare-net: forget one
  // and the jail is silently open while the record still says otherwise. Verified directly, outside
  // this code: a sealed jail refuses a socket, and the same jail without --unshare-all connects.
  //
  // That flip is the whole reason a declaration is probed rather than believed. A structured claim
  // nobody tested is MORE convincing than prose and no more true.
  const honest = bwrapSandbox({ command: ["python3", "-"], name: "sealed" });
  assertEquals(await verifySandbox(honest, { bwrap: { command: ["python3", "-"] } }), []);

  // The same spec — still claiming `network: false` — served by a jail built without the flag.
  const failed = await verifySandbox(honest, {
    bwrap: { command: ["python3", "-"], unshare: ["--unshare-user"] },
  });
  assertEquals(failed.map((f) => f.claim), ["network"], "the lie is caught, and NAMED");
  assert(failed[0].detail?.includes("succeeded"), "with what actually happened, so it is actionable");
});

Deno.test("sandbox: two backends coexist as records a policy can tell apart", async () => {
  await withSpace(async (c) => {
    await c.registerKind(SANDBOX_KIND);
    await declareSandbox(c, denoSandbox({ name: "js" }));
    await declareSandbox(c, bwrapSandbox({ command: ["python3", "-"], language: "python", name: "py" }));

    assertEquals((await listSandboxes(c)).length, 2);
    // The guarantee stopped being uniform, and that is now a QUERY rather than tribal knowledge:
    // an operator asking "which of these can reach a filesystem" gets an answer from the space.
    const byIsolation = await c.query({ kind: "sandbox", match: { isolation: "bubblewrap" } }, 10);
    assertEquals(byIsolation.length, 1);
    assertEquals((byIsolation[0].body as { language: string }).language, "python");

    // Both still claim no network, which is what makes them comparable at all…
    assertEquals((await c.query({ kind: "sandbox", match: { network: false } }, 10)).length, 2);
    // …and they differ on the axis that a latency table hides.
    const js = await readSandbox(c, "js");
    const py = await readSandbox(c, "py");
    assertEquals(js!.readonlyPaths.length, 0);
    assert(py!.readonlyPaths.length > 0, "one of these sees a filesystem and the other does not");
    assertEquals(js!.processes, false);
    assertEquals(py!.processes, true, "a namespace jail does not stop fork/exec the way permissions do");
  });
});
