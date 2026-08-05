// Rendering the model's markdown while it is still arriving.
//
//   deno run -A examples/chat/smoke-markdown.ts
//
// The property this suite exists for is CHUNK INDEPENDENCE: the same text must render identically
// whether it arrives whole, a line at a time, or one character at a time. That is not a detail, it
// is the entire difficulty. Every construct here spans more than one character, so a renderer that
// gets it right on a complete string can still split `**` across two arrivals and emit a literal
// asterisk followed by a bold that never closes. Nothing about that is visible from reading the code
// or from trying it once by hand, because a real provider's chunks are large enough to hide it.
//
// So each case is rendered three ways and the results are compared to each other, not only to an
// expectation. The one-character run is the adversarial one.

import { MarkdownStream } from "./client/markdown.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

/** Render with a given chunking. `size` 0 means "all at once". */
function render(src: string, size = 0, colour = true): string {
  let out = "";
  const md = new MarkdownStream((s) => (out += s), { colour, width: 80 });
  if (size === 0) md.push(src);
  else for (let i = 0; i < src.length; i += size) md.push(src.slice(i, i + size));
  md.end();
  return out;
}

/** The same source at three chunk sizes. Equal, or the renderer is holding state wrong. */
function stable(name: string, src: string): string {
  const whole = render(src);
  const lines = render(src, 12);
  const chars = render(src, 1);
  const ok = whole === lines && whole === chars;
  check(
    `${name}: same whether whole or chunked`,
    ok,
    ok ? "" : `${whole === lines ? "one char at a time" : "12 at a time"} differs: ${JSON.stringify(whole === lines ? chars : lines)}`,
  );
  return whole;
}

