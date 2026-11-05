// The `t1` tree digest against the vectors in agent_docs/design-hash-pinned-execution.md.
//
// `treeDigestOf` is normative (its own comment says so): an attestation computed by another
// language binding has to produce the same string. The spec's Appendix A is how that binding
// checks itself, so the vectors must be what this implementation computes, and the doc must still
// print them. Both halves are asserted here: compute each vector, then find it in the doc text, so
// neither the code nor the doc can drift alone.
//
// A.4 is the one that matters most. The lines sort in UTF-16 code-unit order (JavaScript's default
// sort), which differs from UTF-8 byte order above U+FFFF. An implementation that sorts bytes gets
// the "wrong" hash the doc also prints, so a failing implementer sees which mistake they made.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { sha256Hex, treeDigestOf, validatePath, type WorkspaceFile } from "../extensions/ts/workspace.ts";

const DOC = new URL("../agent_docs/design-hash-pinned-execution.md", import.meta.url);
const enc = (s: string) => new TextEncoder().encode(s);

async function file(path: string, content: string, mode: WorkspaceFile["mode"] = "100644"): Promise<WorkspaceFile> {
  return { path, mode, digest: await sha256Hex(enc(content)), artifactId: "unused" };
}

/** Every vector the doc prints, computed here. */
async function vectors(): Promise<Record<string, string>> {
  const empty = await treeDigestOf([]);
  const one = await treeDigestOf([await file("hello.txt", "hello\n")]);
  const three = await treeDigestOf([
    await file("app/main.py", "print('hi')\n"),
    await file("README", "x\n"),
    await file("run.sh", "#!/bin/sh\n", "100755"),
  ]);
  const astral = [await file("～", "a"), await file("\u{1F600}", "b")];
  const utf16 = await treeDigestOf(astral);
  // The trap, computed the wrong way on purpose: byte order puts U+FF5E (EF BD 9E) first.
  const byteSorted = astral
    .map((f) => `${f.path}\0${f.mode}\0${f.digest}`)
    .sort((a, b) => {
      const A = enc(a), B = enc(b);
      for (let i = 0; i < Math.min(A.length, B.length); i++) if (A[i] !== B[i]) return A[i] - B[i];
      return A.length - B.length;
    })
    .join("\n");
  const bytes = `t1:${await sha256Hex(enc(byteSorted))}`;
  const prefixes = await treeDigestOf([await file("a/b.txt", "1"), await file("a.txt", "2"), await file("a-b.txt", "3")]);
  const args = await treeDigestOf([await file("args.json", `{"n":3,"text":"hi"}`)]);
  return { "A.1": empty, "A.2": one, "A.3": three, "A.4": utf16, "A.4 byte-sorted": bytes, "A.5": prefixes, "A.8": args };
}

Deno.test("[treedigest] the empty tree is the hash of the empty string, and the blob digests are plain sha256", async () => {
  const v = await vectors();
  assertEquals(v["A.1"], "t1:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assertEquals(await sha256Hex(enc("hello\n")), "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03");
});

Deno.test("[treedigest] lines sort in UTF-16 order, so an astral path sorts before a BMP one that follows it in bytes", async () => {
  const v = await vectors();
  assert(v["A.4"] !== v["A.4 byte-sorted"], "the two sort orders must disagree, or the vector guards nothing");
  assertEquals(v["A.4"], "t1:30d7f394913443de80e0b2d8f2510787713b5a3e78787ee9ad258e5292f272d8");
  assertEquals(v["A.4 byte-sorted"], "t1:af1c71241ff5f71394bd16820873e7f9fcbde9d00f50971e3aec39a251d2d46a");
});

Deno.test("[treedigest] every Appendix A vector is what treeDigestOf computes, and the doc prints it", async () => {
  const doc = await Deno.readTextFile(DOC);
  const missing: string[] = [];
  for (const [name, hash] of Object.entries(await vectors())) {
    if (!doc.includes(hash)) missing.push(`${name}: ${hash}`);
  }
  assertEquals(missing, [], "the spec's vectors drifted from treeDigestOf; recompute them, never edit a hash by hand");
});

Deno.test("[treedigest] the spec's path rules (3.3) are the ones validatePath refuses", () => {
  for (const bad of ["", "/abs", "C:x", "a\\b", "a\0b", "a//b", "./a", "a/../b", "a.", "a /b", ".git/x", "a/.Git", "x".repeat(513)]) {
    assertThrows(() => validatePath(bad), Error, undefined, `expected refusal: ${JSON.stringify(bad)}`);
  }
  for (const ok of ["a", "a/b.txt", "\u{1F600}", "a-b", ".gitignore", "x".repeat(512)]) validatePath(ok);
});
