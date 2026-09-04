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

// The three guards below are what keeps CLAUDE.md the routing file its own Doc lifecycle section
// describes. On 2026-09-04 it was 21,439 words with a 14,882-character table cell and 39 em dashes
// in the file that bans them, because every change appended its lesson to the Layout cell of the
// file it touched and nothing measured the result. The site's prose guard (`test/docs.test.ts`)
// covered only the one corpus that was already clean.

/** Text that is being NAMED rather than used: a quoted phrase, or code in backticks. */
const unquoted = (text: string) => text.replace(/`[^`\n]*`/g, "").replace(/"[^"\n]*"/g, "");

Deno.test("agent_docs: no banned prose tells in the docs an agent reads", async () => {
  // The same curated list as the site's guard: phrases with no legitimate use, so a rephrase cannot
  // trip it. plan-prose-tells.md is the catalogue of them and is exempt.
  const banned = [
    "earns its keep",
    "nothing to offer",
    "worth pausing",
    "worth being pedantic",
    "the interesting part is",
    "surprisingly good",
    "genuine operational win",
    "pulls its weight",
  ];
  const bad: string[] = [];
  for (const file of await markdownFiles()) {
    if (file.endsWith("plan-prose-tells.md")) continue;
    const text = unquoted(await Deno.readTextFile(file)).toLowerCase();
    for (const phrase of banned) if (text.includes(phrase)) bad.push(`${file.slice(ROOT.length)}: "${phrase}"`);
  }
  assertEquals(bad, [], "drumroll prose in agent_docs or CLAUDE.md; see agent_docs/plan-prose-tells.md");
});

/**
 * Em dashes per file, as a LEDGER rather than a ban: 548 were in `agent_docs/` when this was
 * written, and a guard that fails on all of them at once is one that gets skipped. A file may
 * never gain one, and when a file loses some the ceiling must come down with it, so the table
 * stays the truth and the count only ever falls. A file not listed here has a ceiling of zero.
 * CLAUDE.md's one remaining instance is the style rule naming the character, in backticks.
 */
const EM_DASH_CEILING: Record<string, number> = {
  "architecture-analysis-workspace-agents.md": 3,
  "architecture-jail-confinement.md": 1,
  "architecture-ops-tiers.md": 1,
  "architecture-workspace-agents.md": 2,
  "design-api.md": 1,
  "design-auth.md": 14,
  "design-data-model.md": 14,
  "design-execution.md": 2,
  "design-inspection.md": 7,
  "design-observability.md": 2,
  "design-storage.md": 1,
  "design-taint.md": 2,
  "design-workspaces.md": 15,
  "gotchas.md": 0,
  "plan-audit-remediation.md": 89,
  "plan-browser-space.md": 5,
  "plan-chat-turn.md": 2,
  "plan-chat-web-ui.md": 7,
  "plan-delegation.md": 5,
  "plan-encryption.md": 41,
  "plan-extension-http.md": 3,
  "plan-gc.md": 35,
  "plan-inspection.md": 7,
  "plan-milestones.md": 8,
  "plan-oidc.md": 10,
  "plan-prose-tells.md": 1,
  "plan-reactor-loop.md": 7,
  "plan-scaling.md": 15,
  "plan-startup-ergonomics.md": 2,
  "plan-substrate-rename.md": 3,
  "plan-webworker-sandbox.md": 9,
  "plan-workspaces.md": 93,
  "research-app-lessons.md": 17,
  "research-positioning.md": 3,
};

Deno.test("agent_docs: em dashes never increase, and the ledger tracks every decrease", async () => {
  const bad: string[] = [];
  for (const file of await markdownFiles()) {
    const name = file.endsWith("CLAUDE.md") ? "CLAUDE.md" : file.slice(DOCS.length + 1);
    const raw = await Deno.readTextFile(file);
    const count = (name === "CLAUDE.md" ? unquoted(raw) : raw).split("—").length - 1;
    const ceiling = EM_DASH_CEILING[name] ?? 0;
    if (count > ceiling) bad.push(`${name}: ${count} em dashes, ceiling ${ceiling}; recast the new ones`);
    else if (count < ceiling) bad.push(`${name}: ${count} em dashes, ceiling ${ceiling}; lower EM_DASH_CEILING to ${count}`);
  }
  assertEquals(bad, [], "em dashes in the docs an agent reads (test/agentdocs.test.ts holds the ledger)");
});

Deno.test("agent_docs: CLAUDE.md stays a routing file", async () => {
  // Words and line length, both with headroom over the 2026-09-04 cut (6,892 words, 445 chars).
  // A Layout cell or a Docs bullet that needs more than a line is narrative that belongs in the
  // doc it links to; the Design principle and Invariants sections are the thick part by design.
  const text = await Deno.readTextFile(join(ROOT, "CLAUDE.md"));
  const words = text.split(/\s+/).filter(Boolean).length;
  assert(words <= 7500, `CLAUDE.md is ${words} words; the budget is 7500. Move detail into agent_docs/ and leave a link`);
  const long = text.split("\n").map((l, i) => [i + 1, l.length] as const).filter(([, n]) => n > 600);
  assertEquals(long.map(([i, n]) => `line ${i}: ${n} chars`), [], "a CLAUDE.md line over 600 characters is a cell carrying a doc");
});
