// What an edit costs versus rewriting the tree.
//
//   deno run --allow-net --allow-read --allow-write --allow-env --allow-run bench/edit-cost.ts
//
// Phase 10 of agent_docs/plan-workspaces.md was justified by a number nobody had taken. The claim
// was that whole-tree saves waste the MODEL's output tokens and nothing else, because the runtime
// already dedupes identical bytes. Two things are measured here: what the caller has to emit, and
// what the space actually stores.
//
// The emitted size is exact and needs no model — it is the JSON a caller must produce for the same
// change three ways. Token counts are ESTIMATED at four characters per token, which is the usual
// rough ratio for code and is stated rather than hidden; the ratios between the three are what the
// phase turns on and those are unaffected by the estimate.
//
// Nothing here asserts, like the rest of `bench/`.

import { RadiaClient } from "../sdk/ts/client.ts";
import { operatorToken } from "../examples/operator.ts";
import { editWorkspace, readWorkspace, writeWorkspace } from "../extensions/ts/workspace.ts";

const PORT = 7981;
const url = `http://127.0.0.1:${PORT}`;

/** A project of the size an agent actually builds: six files, ~500 lines. */
function project(): Record<string, string> {
  const body = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `    # ${tag} line ${i + 1}: some plausible statement here`).join("\n");
  return {
    "src/main.py": `import sys\nfrom src.parser import parse\nfrom src.util import setup\n\n\ndef main(argv):\n    cfg = setup(argv)\n    version = "1.0.0"\n${
      body(180, "main")
    }\n    return parse(cfg)\n\n\nif __name__ == "__main__":\n    sys.exit(main(sys.argv[1:]))\n`,
    "src/parser.py": `def parse(cfg):\n${body(110, "parse")}\n    return cfg\n`,
    "src/util.py": `def setup(argv):\n${body(55, "setup")}\n    return {}\n`,
    "tests/test_main.py": `from src.main import main\n\n\ndef test_main():\n${body(70, "test")}\n    assert main([]) is not None\n`,
    "README.md": `# demo\n\n${Array.from({ length: 25 }, (_, i) => `Paragraph ${i + 1} of the readme.`).join("\n")}\n`,
    "pyproject.toml": `[project]\nname = "demo"\nversion = "0.1.0"\n`,
  };
}

const est = (chars: number) => Math.round(chars / 4);
const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);

function row(label: string, chars: number, baseline: number): string {
  const ratio = baseline > 0 ? `${(baseline / chars).toFixed(1)}x cheaper` : "";
  return `  ${pad(label, 34)}${rpad(chars.toLocaleString(), 9)} chars ${rpad(`~${est(chars).toLocaleString()}`, 8)} tok  ${ratio}`;
}

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
for (const kind of ["workspace", "artifact"]) {
  await c.registerKind({
    kind,
    indexedPaths: [
      { path: "name", type: "keyword" },
      { path: "owner", type: "keyword" },
      { path: "conversationId", type: "keyword" },
      { path: "treeDigest", type: "keyword" },
      { path: "basedOn", type: "keyword" },
      { path: "digest", type: "keyword" },
      { path: "mediaType", type: "keyword" },
      { path: "workspace", type: "keyword" },
    ],
    claimable: false,
  });
}

const files = project();
const totalLines = Object.values(files).reduce((n, f) => n + f.split("\n").length, 0);
console.log(`\nA ${Object.keys(files).length}-file project, ${totalLines} lines, ${JSON.stringify(files).length.toLocaleString()} chars of source.\n`);

await writeWorkspace(c, { name: "proj", owner: "human:bench", files });
const head = (await readWorkspace(c, "proj"))!;
const mainDigest = head.files.find((f) => f.path === "src/main.py")!.digest;
const parserDigest = head.files.find((f) => f.path === "src/parser.py")!.digest;

// ── what the caller must emit ────────────────────────────────────────────────────────────────────
const wholeTree = JSON.stringify({ name: "proj", files });

