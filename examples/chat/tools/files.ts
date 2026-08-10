// The chatbot's tools. read_file/list_files/search_files are sandboxed to a set of
// allowed root directories; the tool-worker that runs these has --allow-read scoped to
// exactly those roots and NO network except the local space, so even a prompt-injection
// that reads a file cannot exfiltrate it. Path canonicalization here is defense-in-depth
// on top of that OS-level sandbox.

import type { Tool, ToolContext } from "../../../extensions/ts/agent-tools.ts";
import { isAbsolute, join, SEPARATOR } from "@std/path";
import type { ToolDef } from "../provider/openrouter.ts";

const MAX_BYTES = 64 * 1024;

/**
 * How much of ONE file a search will read.
 *
 * Deliberately far above the read cap, because searching and reading are different jobs. This used
 * to be the same 64 KB, applied as a SKIP: any file over it was passed over silently, so the two
 * largest documents in `agent_docs` (`gotchas.md` at 149 KB, `plan-workspaces.md` at 76 KB) were
 * invisible to search while every smaller file was covered. A search that quietly omits the biggest
 * files is worse than one that refuses, because the caller reads a short answer as an exhaustive one.
 */
const SCAN_MAX = 4 * 1024 * 1024;

/** Most matches one search returns. A cap is fine; a cap nobody is told about is not. */
const MAX_MATCHES = 50;

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/** A markdown heading, as the index and the section reader both see it. */
interface Heading {
  level: number;
  text: string;
  line: number;
}

function headingsOf(text: string): Heading[] {
  const out: Heading[] = [];
  text.split("\n").forEach((ln, i) => {
    const m = HEADING.exec(ln);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
  });
  return out;
}

/** A file whose bytes are not text. Sniffed from a NUL in the first block, which is what every
 *  `grep` does and is enough to keep a search from tokenizing an image. */
