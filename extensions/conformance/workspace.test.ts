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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../../examples/operator.ts";
import {
  captureWorkspace,
  editWorkspace,
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

Deno.test("workspace: materialising an erased payload names the PATH, not just the artifact", async () => {
  await withSpace(async (c) => {
    const ws = await writeWorkspace(c, { name: "erased-mat", owner: OWNER, files: { "ok.txt": "fine\n", "gone.txt": "SECRET\n" } });
    await c.shredArtifact(ws.files.find((f) => f.path === "gone.txt")!.artifactId, {
      acknowledgeShared: true,
      reason: "leaked",
    });
    const manifest = (await readWorkspace(c, "erased-mat"))!;
    let message = "";
    try {
      await materialize(c, manifest, await Deno.makeTempDir());
    } catch (e) {
      message = (e as Error).message;
    }
    // "this artifact's content was destroyed" alone leaves the caller holding an id and a tree it
    // may never have listed. The path is the only part anyone can act on.
    assert(message.includes("gone.txt"), `expected the path in: ${message}`);
    assert(message.includes("ERASED"), message);
    // …and what to DO, because an erased payload is permanent and a retry is wasted effort.
    assert(message.includes("successor"), message);
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

Deno.test("workspace: an edit changes what it names and keeps every artifact it does not", async () => {
  await withSpace(async (c) => {
    const v1 = await writeWorkspace(c, {
      name: "edited",
      owner: OWNER,
      files: { "main.py": "print(1)\n", "lib.py": "X = 1\n", "README.md": "docs\n" },
    });
    const r = await editWorkspace(c, {
      name: "edited",
      edits: [{ path: "main.py", oldString: "print(1)", newString: "print(2)" }],
    });
    assertEquals(r.changed, ["main.py"]);
    assertEquals(r.added, []);
    assertEquals(r.removed, []);

    // THE SAVING, and the only reason this exists: an untouched file keeps its EXISTING artifact, so
    // the cost of a change is the size of the change rather than the size of the tree.
    const before = new Map(v1.files.map((f) => [f.path, f.artifactId]));
    const after = new Map(r.files.map((f) => [f.path, f.artifactId]));
    assertEquals(after.get("lib.py"), before.get("lib.py"), "untouched files are not re-uploaded");
    assertEquals(after.get("README.md"), before.get("README.md"));
    assert(after.get("main.py") !== before.get("main.py"), "the edited file is a new artifact");

    assertEquals(new TextDecoder().decode(await c.getArtifact(after.get("main.py")!)), "print(2)\n");
    // One successor, based on the head, so the history is a chain rather than a pile.
    const versions = await c.query({ kind: "workspace", match: { name: "edited" } }, 10);
    assertEquals(versions.length, 2);
    assertEquals((await readWorkspace(c, "edited"))!.basedOn, v1.id);
  });
});

Deno.test("workspace: a non-unique match is REFUSED, which is the safety property", async () => {
  await withSpace(async (c) => {
    await writeWorkspace(c, { name: "dup", owner: OWNER, files: { "a.py": "x = 1\nx = 1\n" } });
    // Silently editing the wrong occurrence is what would make an edit worse than a rewrite, so a
    // count above one is an error and the message says how many, not "not found".
    const err = await assertRejects(
      () => editWorkspace(c, { name: "dup", edits: [{ path: "a.py", oldString: "x = 1", newString: "x = 2" }] }),
      Error,
    );
    assert(/appears 2 times/.test(err.message), err.message);
    assertEquals((await readWorkspace(c, "dup"))!.files.length, 1);
    assertEquals((await c.query({ kind: "workspace", match: { name: "dup" } }, 10)).length, 1, "nothing was written");

    // …and replaceAll is the explicit opt-in.
    const r = await editWorkspace(c, {
      name: "dup",
      edits: [{ path: "a.py", oldString: "x = 1", newString: "x = 2", replaceAll: true }],
    });
    assertEquals(
      new TextDecoder().decode(await c.getArtifact(r.files[0].artifactId)),
      "x = 2\nx = 2\n",
    );
  });
});

Deno.test("workspace: a batch is validated whole, reports EVERY problem, and writes nothing on failure", async () => {
  await withSpace(async (c) => {
    await writeWorkspace(c, { name: "batch", owner: OWNER, files: { "a.py": "keep\n", "b.py": "keep\n" } });
    const err = await assertRejects(
      () =>
        editWorkspace(c, {
          name: "batch",
          edits: [
            { path: "a.py", oldString: "keep", newString: "ok" }, // fine
            { path: "b.py", oldString: "absent", newString: "x" }, // not found
            { path: "gone.py", oldString: "a", newString: "b" }, // no such file
          ],
          add: { "a.py": "dup\n" }, // already exists
          remove: ["nope.py"], // not there
        }),
      Error,
    );
    // A caller that learns one problem per round trip fixes one problem per round trip.
    assert(/4 problems/.test(err.message), err.message);
    for (const fragment of ["b.py", "gone.py", "a.py: already exists", "nope.py"]) {
      assert(err.message.includes(fragment), `expected ${fragment} in:\n${err.message}`);
    }
    // Validate-then-write means there is no partial version to explain.
    assertEquals((await c.query({ kind: "workspace", match: { name: "batch" } }, 10)).length, 1);
  });
});

Deno.test("workspace: one batch mixing edit, add and remove is ONE version", async () => {
  await withSpace(async (c) => {
    await writeWorkspace(c, { name: "mixed", owner: OWNER, files: { "main.py": "old\n", "drop.py": "bye\n" } });
    // The unit is one LOGICAL change. "Add a module and wire it into main" is the ordinary shape of
    // a code change, and splitting it would make one change into two versions to sequence.
    const r = await editWorkspace(c, {
      name: "mixed",
      edits: [{ path: "main.py", oldString: "old", newString: "new" }],
      add: { "lib/util.py": "def helper(): ...\n" },
      remove: ["drop.py"],
    });
    assertEquals(r.changed, ["main.py"]);
    assertEquals(r.added, ["lib/util.py"]);
    assertEquals(r.removed, ["drop.py"]);
    assertEquals(r.files.map((f) => f.path), ["lib/util.py", "main.py"]);
    assertEquals((await c.query({ kind: "workspace", match: { name: "mixed" } }, 10)).length, 2, "one version, not three");
  });
});

Deno.test("workspace: expectDigest is optional, and oldString is already a precondition", async () => {
  await withSpace(async (c) => {
    const v1 = await writeWorkspace(c, { name: "pre", owner: OWNER, files: { "a.py": "one\n" } });
    const digest = v1.files[0].digest;
    await editWorkspace(c, { name: "pre", edits: [{ path: "a.py", oldString: "one", newString: "two" }] });

    // A stale digest is caught and NAMED, rather than merged.
    const err = await assertRejects(
      () =>
        editWorkspace(c, {
          name: "pre",
          edits: [{ path: "a.py", oldString: "two", newString: "three", expectDigest: digest }],
        }),
      Error,
    );
    assert(/re-read it before editing/.test(err.message), err.message);

    // …and WITHOUT the field, a change to the region still fails on its own, which is why the
    // precondition is optional: `oldString` is the specific staleness check that matters.
    await assertRejects(
      () => editWorkspace(c, { name: "pre", edits: [{ path: "a.py", oldString: "one", newString: "x" }] }),
      Error,
      "not found",
    );
  });
});

Deno.test("workspace: an edit inherits the tree's labels and refuses binary and erased files", async () => {
  await withSpace(async (c) => {
    await writeWorkspace(c, { name: "cls", owner: OWNER, files: { "a.py": "x\n" }, taint: ["file"] });
    const r = await editWorkspace(c, { name: "cls", edits: [{ path: "a.py", oldString: "x", newString: "y" }] });
    // Nothing explicit: the successor names its predecessor, so `computeTaint` unions (§10.0).
    assertEquals((await c.getRecord(r.id))!.runtimeMeta.taint, ["file"]);

    // A string replacement over decoded binary corrupts it silently, so refuse instead of mangling.
    await writeWorkspace(c, { name: "bin", owner: OWNER, files: { "b.dat": new Uint8Array([1, 0, 2]) } });
    await assertRejects(
      () => editWorkspace(c, { name: "bin", edits: [{ path: "b.dat", oldString: "\u0001", newString: "z" }] }),
      Error,
      "not a text file",
    );

    // And an erased payload says so, with the remedy, rather than failing as "not found".
    const ws = await writeWorkspace(c, { name: "gone", owner: OWNER, files: { "s.txt": "secret\n" } });
    await c.shredArtifact(ws.files[0].artifactId, { acknowledgeShared: true, reason: "leaked" });
    const err = await assertRejects(
      () => editWorkspace(c, { name: "gone", edits: [{ path: "s.txt", oldString: "secret", newString: "x" }] }),
      Error,
    );
    assert(/ERASED/.test(err.message), err.message);
  });
});

Deno.test("workspace: a line range replaces a region without re-emitting it, and needs a digest", async () => {
  await withSpace(async (c) => {
    const v1 = await writeWorkspace(c, {
      name: "ranged",
      owner: OWNER,
      files: { "a.py": "L1\nL2\nL3\nL4\nL5\n" },
    });
    const digest = v1.files[0].digest;

    // A position carries NO precondition of its own — line 2 is whatever line 2 currently is — so
    // the digest is what makes it safe, and it is required rather than encouraged.
    const err = await assertRejects(
      () => editWorkspace(c, { name: "ranged", edits: [{ path: "a.py", startLine: 2, endLine: 3, newString: "X\n" }] }),
      Error,
    );
    assert(/needs expectDigest/.test(err.message), err.message);

    // With one, the region goes away without ever being re-emitted — the saving that content
    // matching cannot give, since it would have to carry L2 and L3 verbatim.
    const r = await editWorkspace(c, {
      name: "ranged",
      edits: [{
        path: "a.py",
        startLine: 2,
        endLine: 3,
        newString: "TWO\nTHREE\nEXTRA\n",
        expectDigest: digest,
        expectFirstLine: "L2",
        expectLastLine: "L3",
      }],
    });
    assertEquals(
      new TextDecoder().decode(await c.getArtifact(r.files[0].artifactId)),
      "L1\nTWO\nTHREE\nEXTRA\nL4\nL5\n",
    );
  });
});

Deno.test("workspace: ranges in one batch cannot overlap, and do not shift each other", async () => {
  await withSpace(async (c) => {
    const v1 = await writeWorkspace(c, { name: "multi", owner: OWNER, files: { "a.py": "1\n2\n3\n4\n5\n6\n" } });
    const digest = v1.files[0].digest;

    // Applying top-down would leave the second range pointing at whatever moved into its place, so
    // ranges apply DESCENDING. Both here are stated against the file the caller actually read.
    const r = await editWorkspace(c, {
      name: "multi",
      edits: [
        { path: "a.py", startLine: 2, endLine: 2, newString: "TWO\n", expectDigest: digest, expectFirstLine: "2" },
        { path: "a.py", startLine: 5, endLine: 5, newString: "FIVE\nFIVE-B\n", expectDigest: digest, expectFirstLine: "5" },
      ],
    });
    assertEquals(
      new TextDecoder().decode(await c.getArtifact(r.files[0].artifactId)),
      "1\nTWO\n3\n4\nFIVE\nFIVE-B\n6\n",
      "the earlier range did not move the later one",
    );

    // Overlap is refused rather than resolved: there is no correct answer and picking one silently
    // is the same class of mistake as a first-match replacement.
    const now = (await readWorkspace(c, "multi"))!.files[0].digest;
    const over = await assertRejects(
      () =>
        editWorkspace(c, {
          name: "multi",
          edits: [
            // Boundaries taken from the CURRENT file (1 / TWO / 3 / 4 / FIVE / FIVE-B / 6), so both
            // edits pass their content checks and the overlap is what refuses them. Guessing these
            // instead of reading them made the boundary check fire first and hid what was under test.
            { path: "a.py", startLine: 1, endLine: 3, newString: "A\n", expectDigest: now, expectFirstLine: "1", expectLastLine: "3" },
            { path: "a.py", startLine: 3, endLine: 4, newString: "B\n", expectDigest: now, expectFirstLine: "3", expectLastLine: "4" },
          ],
        }),
      Error,
    );
    assert(/overlap/.test(over.message), over.message);
  });
});

Deno.test("workspace: a range asserts WHAT it replaces, not only that the file is unchanged", async () => {
  await withSpace(async (c) => {
    // The failure this closes, from a live session: a model aimed at lines 7-15 believing they were
    // a `<style>` block. The digest matched — correctly, nothing had changed — and the edit also
    // removed `</head>`, `<body>`, a `<canvas>` and the opening of a `<script>`. `expectDigest`
    // proves the file has not moved; it cannot prove the range points where the caller meant.
    const v1 = await writeWorkspace(c, {
      name: "aim",
      owner: OWNER,
      files: { "page.html": "<head>\n<style>\nbody{}\n</style>\n</head>\n<body>\n<script>\n" },
    });
    const digest = v1.files[0].digest;

    // Aiming one line too far: the digest still matches, and the LAST-line assertion catches it.
    // That is the one that matters — a caller knows what it is starting at and miscounts where the
    // region ends.
    const err = await assertRejects(
      () =>
        editWorkspace(c, {
          name: "aim",
          edits: [{
            path: "page.html",
            startLine: 2,
            endLine: 5,
            newString: "ZZZZZ\n",
            expectDigest: digest,
            expectFirstLine: "<style>",
            expectLastLine: "</style>",
          }],
        }),
      Error,
    );
    assert(/expectLastLine does not match line 5/.test(err.message), err.message);
    assert(/found "<\/head>"/.test(err.message), err.message);

    // Omitting the assertion entirely is refused rather than silently allowed.
    const bare = await assertRejects(
      () =>
        editWorkspace(c, {
          name: "aim",
          edits: [{ path: "page.html", startLine: 2, endLine: 4, newString: "Z\n", expectDigest: digest }],
        }),
      Error,
    );
    assert(/needs expectFirstLine/.test(bare.message), bare.message);

    // Correctly aimed, it applies.
    const ok = await editWorkspace(c, {
      name: "aim",
      edits: [{
        path: "page.html",
        startLine: 2,
        endLine: 4,
        newString: "ZZZZZ\n",
        expectDigest: digest,
        expectFirstLine: "<style>",
        expectLastLine: "</style>",
      }],
    });
    assertEquals(
      new TextDecoder().decode(await c.getArtifact(ok.files[0].artifactId)),
      "<head>\nZZZZZ\n</head>\n<body>\n<script>\n",
    );
  });
});

Deno.test("workspace: the result SHOWS what changed, so it need not be described from intent", async () => {
  await withSpace(async (c) => {
    // A model announced "lines 8-14 are now ZZZZZ", describing the outcome from what it meant rather
    // than from what happened, and found only on a later read that the edit had removed more. A
    // bounded window costs a few dozen tokens and closes that in the same call.
    // Long enough that the bounding is observable: a five-line file with two lines of context IS the
    // whole file, so a shorter fixture would assert nothing.
    await writeWorkspace(c, {
      name: "shown",
      owner: OWNER,
      files: { "a.py": Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n" },
    });
    const r = await editWorkspace(c, {
      name: "shown",
      edits: [{ path: "a.py", oldString: "line 15", newString: "CHANGED" }],
    });
    assertEquals(r.preview.length, 1);
    assertEquals(r.preview[0].path, "a.py");
    const text = r.preview[0].text;
    // Numbered, so it feeds straight back into a follow-up range edit, and windowed rather than
    // echoing the file — which would undo the saving the whole operation exists for.
    assert(text.includes("CHANGED"), text);
    assert(/^\s+13\tline 13/.test(text), `two lines of context above:\n${text}`);
    assert(text.includes("line 17"), `and below:\n${text}`);
    assert(!text.includes("line 1\n") && !text.includes("line 30"), `bounded, not the whole file:\n${text}`);
  });
});

Deno.test("workspace: an edit names ONE form, and a pasted line-number prefix says so", async () => {
  await withSpace(async (c) => {
    const v1 = await writeWorkspace(c, { name: "forms", owner: OWNER, files: { "a.py": "alpha\nbeta\n" } });
    for (const [edit, fragment] of [
      [{ path: "a.py", newString: "x" }, "neither"],
      [{ path: "a.py", oldString: "alpha", newString: "x", startLine: 1, endLine: 1, expectDigest: v1.files[0].digest, expectFirstLine: "alpha" }, "both"],
    ] as const) {
      const err = await assertRejects(() => editWorkspace(c, { name: "forms", edits: [edit] }), Error);
      assert(err.message.includes(fragment), `expected ${fragment} in: ${err.message}`);
    }

    // Numbered reads are what make ranges usable, and they bring back the oldest failure in this
    // family: the caller pastes the `NNN\t` prefix along with the line. "Not found" alone sends them
    // hunting through whitespace, so the message names the actual cause.
    const err = await assertRejects(
      () => editWorkspace(c, { name: "forms", edits: [{ path: "a.py", oldString: "     1\talpha", newString: "x" }] }),
      Error,
    );
    assert(/line-number prefixes/.test(err.message), err.message);

    // A plain miss has to say what to DO. "Not found" alone sent a live session looking for a
    // missing permission, and the grant it then asked for broke the access it already had.
    const missed = await assertRejects(
      () => editWorkspace(c, { name: "forms", edits: [{ path: "a.py", oldString: "gamma", newString: "x" }] }),
      Error,
    );
    assert(/read the file with read_workspace/.test(missed.message), missed.message);
    assert(/NOT a permissions problem/.test(missed.message), missed.message);
  });
});

Deno.test("workspace: labels survive the RETURN trip, which is the leg the name promised", async () => {
  await withSpace(async (c) => {
    // The case above covers materialising OUT. It was named for a round trip and tested one leg, so
    // a write-back could have laundered and this suite would have stayed green. It does not — the
    // successor names its predecessor as a data parent, so `computeTaint` unions — but "it does not"
    // was an inference until something asserted it, and an audit read the missing assertion as a
    // hole (agent_docs/plan-audit-remediation.md, package R).
    await writeWorkspace(c, {
      name: "roundtrip",
      owner: OWNER,
      files: { "data.txt": "secret\n", "keep.txt": "untouched\n" },
      taint: ["file"],
    });
    const before = (await readWorkspace(c, "roundtrip"))!;

    const root = await Deno.makeTempDir({ prefix: "radia-roundtrip-" });
    try {
      await materialize(c, before, root);
      await Deno.writeTextFile(`${root}/data.txt`, "changed by a run\n");
      const cap = await captureWorkspace(c, before, root);
      const committed = (await commitWorkspace(c, before, cap))!;

      // THE ASSERTION. Nothing was passed explicitly; the label arrives on the parent edge.
      assertEquals((await c.getRecord(committed.id))!.runtimeMeta.taint, ["file"], "the successor inherits");

      // A result naming the successor inherits it too, which is how the exec worker's tool_result
      // stays classified (`parentIds: [..., wsParent]`).
      await c.registerKind({ kind: "run_result", indexedPaths: [], claimable: false });
      const result = await c.put({ kind: "run_result", body: { ok: true }, parentIds: [committed.id] });
      assertEquals((await c.getRecord(result.id))!.runtimeMeta.taint, ["file"]);

      // The file artifacts the write-back produced are BARE, on purpose: inheritance travels on the
      // graph, and a copy on every artifact is a denormalised graph fact that can drift from it.
      // An explicit RAISE is the other thing and still labels artifacts — see the case above, where
      // `writeWorkspace({taint})` does exactly that. Two mechanisms, not one inconsistently applied.
      const after = (await readWorkspace(c, "roundtrip"))!;
      const changed = after.files.find((f) => f.path === "data.txt")!;
      assertEquals((await c.getRecord(changed.artifactId))!.runtimeMeta.taint, []);
      // …while a file the run did not touch still points at the ORIGINAL artifact, which was raised.
      const kept = after.files.find((f) => f.path === "keep.txt")!;
      assertEquals((await c.getRecord(kept.artifactId))!.runtimeMeta.taint, ["file"]);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
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
