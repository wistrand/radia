// The published site's claims, checked against the code they describe.
//
// `docs/` is nearly two thousand lines of assertions about a system that changes weekly, and it sits
// outside `agent_docs/`, where the "update the doc in the same change" convention lives. It was the
// only artifact here making claims with nothing checking them, and it had already drifted: the
// landing page's first copyable command named a binary no checkout has, and the SDK snippet below it
// imported `radia/sdk`, which is not a path the npm package contains. Both are the kind of mistake
// nobody finds by re-reading prose.
//
// STRUCTURAL ONLY, on purpose. Nothing here matches wording, because a test that fails when a
// sentence is rephrased gets deleted the third time it cries wolf. What it extracts is the parts of
// the page that are mechanically checkable: CLI verbs, import specifiers, links, external hosts.

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const docsDir = fromFileUrl(new URL("../docs/", import.meta.url));
const pages: { name: string; html: string }[] = [];
for await (const e of Deno.readDir(docsDir)) {
  if (e.isFile && e.name.endsWith(".html")) {
    pages.push({ name: e.name, html: await Deno.readTextFile(join(docsDir, e.name)) });
  }
}
// A site that lost its pages would pass every assertion below by vacuum.
assert(pages.length >= 5, `expected the docs site, found ${pages.length} pages`);

/** Text inside <pre> blocks, entity-decoded, which is where every command and code sample lives. */
function samples(html: string): string {
  return [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)]
    .map((m) => m[1])
    .join("\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

Deno.test("docs: every CLI verb the site shows is a verb the CLI has", async () => {
  const cli = await Deno.readTextFile(new URL("../src/surfaces/cli.ts", import.meta.url));
  const verbs = new Set([...cli.matchAll(/case "([a-z][a-z-]*)":/g)].map((m) => m[1]));
  assert(verbs.size > 10, "failed to extract the CLI's verbs; the switch may have been reshaped");

  const shown = new Set<string>();
  for (const p of pages) {
    // `radia <verb>`, however it is invoked: bare, `./radia`, or under a $ prompt.
    for (const m of samples(p.html).matchAll(/(?:^|\s|\$\s)\.?\/?radia\s+([a-z][a-z-]*)/gm)) {
      shown.add(m[1]);
      assert(
        verbs.has(m[1]),
        `${p.name} shows \`radia ${m[1]}\`, which is not a verb in src/surfaces/cli.ts`,
      );
    }
  }
  assert(shown.size > 0, "no CLI invocations found on the site; the extraction is broken");
});

Deno.test("docs: every `radia` import resolves through the npm package's exports map", async () => {
  // The site is the one place a reader meets the PACKAGE rather than the repo, so its import lines
  // are checked against the exports map the release script writes, not against `sdk/ts/` paths.
  const release = await Deno.readTextFile(new URL("../scripts/build-release.sh", import.meta.url));
  const exportsBlock = release.match(/"exports":\s*\{([\s\S]*?)\n {2}\}/);
  assert(exportsBlock, "could not find the npm exports map in scripts/build-release.sh");
  const map = new Map<string, string>();
  for (const m of exportsBlock[1].matchAll(/"([^"]+)":\s*"\.\/([^"]+)"/g)) map.set(m[1], m[2]);
  assert(map.has("."), "the npm package no longer exports a root entry point");

  let checked = 0;
  for (const p of pages) {
    for (const m of samples(p.html).matchAll(/import\s*\{([^}]*)\}\s*from\s*"(radia[^"]*)"/g)) {
      const [, names, specifier] = m;
      const subpath = specifier === "radia" ? "." : `.${specifier.slice("radia".length)}`;
      const target = map.get(subpath);
      assert(
        target,
        `${p.name} imports from "${specifier}", which the npm package does not export ` +
          `(it has ${[...map.keys()].join(", ")})`,
      );
      // Resolving the path is half the answer. `agentLoop` was importable from a specifier that
      // existed and exported everything except it.
      //
      // FOLLOWS `export *`, because the root entry point is a barrel: reading only the named
      // exports of `mod.ts` would fail every client symbol it re-exports wholesale, and making the
      // barrel restate each name is the duplicated statement it exists to avoid.
      const rel = target.replace(/^sdk\//, "");
      const sources: string[] = [];
      const load = async (file: string, depth = 0) => {
        const text = await Deno.readTextFile(new URL(`../sdk/ts/${file}`, import.meta.url));
        sources.push(text);
        if (depth > 2) return;
        for (const star of text.matchAll(/export\s*\*\s*from\s*"\.\/([^"]+)"/g)) await load(star[1], depth + 1);
      };
      await load(rel);
      const source = sources.join("\n");
      for (const name of names.split(",").map((n) => n.trim()).filter(Boolean)) {
        assert(
          new RegExp(`export\\s+(async\\s+)?(function|class|const|interface|type)\\s+${name}\\b`).test(source) ||
            new RegExp(`export\\s*(type\\s*)?\\{[^}]*\\b${name}\\b`).test(source),
          `${p.name} imports { ${name} } from "${specifier}", but sdk/ts/${rel} does not export it`,
        );
      }
      checked++;
    }
  }
  assert(checked > 0, "no SDK imports found on the site; the extraction is broken");
});

