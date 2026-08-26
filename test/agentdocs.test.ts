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

Deno.test("agent_docs: every source path a doc names exists", async () => {
  // Backticked paths only, and only ones that look like a file in this repo: prose here is full of
  // `symbol` and `kind_def`, so the pattern requires a directory prefix and an extension. A path
  // that stops matching because a file moved is exactly the drift this catches.
  const bad: string[] = [];
  const pathish = /`((?:src|sdk|extensions|examples|test|docs|scripts|bench|openapi|docker)\/[\w./-]+\.\w+)`/g;
  for (const file of await markdownFiles()) {
    const text = await Deno.readTextFile(file);
    for (const m of text.matchAll(pathish)) {
      if (!await exists(join(ROOT, m[1]))) bad.push(`${file.slice(ROOT.length)} names ${m[1]}`);
    }
  }
  assertEquals(bad, [], "these docs point at source files that do not exist");
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
