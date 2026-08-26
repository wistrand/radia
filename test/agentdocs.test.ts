// `agent_docs/` checked structurally, which nothing did (audit package W7's second promised guard).
//
// The published site has had `docs.test.ts` since it drifted within a week of being written. The
// design docs had nothing, and they are the ones an agent is told to read FIRST: CLAUDE.md routes
// every task through them, so a stale pointer there is followed rather than noticed. The whole cost
// of that gap is on the record: the OpenAPI info block called OIDC, keyset cursors and the event-log
// sweep unbuilt for three audit rounds while the same file documented all three, and a round-two
// refutation closed the finding by searching for the report's phrasing instead of the claim.
//
// What is checkable here is deliberately narrow. Prose quality is review's job and a grep that
// cries wolf gets deleted (plan-prose-tells.md). These two are mechanical: a link that resolves,
// and a source path that exists. Both fail the same way when a file is renamed, which is the
// commonest way these docs go stale.

import { assert, assertEquals } from "@std/assert";
import { dirname, join, normalize } from "@std/path";

const ROOT = new URL("../", import.meta.url).pathname;
const DOCS = join(ROOT, "agent_docs");

async function markdownFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(DOCS)) if (e.isFile && e.name.endsWith(".md")) out.push(join(DOCS, e.name));
  out.push(join(ROOT, "CLAUDE.md"));
  return out.sort();
}

const exists = async (p: string) => await Deno.stat(p).then(() => true, () => false);

Deno.test("agent_docs: every relative link resolves", async () => {
  const bad: string[] = [];
  for (const file of await markdownFiles()) {
    const text = await Deno.readTextFile(file);
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const path = normalize(join(dirname(file), target.split("#")[0]));
      if (!await exists(path)) bad.push(`${file.slice(ROOT.length)} -> ${target}`);
    }
  }
  assertEquals(bad, [], "dead links in the docs an agent is told to read first");
});

/**
 * Does `.gitignore` cover this path? BUILD OUTPUTS ARE NOT SOURCE, and requiring them to exist is
 * the difference between a guard that catches drift and one that fails in CI for a reason nothing
 * to do with the change: `examples/chat/web/app.js` and `docs/playground/radia-jail.js` are real
 * files locally and absent from every fresh checkout, so this test went red on its first CI run
 * while passing on the machine that wrote it.
 *
 * Deliberately a SMALL matcher, covering the three forms this repo's ignore file uses: a rooted
 * path, a directory prefix, and a `*` glob. It is not gitignore semantics; anything it cannot read
 * simply is not skipped, which fails toward reporting rather than toward silence.
 */