console.log("CHANGE 1 — a one-line fix (bump a version string)");
const oneLineEdit = JSON.stringify({
  workspace: "proj",
  edits: [{ path: "src/main.py", old_string: '    version = "1.0.0"', new_string: '    version = "1.0.1"' }],
});
console.log(row("save_workspace (whole tree)", wholeTree.length, 0));
console.log(row("edit_workspace (string)", oneLineEdit.length, wholeTree.length));

console.log("\nCHANGE 2 — replace a 40-line block inside parser.py");
const oldBlock = Array.from({ length: 40 }, (_, i) => `    # parse line ${i + 1}: some plausible statement here`).join("\n");
const newBlock = "    # rewritten\n    return {'ok': True}";
const blockByString = JSON.stringify({
  workspace: "proj",
  edits: [{ path: "src/parser.py", old_string: oldBlock, new_string: newBlock }],
});
const blockByRange = JSON.stringify({
  workspace: "proj",
  edits: [{ path: "src/parser.py", start_line: 2, end_line: 41, new_string: newBlock, expect_digest: parserDigest }],
});
console.log(row("save_workspace (whole tree)", wholeTree.length, 0));
console.log(row("edit_workspace (string)", blockByString.length, wholeTree.length));
console.log(row("edit_workspace (line range)", blockByRange.length, wholeTree.length));

console.log("\nCHANGE 3 — add a module and wire it into main");
const addAndWire = JSON.stringify({
  workspace: "proj",
  edits: [{
    path: "src/main.py",
    old_string: "from src.util import setup",
    new_string: "from src.util import setup\nfrom src.cache import Cache",
  }],
  add: { "src/cache.py": "class Cache:\n    def __init__(self):\n        self.store = {}\n" },
});
console.log(row("save_workspace (whole tree)", wholeTree.length, 0));
console.log(row("edit_workspace (edit + add)", addAndWire.length, wholeTree.length));

// ── what the SPACE stores ────────────────────────────────────────────────────────────────────────
// The plan claimed this saving was zero, because identical bytes share a blob. Blobs do; artifact
// RECORDS do not, and `writeWorkspace` calls `putArtifact` once per file however little changed.
const count = async (kind: string) => (await c.queryAll({ kind })).length;
const artifactsBefore = await count("artifact");
const versionsBefore = await count("workspace");

const changed = { ...files, "src/main.py": files["src/main.py"].replace("1.0.0", "1.0.1") };
await writeWorkspace(c, { name: "proj", owner: "human:bench", files: changed, basedOn: head.id });
const afterSave = { artifacts: await count("artifact") - artifactsBefore, versions: await count("workspace") - versionsBefore };

const mid = await count("artifact");
const midV = await count("workspace");
await editWorkspace(c, {
  name: "proj",
  // camelCase: this is the EXTENSION api. The snake_case names are the chat tool's wire schema,
  // which is a separate layer and the one a model fills in.
  edits: [{ path: "src/main.py", oldString: '    version = "1.0.1"', newString: '    version = "1.0.2"' }],
});
const afterEdit = { artifacts: await count("artifact") - mid, versions: await count("workspace") - midV };

console.log("\nRECORDS WRITTEN for the same one-line change");
console.log(`  ${pad("save_workspace", 34)}${rpad(String(afterSave.artifacts), 9)} artifact records  ${afterSave.versions} manifest`);
console.log(`  ${pad("edit_workspace", 34)}${rpad(String(afterEdit.artifacts), 9)} artifact records  ${afterEdit.versions} manifest`);
console.log(
  `\n  Blobs dedupe by content, so no BYTES were duplicated either way. Artifact RECORDS do not:\n` +
    `  putArtifact is called once per file, so a whole-tree save appends one per file forever.\n`,
);

console.log(`(token counts estimated at 4 chars/token; the ratios do not depend on the estimate)\n`);
void mainDigest;
space.kill();
await space.status;
Deno.exit(0);