Deno.test("docs: internal links and anchors resolve", async () => {
  const ids = new Map<string, Set<string>>();
  for (const p of pages) {
    ids.set(p.name, new Set([...p.html.matchAll(/id="([^"]+)"/g)].map((m) => m[1])));
  }
  for (const p of pages) {
    for (const m of p.html.matchAll(/href="([^"]+)"/g)) {
      const href = m[1];
      if (href.startsWith("http") || href.startsWith("mailto:")) continue;
      const [path, anchor] = href.split("#");
      if (path) {
        assert(
          await Deno.stat(join(docsDir, path)).then(() => true, () => false),
          `${p.name} links to ${path}, which does not exist in docs/`,
        );
      }
      // A same-page anchor is the common case and the one that rots when a section is renamed.
      if (anchor && !path) {
        assert(ids.get(p.name)!.has(anchor), `${p.name} links to #${anchor}, which is not an id on that page`);
      }
    }
  }
});

Deno.test("docs: sidebar labels are the headings they navigate to", () => {
  const text = (html: string) =>
    html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").trim();

  for (const p of pages) {
    const sidebar = p.html.match(/<aside class="sidebar"[\s\S]*?<\/aside>/)?.[0];
    assert(sidebar, `${p.name} has no sidebar`);

    for (const link of sidebar.matchAll(/<a href="#([^"]+)">([\s\S]*?)<\/a>/g)) {
      const [, id, label] = link;
      const section = p.html.match(new RegExp(`<section[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/section>`))?.[1];
      assert(section, `${p.name}'s sidebar links #${id}, which is not a section`);
      const heading = section.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1];
      assert(heading, `${p.name}'s #${id} section has no h2`);
      assertEquals(text(label), text(heading), `${p.name}'s #${id} sidebar label drifted from its heading`);
    }
  }
});