function binary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/** The body under `heading`, down to the next heading of the same or higher level. */
function sectionOf(text: string, heading: string): { level: number; line: number; content: string } | null {
  const want = heading.trim().toLowerCase().replace(/^#+[ \t]*/, "");
  const lines = text.split("\n");
  const heads = headingsOf(text);
  const start = heads.find((h) => h.text.toLowerCase() === want) ??
    heads.find((h) => h.text.toLowerCase().includes(want));
  if (!start) return null;
  const end = heads.find((h) => h.line > start.line && h.level <= start.level);
  return {
    level: start.level,
    line: start.line,
    content: lines.slice(start.line - 1, end ? end.line - 1 : undefined).join("\n"),
  };
}

/** Resolve a requested path to a real path that is provably inside one of the roots. */
async function resolveInSandbox(roots: string[], path: string): Promise<string> {
  for (const root of roots) {
    const candidate = isAbsolute(path) ? path : join(root, path);
    try {
      const real = await Deno.realPath(candidate); // resolves .. and symlinks
      if (real === root || real.startsWith(root + SEPARATOR)) return real;
    } catch { /* not under this root */ }
  }
  throw new Error(`path_denied: ${path} is outside the allowed directories`);
}

async function walk(root: string, dir: string, fn: (real: string, rel: string) => Promise<void>): Promise<void> {
  for await (const e of Deno.readDir(dir)) {
    const real = join(dir, e.name);
    if (e.isDirectory) await walk(root, real, fn);
    else await fn(real, real.slice(root.length + 1));
  }
}

/** What a tool knows about the call it is serving, beyond its arguments. Optional so the file and
 *  compute tools can ignore it; the ones that WRITE records use `callId` for lineage. */
// Owned by `extensions/ts/agent-tools.ts`: a tool's calling convention is not this app's to define.
export type { Tool, ToolContext };

export function makeTools(roots: string[]): Record<string, Tool> {
  return {
    read_file: async (a) => {
      const path = String(a.path ?? "");
      const want = a.section === undefined ? undefined : String(a.section);
      const real = await resolveInSandbox(roots, path);
      const info = await Deno.stat(real);
      if (!info.isFile) throw new Error(`not a file: ${path}`);
      const bytes = await Deno.readFile(real);
      const whole = new TextDecoder().decode(bytes);

      // ONE SECTION, which is what makes a large document readable at all. The whole-file path caps
      // at 64 KB, so `gotchas.md` (149 KB) could only ever be read as its first third; a caller that
      // searched it and got a hit at line 2500 had no way to reach the hit. `search_files` and
      // `outline` both return the enclosing heading for exactly this call.
      if (want !== undefined) {
        const found = sectionOf(whole, want);
        if (!found) {
          return { path, section: want, found: false, headings: headingsOf(whole).map((h) => h.text) };
        }
        const cut = found.content.length > MAX_BYTES;
        return {
          path,
          section: want,
          found: true,
          line: found.line,
          truncated: cut,
          content: cut ? found.content.slice(0, MAX_BYTES) : found.content,
        };
      }

      const truncated = bytes.length > MAX_BYTES;
      return {
        path,
        size: info.size,
        modified: info.mtime?.toISOString() ?? null,
        truncated,
        // Truncation is where a caller silently loses most of a large file, so hand it the way out
        // in the same answer: the headings it can ask for by name.
        ...(truncated ? { sections: headingsOf(whole).map((h) => h.text) } : {}),
        content: new TextDecoder().decode(truncated ? bytes.slice(0, MAX_BYTES) : bytes),
      };
    },

    /**
     * The heading index: every section of every markdown file, with its line.
     *
     * Retrieval over a corpus this size is a NAVIGATION problem rather than a search one. Measured
     * on `agent_docs`: 23 files, 281 headings, the whole index 9.5 KB (~2,400 tokens), while a
     * single-keyword search over the same corpus returns a third of it unranked (the word "record"
     * appears in 65% of sections). A model that can see the map picks the section itself.
     */
    outline: async (a) => {
      const dir = a.path ? String(a.path) : undefined;
      const targets = dir ? [await resolveInSandbox(roots, dir)] : roots;
      const files: { file: string; headings: { level: number; text: string; line: number }[] }[] = [];
      let skipped = 0;
      // Names come back relative to the SANDBOX ROOT, never to whatever was asked for, because they
      // are meant to be handed straight back to `read_file`. A path relative to a subdirectory is a
      // path that does not resolve.
      const each = async (real: string) => {
        if (!/\.(md|markdown|txt)$/i.test(real)) return;
        const owner = roots.find((r) => real === r || real.startsWith(r + SEPARATOR));
        const stat = await Deno.stat(real);
        if (stat.size > SCAN_MAX) {
          skipped++;
          return;
        }
        const heads = headingsOf(new TextDecoder().decode(await Deno.readFile(real)));
        if (heads.length > 0) files.push({ file: owner ? real.slice(owner.length + 1) : real, headings: heads });
      };
      for (const t of targets) {
        const info = await Deno.stat(t);
        if (info.isDirectory) await walk(t, t, (real) => each(real));
        else await each(t);
      }
      return { files, ...(skipped > 0 ? { skippedTooLarge: skipped } : {}) };
    },

    list_files: async (a) => {
      const dir = a.dir ? String(a.dir) : undefined;
      const targets = dir ? [await resolveInSandbox(roots, dir)] : roots;
      const files: { name: string; size: number; modified: string | null; dir: boolean }[] = [];
      for (const t of targets) {
        for await (const e of Deno.readDir(t)) {
          const name = (dir ? dir + "/" : "") + e.name;
          try {
            const info = await Deno.stat(join(t, e.name));
            files.push({ name, size: info.size, modified: info.mtime?.toISOString() ?? null, dir: e.isDirectory });
          } catch {
            files.push({ name, size: 0, modified: null, dir: e.isDirectory });
          }
        }
      }
      return { files };
    },

    stat: async (a) => {
      const path = String(a.path ?? "");
      const real = await resolveInSandbox(roots, path);
      const info = await Deno.stat(real);
      return {
        path,
        size: info.size,
        modified: info.mtime?.toISOString() ?? null,
        isFile: info.isFile,
        isDirectory: info.isDirectory,
      };
    },

    search_files: async (a) => {
      const query = String(a.query ?? "");
      if (!query) return { matches: [], note: "search_files needs a non-empty query" };
      const lower = query.toLowerCase();
      const matches: { file: string; line: number; section?: string; text: string }[] = [];
      // What was NOT searched, reported rather than dropped. The whole bug this replaces was a
      // silent omission: the caller cannot tell a corpus with no hits from a corpus that was
      // half read, and only one of those calls for a different question.
      const skipped: { file: string; why: string }[] = [];
      let capped = false;
      for (const root of roots) {
        await walk(root, root, async (real, rel) => {
          if (matches.length >= MAX_MATCHES) {
            capped = true;
            return; // and stop reading files nobody will see the results of
          }
          try {
            const info = await Deno.stat(real);
            if (!info.isFile) return;
            if (info.size > SCAN_MAX) {
              skipped.push({ file: rel, why: `${Math.round(info.size / 1024 / 1024)} MB, over the ${SCAN_MAX / 1024 / 1024} MB scan limit` });
              return;
            }
            const bytes = await Deno.readFile(real);
            if (binary(bytes)) return; // not a text file; not a finding, not worth reporting
            // The enclosing heading travels with the hit, so a match deep inside a 149 KB document
            // is immediately readable: `read_file {path, section}`. Without it the caller gets a
            // line number it cannot reach, since the whole-file read stops at 64 KB.
            let section: string | undefined;
            const lines = new TextDecoder().decode(bytes).split("\n");
            for (let i = 0; i < lines.length; i++) {
              const h = HEADING.exec(lines[i]);
              if (h) section = h[2].trim();
              if (!lines[i].toLowerCase().includes(lower)) continue;
              if (matches.length >= MAX_MATCHES) {
                capped = true;
                return;
              }
              matches.push({ file: rel, line: i + 1, ...(section ? { section } : {}), text: lines[i].trim().slice(0, 200) });
            }
          } catch { /* unreadable: a permission or a race, not an answer */ }
        });
      }
      return {
        matches,
        ...(capped ? { capped: `stopped at ${MAX_MATCHES} matches; narrow the query` } : {}),
        ...(skipped.length > 0 ? { skipped } : {}),
      };
    },

    time: () => Promise.resolve({ now: new Date().toISOString() }),

    calc: (a) => Promise.resolve({ result: calc(String(a.expr ?? "")) }),
  };
}

/** Tiny safe arithmetic evaluator (recursive descent, no eval). + - * / and parentheses. */
export function calc(expr: string): number {
  const s = expr.replace(/\s+/g, "");
  let i = 0;
  const parseExpr = (): number => {
    let v = parseTerm();
    while (s[i] === "+" || s[i] === "-") {
      const op = s[i++];
      const t = parseTerm();
      v = op === "+" ? v + t : v - t;
    }
    return v;
  };
  const parseTerm = (): number => {
    let v = parseFactor();
    while (s[i] === "*" || s[i] === "/") {
      const op = s[i++];
      const f = parseFactor();
      v = op === "*" ? v * f : v / f;
    }
    return v;
  };
  const parseFactor = (): number => {
    if (s[i] === "(") {
      i++;
      const v = parseExpr();
      if (s[i++] !== ")") throw new Error("expected )");
      return v;
    }
    if (s[i] === "-") {
      i++;
      return -parseFactor();
    }
    const m = /^[0-9]+(\.[0-9]+)?/.exec(s.slice(i));
    if (!m) throw new Error(`bad expression at ${i}`);
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const v = parseExpr();
  if (i < s.length) throw new Error(`unexpected '${s[i]}'`);
  return v;
}

/** JSON-schema tool definitions sent to the model. */
export const TOOL_SCHEMAS: ToolDef[] = [
  { type: "function", function: { name: "read_file", description: "Read a text file from the allowed sandbox directories. Returns content plus size (bytes) and modified time. Pass `section` with a heading to read just that part of a large document: a whole-file read stops at 64 KB, so a long file comes back truncated (it then lists its headings, and so does `outline`), while a section is returned complete. `search_files` reports the heading each match sits under, which is the value to pass here.", parameters: { type: "object", properties: { path: { type: "string", description: "path relative to a sandbox root" }, section: { type: "string", description: "a heading in the file; returns that heading and its body, down to the next heading of the same or higher level" } }, required: ["path"] } } },
  { type: "function", function: { name: "outline", description: "The headings of every markdown file in the sandbox, with line numbers: the map of what is documented and where. Use it BEFORE searching when the question is 'where is X explained' rather than 'which files mention the string X' — filenames and headings usually answer that outright, and one search term can match most of a corpus. Then read one part with read_file {path, section}.", parameters: { type: "object", properties: { path: { type: "string", description: "limit to one file or directory; omit for every root" } } } } },
  { type: "function", function: { name: "list_files", description: "List files in the allowed sandbox directories, each with size (bytes) and modified time. Use this for questions about which file is largest or most recent.", parameters: { type: "object", properties: { dir: { type: "string" } } } } },
  { type: "function", function: { name: "stat", description: "File metadata: size (bytes), modified time, isFile/isDirectory. Use for size or date questions.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "search_files", description: "Search text files in the sandbox for a substring, case-insensitively. Every file is searched whatever its size; anything genuinely too large to scan is REPORTED in `skipped` rather than passed over, and hitting the match cap is reported in `capped`. Each match carries the heading it sits under, so pass that to read_file {path, section} to read it. A common word matches most of a corpus, so prefer a distinctive phrase, or use `outline` when the question is where something is explained.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "time", description: "Get the current UTC time.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "calc", description: "Evaluate a basic arithmetic expression: + - * / and parentheses over numbers only. No functions (no len/length) and no strings.", parameters: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] } } },
];
