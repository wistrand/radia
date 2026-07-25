// The chatbot's tools. read_file/list_files/search_files are sandboxed to a set of
// allowed root directories; the tool-worker that runs these has --allow-read scoped to
// exactly those roots and NO network except the local space, so even a prompt-injection
// that reads a file cannot exfiltrate it. Path canonicalization here is defense-in-depth
// on top of that OS-level sandbox.

import { isAbsolute, join, SEPARATOR } from "@std/path";
import type { ToolDef } from "../provider/openrouter.ts";

const MAX_BYTES = 64 * 1024;

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
export interface ToolContext {
  callId: string;
  conversationId?: string;
}

export type Tool = (args: Record<string, unknown>, ctx?: ToolContext) => Promise<unknown>;

export function makeTools(roots: string[]): Record<string, Tool> {
  return {
    read_file: async (a) => {
      const path = String(a.path ?? "");
      const real = await resolveInSandbox(roots, path);
      const info = await Deno.stat(real);
      if (!info.isFile) throw new Error(`not a file: ${path}`);
      const bytes = await Deno.readFile(real);
      const truncated = bytes.length > MAX_BYTES;
      return {
        path,
        size: info.size,
        modified: info.mtime?.toISOString() ?? null,
        truncated,
        content: new TextDecoder().decode(truncated ? bytes.slice(0, MAX_BYTES) : bytes),
      };
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
      const matches: { file: string; line: number; text: string }[] = [];
      for (const root of roots) {
        await walk(root, root, async (real, rel) => {
          try {
            const info = await Deno.stat(real);
            if (!info.isFile || info.size > MAX_BYTES) return;
            const text = new TextDecoder().decode(await Deno.readFile(real));
            text.split("\n").forEach((ln, i) => {
              if (matches.length < 50 && ln.includes(query)) {
                matches.push({ file: rel, line: i + 1, text: ln.trim().slice(0, 200) });
              }
            });
          } catch { /* skip unreadable */ }
        });
      }
      return { matches };
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
  { type: "function", function: { name: "read_file", description: "Read a text file from the allowed sandbox directories. Returns content plus size (bytes) and modified time.", parameters: { type: "object", properties: { path: { type: "string", description: "path relative to a sandbox root" } }, required: ["path"] } } },
  { type: "function", function: { name: "list_files", description: "List files in the allowed sandbox directories, each with size (bytes) and modified time. Use this for questions about which file is largest or most recent.", parameters: { type: "object", properties: { dir: { type: "string" } } } } },
  { type: "function", function: { name: "stat", description: "File metadata: size (bytes), modified time, isFile/isDirectory. Use for size or date questions.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "search_files", description: "Search text files in the sandbox for a substring.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "time", description: "Get the current UTC time.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "calc", description: "Evaluate a basic arithmetic expression: + - * / and parentheses over numbers only. No functions (no len/length) and no strings.", parameters: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] } } },
];