function ignored(patterns: string[], path: string): boolean {
  for (const raw of patterns) {
    const rooted = raw.startsWith("/");
    const pat = rooted ? raw.slice(1) : raw;
    if (pat.endsWith("/")) {
      const dir = pat.slice(0, -1);
      if (path === dir || path.startsWith(`${dir}/`) || (!rooted && path.includes(`/${dir}/`))) return true;
      continue;
    }
    if (pat.includes("*")) {
      const re = new RegExp(`^${pat.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
      if (re.test(path) || (!rooted && path.split("/").some((seg) => re.test(seg)))) return true;
      continue;
    }
    if (path === pat || (!rooted && (path.endsWith(`/${pat}`) || path.split("/").includes(pat)))) return true;
  }
  return false;
}

Deno.test("agent_docs: every source path a doc names exists", async () => {
  // Backticked paths only, and only ones that look like a file in this repo: prose here is full of
  // `symbol` and `kind_def`, so the pattern requires a directory prefix and an extension. A path
  // that stops matching because a file moved is exactly the drift this catches.
  const gitignore = (await Deno.readTextFile(join(ROOT, ".gitignore")))
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const bad: string[] = [];
  const pathish = /`((?:src|sdk|extensions|examples|test|docs|scripts|bench|openapi|docker)\/[\w./-]+\.\w+)`/g;
  for (const file of await markdownFiles()) {
    const text = await Deno.readTextFile(file);
    for (const m of text.matchAll(pathish)) {
      if (ignored(gitignore, m[1])) continue; // a build output; naming one is legitimate
      if (!await exists(join(ROOT, m[1]))) bad.push(`${file.slice(ROOT.length)} names ${m[1]}`);
    }
  }
  assertEquals(bad, [], "these docs point at source files that do not exist");
});

Deno.test("agent_docs: the ignore-aware skip covers build outputs and nothing else", () => {
  // Proved directly, because the skip is the part that can silently widen until the guard checks
  // nothing. The two on the left are what turned CI red; the rest must still be checked.
  const patterns = ["/examples/chat/web/app.js", "/docs/playground/vendor/", "/radia", "*.db", "__pycache__/"];
  assert(ignored(patterns, "examples/chat/web/app.js"), "a rooted build output is not skipped");
  assert(ignored(patterns, "docs/playground/vendor/pglite.js"), "a file under an ignored directory is not skipped");
  assert(ignored(patterns, "space.db") && ignored(patterns, "a/b/space.db"), "an unrooted glob should match at any depth");
  assert(ignored(patterns, "sdk/py/__pycache__/x.pyc"), "an unrooted directory should match at any depth");

  assert(!ignored(patterns, "src/core/space.ts"), "ordinary source must still be checked");
  assert(!ignored(patterns, "examples/chat/web/app.ts"), "the SOURCE beside a build output must still be checked");
  assert(!ignored(patterns, "docs/playground/index.html"), "a tracked file in a partly-ignored directory must still be checked");
});

Deno.test("agent_docs: the frozen contract's own status paragraph is checked against its paths", async () => {
  // The specific three-round failure this file exists for. The info block lists what is NOT built;
  // naming something there that the same file documents as a path is the contradiction that
  // survived two audits, once because a refutation searched for a phrase rather than the claim.
  const yaml = await Deno.readTextFile(join(ROOT, "openapi/radia.yaml"));
  const notYet = yaml.match(/Not implemented yet:([^.]*)\./)?.[1] ?? "";
  assert(notYet.trim().length > 0, "the info block no longer says what is unbuilt; update this guard with it");

  const paths = new Set([...yaml.split("\npaths:", 2)[1].matchAll(/^ {2}(\/\S*):\s*$/gm)].map((m) => m[1]));
  // Each claim of absence, mapped to the evidence that would refute it.
  const evidence: { claim: string; refutedBy: () => boolean; how: string }[] = [
    { claim: "OIDC", refutedBy: () => paths.has("/sessions/oidc"), how: "the /sessions/oidc path is documented" },
    { claim: "keyset query cursor", refutedBy: () => /^\s+cursor:/m.test(yaml), how: "a `cursor` request field is documented" },
    { claim: "event-log sweep", refutedBy: () => /eventRetentionSeconds/.test(yaml), how: "eventRetentionSeconds is documented" },
  ];
  const contradictions = evidence
    .filter((e) => notYet.toLowerCase().includes(e.claim.toLowerCase()) && e.refutedBy())
    .map((e) => `info says '${e.claim}' is not implemented, but ${e.how}`);
  assertEquals(contradictions, [], "the contract's status paragraph contradicts the contract");
});

/**
 * The status class a piece of prose asserts, or undefined when it asserts none. BUILT wins over
 * PLANNED deliberately: every partial marker in these docs is a build ("PHASES 0-5 AND 7 BUILT",
 * "ITEMS 1-3 BUILT"), and reading one as planned would flag work that shipped.
 */
function statusClass(text: string): "built" | "planned" | undefined {
  if (/\b(BUILT|DONE)\b/i.test(text)) return "built";
  if (/\bPLANNED\b/i.test(text)) return "planned";
  return undefined;
}

Deno.test("agent_docs: CLAUDE.md's status marker agrees with the doc's own", async () => {
  // The third instance of one shape, after the OpenAPI info block and a refutation that searched
  // for a phrase. A doc's status lives in two places, and shipping edits the doc, the code, and a
  // summary line in a fourth file that names no owner, so the summary is what goes stale: found
  // saying PLANNED for encryption (built 2026-08-16), the substrate rename (done 2026-08-18) and
  // registry-cost, whose OWN entry said "ITEMS 1-3 BUILT" a sentence later.
  const claude = await Deno.readTextFile(join(ROOT, "CLAUDE.md"));
  const bad: string[] = [];
  for (const file of await markdownFiles()) {
    const name = file.slice(DOCS.length + 1);
    if (!file.startsWith(DOCS)) continue;
    const doc = await Deno.readTextFile(file);
    // The doc's own header, which sits at the top where an editor of that doc cannot miss it.
    const header = doc.match(/^\*\*Status:\s*([^*]*)\*\*/m)?.[1];
    if (!header) continue;
    // CLAUDE.md's lead: the entry is one long line, so a whole-entry search would hit any BUILT
    // deep in its prose. Only the segment before the first break is the claim being made.
    const entry = claude.match(new RegExp(`\\]\\(agent_docs/${name.replace(/\./g, "\\.")}\\):\\s*([^\\n]*)`))?.[1];
    if (!entry) continue;
    const lead = entry.split(/[,.(:]/)[0];
    const want = statusClass(header), got = statusClass(lead);
    if (want && got && want !== got) {
      bad.push(`CLAUDE.md calls ${name} '${lead.trim()}' but the doc says '${header.trim()}'`);
    }
  }
  assertEquals(bad, [], "the routing file disagrees with the doc it routes to");
});