const ESC = /\x1b\[[0-9;]*m/g;
/** What a person would see with the styling taken back off. */
const plain = (s: string) => s.replace(ESC, "");

// ---- inline ----

{
  const out = stable("bold", "a **strong** word\n");
  check("bold is styled", out.includes("\x1b[1mstrong"), JSON.stringify(out));
  check("…and its markers are gone", plain(out) === "a strong word\n", JSON.stringify(plain(out)));
}

{
  const out = stable("italic", "a *slanted* word and snake_case_name\n");
  check("italic is styled", out.includes("\x1b[3mslanted"), JSON.stringify(out));
  // The rule that exists because of how code looks: `_` inside a word is not a delimiter, or every
  // identifier in an answer comes out half italic.
  check("…and an underscore inside a word is not one", plain(out) === "a slanted word and snake_case_name\n", JSON.stringify(plain(out)));
}

{
  const out = stable("code span", "call `readRegistry()` first\n");
  check("inline code is styled", out.includes("\x1b[36mreadRegistry()"), JSON.stringify(out));
  check("…and its backticks are gone", plain(out) === "call readRegistry() first\n");
}

{
  const out = stable("escape", "a literal \\* asterisk\n");
  check("an escaped marker is literal", plain(out) === "a literal * asterisk\n", JSON.stringify(plain(out)));
}

{
  // A model that opens `**` and never closes it used to make the whole rest of the answer bold.
  const out = stable("unclosed span", "**never closed\n\nnext paragraph\n");
  const afterBlank = out.slice(out.indexOf("next paragraph"));
  check("an unclosed span does not escape its paragraph", !afterBlank.includes("\x1b[1m"), JSON.stringify(afterBlank));
  check("…and the terminal is left clean", out.trimEnd().endsWith("next paragraph") || out.includes("\x1b[0m"));
}

// ---- blocks ----

{
  const out = stable("heading", "## A heading\ntext\n");
  check("a heading is bold", out.includes("\x1b[1mA heading"), JSON.stringify(out));
  check("…without its hashes", plain(out) === "A heading\ntext\n", JSON.stringify(plain(out)));
}

{
  const out = stable("bullets", "- first\n- second\n");
  check("bullets become bullets", plain(out) === "• first\n• second\n", JSON.stringify(plain(out)));
}

{
  const out = stable("ordered", "1. first\n2. second\n");
  check("numbers are kept", plain(out) === "1. first\n2. second\n", JSON.stringify(plain(out)));
}

{
  const out = stable("nested", "- top\n  - under\n");
  check("nesting keeps its indent", plain(out) === "• top\n  • under\n", JSON.stringify(plain(out)));
}

{
  const out = stable("quote", "> quoted\n");
  check("a quote gets a bar", plain(out) === "│ quoted\n", JSON.stringify(plain(out)));
}

{
  const out = stable("rule", "before\n\n---\n\nafter\n");
  check("a rule is drawn", plain(out).includes("────"), JSON.stringify(plain(out)));
  // `---` is also three of a list marker, so the order of those two tests is load-bearing.
  check("…not read as a list", !plain(out).includes("• --"), JSON.stringify(plain(out)));
}

// ---- fences ----

{
  const src = "here:\n```ts\nconst x = **not bold**;\n```\ndone\n";
  const out = stable("fence", src);
  check("code inside a fence is styled as code", out.includes("\x1b[36mconst x"), JSON.stringify(out));
  // The whole point of suppressing inline parsing in a fence: code is full of asterisks and
  // underscores, and mangling it is worse than not rendering it at all.
  check(
    "…and its markdown is left alone, byte for byte",
    plain(out).includes("const x = **not bold**;"),
    JSON.stringify(plain(out)),
  );
  check("the language is shown", plain(out).includes("ts"), JSON.stringify(plain(out)));
  check("prose after the fence renders again", plain(out).endsWith("done\n"));
}

{
  // A fence the model never closed. It must not swallow the rest of the session's styling state.
  const out = stable("unclosed fence", "```\nx = 1\n");
  check("an unclosed fence still ends clean", out.endsWith("\x1b[0m") || plain(out).endsWith("x = 1\n"), JSON.stringify(out.slice(-20)));
}

// ---- links ----

{
  const out = stable("link", "see [the docs](https://example.com/x) now\n");
  check("a link keeps both halves", plain(out) === "see the docs https://example.com/x now\n", JSON.stringify(plain(out)));
  check("…with the URL dimmed", out.includes("\x1b[2m https://example.com/x"), JSON.stringify(out));
}

{
  // A bracket that is not a link must not hold the answer hostage waiting for a `)`.
  const out = stable("bracket", "an [aside] in prose\n");
  check("a bare bracket is passed through", plain(out) === "an [aside] in prose\n", JSON.stringify(plain(out)));
}

// ---- tables ----

{
  const src = "| tool | who |\n|---|---|\n| calc | tools |\n| draw | images |\n\nafter\n";
  const out = stable("table", src);
  const rows = plain(out).split("\n");
  check("the header is padded to the widest cell", rows[0] === "tool  who", JSON.stringify(rows[0]));
  check("…with a rule under it", /^─+ +─+$/.test(rows[1]), JSON.stringify(rows[1]));
  check("…and the columns line up", rows[2] === "calc  tools" && rows[3] === "draw  images", JSON.stringify(rows.slice(2, 4)));
  check("the header is bold", out.includes("\x1b[1mtool"), JSON.stringify(out.slice(0, 40)));
  check("prose after the table renders again", plain(out).endsWith("after\n"), JSON.stringify(plain(out).slice(-10)));
}

{
  // Too wide to align is a real case (a query result), and wrapping a table at an arbitrary column
  // is harder to read than the source it came from.
  const wide = `| a | b |\n|---|---|\n| ${"x".repeat(90)} | y |\n`;
  const out = render(wide);
  check("a table too wide for the window is left as written", plain(out).includes(`| ${"x".repeat(90)} | y |`));
}

// ---- plain text is not touched ----

{
  const src = "Just an ordinary sentence, with a comma and a period.\n";
  check("prose is passed through unchanged", render(src) === src, JSON.stringify(render(src)));
  check("…and one character at a time is the same", render(src, 1) === src);
}

{
  // With colour off the structure still renders; this is what a `TERM=dumb` or NO_COLOR terminal
  // gets, and it must not contain a single escape byte.
  const out = render("## Head\n- one\n", 1, false);
  check("no colour means no escapes at all", !out.includes("\x1b"), JSON.stringify(out));
  check("…but the structure is still there", out === "Head\n• one\n", JSON.stringify(out));
}

// ---- every construct at once, split every which way ----
//
// The cases above each exercise one thing at a chunk size chosen by hand, and both bugs this suite
// found survived that: one needed a `_` to land at the start of an empty buffer, the other needed a
// closing fence and its newline to arrive separately. Neither is a size anyone would pick. So the
// last case is a realistic answer, split at four hundred pseudo-random boundaries, compared against
// itself. Deterministic on purpose, because a fuzz that fails once a week is a fuzz nobody trusts.
{
  const src = `Here is what I found.

## Summary
The **loop** is in \`space.ts\`, and it uses *keyset* paging with snake_case_names.

1. read the page
2. dedupe by \`id\`
   - newest wins
   - retired dropped

\`\`\`ts
const x = **not** _markdown_;
if (a_b) { return [1,2]; }
\`\`\`

| kind | count |
|---|---|
| message | 1204 |
| llm_call | 88 |

> A quote with **bold** in it.

See [the docs](https://example.com/a) for more. Done.
`;
  const chunked = (parts: string[]) => {
    let out = "";
    const md = new MarkdownStream((s) => (out += s), { colour: true, width: 80 });
    for (const p of parts) md.push(p);
    md.end();
    return out;
  };
  const whole = chunked([src]);
  let mismatch = -1;
  for (let trial = 0; trial < 400 && mismatch < 0; trial++) {
    const parts: string[] = [];
    let seed = (trial * 2654435761) % 2147483647;
    for (let i = 0; i < src.length;) {
      seed = (seed * 48271) % 2147483647;
      const n = 1 + (seed % 25);
      parts.push(src.slice(i, i + n));
      i += n;
    }
    if (chunked(parts) !== whole) mismatch = trial;
  }
  check("400 random chunkings of a full answer render identically", mismatch < 0, mismatch < 0 ? "" : `first mismatch at trial ${mismatch}`);
  check("…and that answer actually used every construct", /Summary/.test(plain(whole)) && plain(whole).includes("• newest wins") && plain(whole).includes("message   1204"), JSON.stringify(plain(whole).slice(0, 60)));
}

console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