Deno.test("docs: the site reaches no external host it has not declared", () => {
  // The console vendors and pins its one browser asset. The site does not go that far, but a NEW
  // third-party dependency should be a decision somebody makes rather than one that arrives in a
  // paste. Google Fonts is the one standing exception; adding another means adding it here.
  const allowed = ["github.com", "fonts.googleapis.com", "fonts.gstatic.com", "arxiv.org", "radia.sh"];
  for (const p of pages) {
    // ATTRIBUTES only. A URL inside a code sample is illustrative (`https://example.com/filing.pdf`)
    // and fetches nothing; what matters is what the browser is told to load or link to.
    for (const m of p.html.matchAll(/(?:href|src|content)="https?:\/\/([a-z0-9.-]+)/gi)) {
      const host = m[1].toLowerCase();
      assert(
        allowed.includes(host) || host.endsWith(".w3.org"),
        `${p.name} references ${host}; add it to the allowlist in this test if that is intended`,
      );
    }
  }
});

Deno.test("docs: every page carries the shared head furniture", () => {
  // Four of the five pages had no Open Graph tags at all, so a shared link previewed as a bare URL.
  for (const p of pages) {
    for (const tag of ['rel="icon"', 'property="og:title"', 'property="og:image"', 'property="og:url"']) {
      assert(p.html.includes(tag), `${p.name} is missing ${tag}`);
    }
    const title = p.html.match(/<title>([^<]*)<\/title>/);
    assert(title && title[1].trim().length > 0, `${p.name} has no <title>`);
  }
  // The card the og:image points at has to be in the published directory, not only in the source SVG.
  assert(pages.some((p) => p.html.includes("og.png")), "no page references the social card");
});

Deno.test("docs: no banned prose tells (agent_docs/plan-prose-tells.md)", () => {
  // The header says nothing here matches wording, and its reason stands: a test that fails on a
  // rephrase gets deleted the third time it cries wolf. This is the carve-out that keeps the
  // reason intact: a curated list of phrases with NO legitimate use in this site's prose (drumroll
  // idioms and unfalsifiable sweeps), plus the em dash the style rules already ban and this site
  // carried three of within days. A rephrase cannot trip it; only re-introducing a tell can.
  // Judgment tells ("genuinely", "honest", "this is where") stay OUT, deliberately: they have
  // semantic uses, and they belong to review, not to a grep.
  const banned = [
    "earns its keep",
    "nothing to offer",
    "worth pausing",
    "worth being pedantic",
    "the interesting part is",
    "surprisingly good",
    "genuine operational win",
    "pulls its weight",
    "—", // em dash
  ];
  const bad: string[] = [];
  const prose = (html: string) => html.replace(/<pre[\s\S]*?<\/pre>/g, "").replace(/<svg[\s\S]*?<\/svg>/g, "");
  for (const p of pages) {
    for (const phrase of banned) {
      if (prose(p.html).toLowerCase().includes(phrase)) bad.push(`${p.name}: "${phrase === "—" ? "em dash" : phrase}"`);
    }
  }
  const llms = Deno.readTextFileSync(join(docsDir, "llms.txt"));
  for (const phrase of banned) {
    if (llms.toLowerCase().includes(phrase)) bad.push(`llms.txt: "${phrase === "—" ? "em dash" : phrase}"`);
  }
  assertEquals(bad, [], "drumroll prose or an em dash on the site; see agent_docs/plan-prose-tells.md");
});

Deno.test("docs: the installer targets are targets the release actually builds", async () => {
  // `docs/install.sh` is served from the site and downloads assets `.github/workflows/release.yml`
  // uploads, so the triples and the asset naming are a contract between two files that live in
  // different directories and are edited for different reasons. Adding a `deno compile` target
  // without teaching the installer about it produces a release nobody on that platform can install.
  const script = await Deno.readTextFile(join(docsDir, "install.sh"));
  const build = await Deno.readTextFile(new URL("../scripts/build-release.sh", import.meta.url));
  const workflow = await Deno.readTextFile(new URL("../.github/workflows/release.yml", import.meta.url));

  const built = new Set([...build.matchAll(/^\s*"([a-z0-9_]+-[a-z0-9-]+)\s/gm)].map((m) => m[1]));
  assert(built.size >= 4, `failed to read the release targets, found ${[...built]}`);
  // The QUOTED value each case arm echoes, not a substring match: `aarch64-apple-darwin-oops`
  // contains a valid triple and is not one, which is exactly the typo this guard exists to catch.
  const offered = [...script.matchAll(/\)\s*echo "([a-z0-9_.-]+)" ;;/g)].map((m) => m[1]);
  assert(offered.length > 0, "install.sh names no targets; the extraction is broken");
  assertEquals(offered.filter((t) => !built.has(t)), [], "install.sh offers a target the release does not build");

  // The asset name and the sums file: the installer reads what the workflow writes.
  assert(script.includes("radia-$target.gz"), "install.sh no longer builds the asset name this test knows");
  assert(workflow.includes('radia-$target.gz"'), "release.yml no longer publishes radia-<target>.gz");
  for (const f of [script, workflow]) assert(f.includes("SHA256SUMS"), "one side dropped the checksum file");
});

Deno.test("docs: llms.txt lists every page, and every page is reachable from the nav", async () => {
  const llms = await Deno.readTextFile(join(docsDir, "llms.txt"));
  const index = pages.find((p) => p.name === "index.html")!;
  for (const p of pages) {
    assert(llms.includes(p.name), `llms.txt does not list ${p.name}`);
    // A page nobody links to is a page nobody reads. index.html is the target of its own brand link.
    assert(index.html.includes(`href="${p.name}"`), `${p.name} is not linked from the landing page`);
  }
  assertEquals(
    [...llms.matchAll(/\]\(([a-z-]+\.html)\)/g)].map((m) => m[1]).filter((f) => !pages.some((p) => p.name === f)),
    [],
    "llms.txt links a page that does not exist",
  );
});
