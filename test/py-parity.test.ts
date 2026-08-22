// The two SDKs must compute the SAME content key for the same body, or a TS writer and a Python
// writer of one registry entry each write their own record (sdk/README.md, "contentKey"). That
// agreement was by discipline until it broke: Python renders 1e-5 as "1e-05" where JavaScript
// writes "0.00001", and switches to exponent form two orders of magnitude earlier, so any body
// carrying a small float keyed differently and nothing noticed, because the suites were Deno-only.
//
// The corpus is RAW JSON TEXT, parsed independently by each side, so number semantics are each
// parser's own: "1.0" is the integer-rendered 1 in JavaScript and a float in Python, which is
// exactly the class of divergence under test. Values live here as strings, never as JS literals,
// or this file's own parser would canonicalize them before Python ever saw the difference.
//
// Skips when python3 (or the run permission) is absent rather than failing: the contract binds
// only where Python runs. CI's runners ship python3, so the skip is a local convenience, not a
// hole in the net.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { contentKey } from "../sdk/ts/registry.ts";
import { kindDefKey } from "../sdk/ts/wire.ts";

const pyDir = fromFileUrl(new URL("../sdk/py", import.meta.url));

const CORPUS: string[] = [
  // the axis that broke: float FORM, where both languages hold identical doubles
  '{"rate":0.00001}',
  '{"rate":1e-5}',
  '1e-6',
  '1e-7',
  '1.5e-7',
  '5e-324',
  '1.7976931348623157e308',
  '1e20',
  '1e21',
  '1.234e21',
  '0.30000000000000004',
  '-0.5',
  '-0.0',
  // integral floats: "1.0" must key as 1
  '{"n":1.0,"m":1}',
  '[2.0,-3.0,9007199254740992]',
  // strings: non-ASCII stays unescaped, control characters escape identically
  '{"name":"réco💚","note":"line\\nbreak\\u0000end"}',
  // key order: sorted, and sorted the way JavaScript sorts (UTF-16 code units, so the astral
  // character orders BEFORE U+FFFF)
  '{"b":1,"a":2,"aa":3,"A":4}',
  '{"\\uffff":1,"\\ud800\\udc00":2}',
  // structure: arrays keep order, nesting recurses, null/bool are themselves
  '{"deep":{"list":[1,[2,{"x":null}],true,false],"empty":{},"none":[]}}',
  '[]',
  'null',
  '"just a string"',
];

const hasPython = await (async () => {
  try {
    const out = await new Deno.Command("python3", { args: ["--version"], stdout: "null", stderr: "null" }).output();
    return out.success;
  } catch {
    return false; // no interpreter, or no --allow-run: either way the contract cannot be checked here
  }
})();

/** Runs a python3 one-liner against sdk/py with `input` on stdin, returning stdout or throwing stderr. */
async function py(script: string, input: string): Promise<string> {
  const child = new Deno.Command("python3", {
    args: ["-c", script],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(input));
  await w.close();
  const out = await child.output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout);
}

Deno.test({
  name: "sdk parity: content_key(py) === contentKey(ts) over one corpus of JSON texts",
  ignore: !hasPython,
  fn: async () => {
    const script = [
      "import json, sys",
      `sys.path.insert(0, ${JSON.stringify(pyDir)})`,
      "from radia import content_key",
      "texts = json.load(sys.stdin)",
      'print(json.dumps([content_key("t", json.loads(t)) for t in texts]))',
    ].join("\n");
    const pyKeys = JSON.parse(await py(script, JSON.stringify(CORPUS))) as string[];
    const tsKeys = await Promise.all(CORPUS.map((t) => contentKey("t", JSON.parse(t))));
    for (let i = 0; i < CORPUS.length; i++) {
      assertEquals(pyKeys[i], tsKeys[i], `keys diverge for ${CORPUS[i]}`);
    }
    assertEquals(pyKeys.length, tsKeys.length);
  },
});

