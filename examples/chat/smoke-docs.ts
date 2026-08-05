// Reading a documentation-sized corpus through the file tools.
//
//   deno run -A examples/chat/smoke-docs.ts
//
// The bug this exists for was a SILENT OMISSION, which is the kind a suite has to catch because
// nobody notices it by using the thing. `search_files` skipped any file over 64 KB, so on this
// repo's own `agent_docs` the two largest documents — `gotchas.md` (149 KB, the risk register and
// the answer to most "why is it like this" questions) and `plan-workspaces.md` (76 KB) — were
// invisible to every search, while every smaller file was covered. The answer came back short and
// looked complete.
//
// So the properties here are about COVERAGE and REACHABILITY rather than about matching: is a big
// file searched, and once something is found inside one, can it be read? A whole-file read stops at
// 64 KB, so a hit at line 2500 of a 149 KB document was a citation to somewhere the caller could
// not go.
//
// No space, no model, no network: these are pure functions over a directory, and the directory is
// this repository's own docs, which is the corpus the tools are actually pointed at.

import { makeTools } from "./tools/files.ts";
import { fromFileUrl } from "@std/path";

const docs = fromFileUrl(new URL("../../agent_docs", import.meta.url));
const tools = makeTools([docs]);

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

type Match = { file: string; line: number; section?: string; text: string };
type Search = { matches: Match[]; skipped?: { file: string; why: string }[]; capped?: string };
type Read = {
  found?: boolean;
  line?: number;
  truncated?: boolean;
  content: string;
  sections?: string[];
};
type Outline = { files: { file: string; headings: { level: number; text: string; line: number }[] }[] };

// The file the old skip hid, and a term that only appears inside it.
const big = "gotchas.md";
const size = (await Deno.stat(`${docs}/${big}`)).size;
check(`${big} is over the old 64 KB skip`, size > 64 * 1024, `${Math.round(size / 1024)} KB`);

const hits = await tools.search_files({ query: "fencing" }) as Search;
const inBig = hits.matches.filter((m) => m.file === big);
check("a file larger than the read cap is still searched", inBig.length > 0, `${inBig.length} hits in ${big}`);
check("…and nothing was dropped without saying so", hits.skipped === undefined, JSON.stringify(hits.skipped ?? null));

// Case-insensitive, because a corpus written in prose capitalises at the start of a sentence and a
// caller searching for a word should not have to guess which.
const upper = await tools.search_files({ query: "FENCING" }) as Search;
check("search is case-insensitive", upper.matches.length === hits.matches.length, `${upper.matches.length} vs ${hits.matches.length}`);

// The loop the whole change exists to close: find something in a large file, then read THAT part.
const where = inBig[0];
check("a match says which section it is in", Boolean(where?.section), where?.section ?? "(none)");
const section = await tools.read_file({ path: big, section: where.section }) as Read;
check("…and that section reads back complete", section.found === true && section.truncated === false, `${section.content.length} chars`);
check("…starting at its own heading", section.content.startsWith("#"), section.content.split("\n")[0].slice(0, 60));

// A whole-file read of the same document still truncates, and must hand over the way through
// rather than leaving the caller with two thirds of a file and no idea there is more.
const whole = await tools.read_file({ path: big }) as Read;
check("a whole-file read of a large document is still capped", whole.truncated === true);
check("…but it lists the sections that can be read individually", (whole.sections?.length ?? 0) > 0, `${whole.sections?.length ?? 0} sections`);

// A section that does not exist is not an error: the caller gets the list it should have asked
// from. A throw here would cost the turn and teach nothing, and the model's next guess would be as
// blind as the first.
const missing = await tools.read_file({ path: big, section: "no such heading anywhere" }) as { found: boolean; headings?: string[] };
check("an unknown section is reported, not thrown", missing.found === false);
check("…and it answers with the headings that DO exist", (missing.headings?.length ?? 0) > 0, `${missing.headings?.length ?? 0} offered`);

// The index. Its point is that the map is small enough to read even when the corpus is not.
const outline = await tools.outline({}) as Outline;
const headings = outline.files.reduce((n, f) => n + f.headings.length, 0);
check("the outline covers every document", outline.files.length >= 20, `${outline.files.length} files, ${headings} headings`);
const indexBytes = JSON.stringify(outline).length;
const corpusBytes = size; // one file, and already bigger than the whole index
check("the index is far smaller than the corpus it maps", indexBytes < corpusBytes, `${Math.round(indexBytes / 1024)} KB index`);

// Names from the index must be usable as-is. A path relative to anything but the sandbox root is a
// path that does not resolve, and the caller has no way to tell which it was given.
const named = outline.files.find((f) => f.file === big);
check("the index names files the way read_file takes them", Boolean(named));
const roundTrip = await tools.read_file({ path: named!.file, section: named!.headings[1].text }) as Read;
check("…so a heading from the index reads back", roundTrip.found === true, named!.headings[1].text);

// Narrowing to one file is what keeps the index cheap when a sandbox holds more than documentation.
const oneFile = await tools.outline({ path: big }) as Outline;
check("the index can be asked for one file", oneFile.files.length === 1 && oneFile.files[0].file === big);

console.log(failed === 0 ? "\nok" : `\n${failed} failed`);
if (failed > 0) Deno.exit(1);