Deno.test({
  name: "sdk parity: content_key refuses what no shared key can exist for",
  ignore: !hasPython,
  fn: async () => {
    // JSON.parse silently rounds 2**53+1 to 2**53; Python keeps it exact, so keying it would name
    // a value JavaScript can never produce. The Python side must refuse loudly, not diverge
    // quietly. Same for NaN and for values that are not JSON at all.
    const script = [
      "import json, sys",
      `sys.path.insert(0, ${JSON.stringify(pyDir)})`,
      "from radia import content_key",
      "refused = []",
      "for case in [9007199254740993, float('nan'), {1: 'non-string key'}, {'x': set()}]:",
      "    try:",
      "        content_key('t', case)",
      "        refused.append(False)",
      "    except (ValueError, TypeError):",
      "        refused.append(True)",
      "print(json.dumps(refused))",
    ].join("\n");
    const refused = JSON.parse(await py(script, "")) as boolean[];
    assertEquals(refused, [true, true, true, true]);
    // And the boundary itself is representable, so it still keys.
    const ok = await py(
      [
        "import sys",
        `sys.path.insert(0, ${JSON.stringify(pyDir)})`,
        "from radia import content_key",
        "print(content_key('t', 9007199254740992))",
      ].join("\n"),
      "",
    );
    assertEquals(ok.trim(), await contentKey("t", 9007199254740992));
    assert(ok.startsWith("t:"));
  },
});

/**
 * The SECOND normative pure function, added after a third audit found Python computing this one by
 * serializing the whole definition (`json.dumps(sort_keys=True)`). It agreed with TS by accident on
 * nothing: a kind declared from both SDKs appended two `kind_def` records instead of deduping, and
 * the parity suite could not see it because it covered `content_key` alone.
 *
 * The corpus is the shape space that decides the key: which optional fields are present, how the
 * two list fields sort, and the claimable/reference split.
 */
const KIND_DEFS = [
  { kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] },
  { kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }], claimable: false },
  // order must not matter: both sides sort
  { kind: "m", indexedPaths: [{ path: "b", type: "integer" }, { path: "a", type: "keyword" }] },
  { kind: "m", indexedPaths: [{ path: "a", type: "keyword" }, { path: "b", type: "integer" }] },
  { kind: "s", indexedPaths: [{ path: "i", type: "integer" }], sortablePaths: ["i"] },
  // the two fields that are OMITTED when absent, so an old key stays byte-identical
  { kind: "r", indexedPaths: [], contentKey: ["b", "a"] },
  { kind: "r", indexedPaths: [], defaultRetentionSeconds: 3600 },
  { kind: "r", indexedPaths: [], contentKey: ["a"], defaultRetentionSeconds: 60, claimable: false },
  { kind: "bare", indexedPaths: [] },
];

Deno.test({
  name: "sdk parity: kind_def_key(py) === kindDefKey(ts), or a kind declared twice is two records",
  ignore: !hasPython,
  fn: async () => {
    const script = [
      "import json, sys",
      `sys.path.insert(0, ${JSON.stringify(pyDir)})`,
      "from radia import kind_def_key",
      "defs = json.load(sys.stdin)",
      "print(json.dumps([kind_def_key(d) for d in defs]))",
    ].join("\n");
    const pyKeys = JSON.parse(await py(script, JSON.stringify(KIND_DEFS))) as string[];
    const tsKeys = KIND_DEFS.map((d) => kindDefKey(d as never));
    for (let i = 0; i < KIND_DEFS.length; i++) {
      assertEquals(pyKeys[i], tsKeys[i], `keys diverge for ${JSON.stringify(KIND_DEFS[i])}`);
    }
    // And the corpus has to be able to TELL keys apart, or agreement proves nothing.
    assertEquals(new Set(tsKeys).size, tsKeys.length - 1, "only the two order-permuted defs may share a key");
  },
});
