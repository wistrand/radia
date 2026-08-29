// The harness config that points an agent at this space, rendered for the harnesses people
// actually run. `radia team add` prints it; nothing here talks to a space.
//
// THE CONFIG NAMES THE BINARY THAT WROTE IT, absolute. A block saying `"command": "radia"` works
// only if the harness's PATH has it, which is the one thing a generated config cannot check and
// the failure everybody hits first: the harness reports the server as failed with no reason a
// person can act on.
//
// The config is usually for ANOTHER project, which is what makes the binary the answer rather than
// this checkout's source: `deno run -A <checkout>/src/main.ts` pins that project to a path that can
// move, needs Deno wherever the harness runs, and re-checks the module graph on every spawn.

import { execPath, moduleRelative } from "../../platform.ts";

/** Which harness a block is for. `json` is the portable `mcpServers` object every MCP client
 *  other than Codex reads (Claude Code's `.mcp.json`, Claude Desktop, Cursor, Zed). */
export type Harness = "claude" | "codex" | "agy" | "json";

export interface McpTarget {
  /** Space base URL, written into the args so the harness needs no environment of its own. */
  url: string;
  /** The member's DURABLE half. It mints run tokens and can read and write nothing itself, which
   *  is what makes it the right one to sit in a config file. */
  definitionToken?: string;
  /** Server name inside the harness config. Two spaces on one machine want two names. */
  name: string;
}

export interface Invocation {
  command: string;
  args: string[];
  /** Set when no binary was found and this runs the SOURCE through Deno. The config then depends
   *  on this checkout's path and on Deno being installed wherever the harness runs, so a caller
   *  printing it owes the reader that warning. */
  fromSource?: true;
}

const fsPath = (u: URL) => (u.protocol === "file:" ? decodeURIComponent(u.pathname) : u.href);

/**
 * How to start `radia mcp`: THE BINARY THAT GENERATED THIS CONFIG, absolute.
 *
 * Not a `radia` looked up on PATH, and that was tried. A PATH scan can name a DIFFERENT build than
 * the one writing the block, so the config would point at a binary this process cannot vouch for:
 * a stale install shadowing a fresh build speaks an older wire contract and lacks whatever feature
 * the config was written for, and nothing reports it because the server does start.
 *
 * Running from source has no binary to name, so it is the one case that cannot be answered here.
 * It reports `fromSource` and the caller sends the reader to `deno task compile`, because the fix
 * is to re-run this command AS the binary rather than to paste a `deno run` line into a project
 * that would then be pinned to this checkout's path.
 */
export function mcpInvocation(url: string): Invocation {
  const exec = execPath();
  const base = exec.replace(/\\/g, "/").split("/").pop() ?? "";
  const tail = ["mcp", "--url", url];
  if (!/^deno(\.exe)?$/.test(base)) return { command: exec, args: tail };
  const main = fsPath(moduleRelative(import.meta.url, "../../main.ts"));
  return { command: exec, args: ["run", "-A", main, ...tail], fromSource: true };
}

/** The config block, ready to paste. */
export function renderMcpConfig(harness: Harness, target: McpTarget): string {
  const { command, args } = mcpInvocation(target.url);
  const env = target.definitionToken ? { RADIA_DEFINITION_TOKEN: target.definitionToken } : {};
  if (harness === "codex") {
    // Codex reads TOML from ~/.codex/config.toml and spells the table `mcp_servers`.
    const lines = [
      `[mcp_servers.${target.name}]`,
      `command = ${JSON.stringify(command)}`,
      `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]`,
    ];
    if (target.definitionToken) lines.push(`env = { RADIA_DEFINITION_TOKEN = ${JSON.stringify(target.definitionToken)} }`);
    return lines.join("\n");
  }
  const block = { mcpServers: { [target.name]: { command, args, ...(target.definitionToken ? { env } : {}) } } };
  return JSON.stringify(block, null, 2);
}

/**
 * The one-liner that installs it, for a harness that has one. Claude Code does; a person who would
 * rather see the file gets the block above either way.
 *
 * `--scope local` is EXPLICIT, not left to the default. It keys the config to the directory it is
 * run in, which is what gives each project its own member. `--scope user` writes one config for
 * every project, so two agents meant to be two principals become one: their work is
 * indistinguishable by author and stopping one stops both, which is the whole thing a member per
 * session exists to prevent.
 */
export function renderMcpInstall(harness: Harness, target: McpTarget): string | undefined {
  if (harness !== "claude" && harness !== "agy") return undefined;
  const { command, args } = mcpInvocation(target.url);
  const shell = (s: string) => (/^[A-Za-z0-9_.:@/=+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  const envArg = target.definitionToken ? ` --env RADIA_DEFINITION_TOKEN=${shell(target.definitionToken)}` : "";
  if (harness === "agy") {
    // `agy mcp add` writes `~/.gemini/config/mcp_config.json`, and has NO per-project scope: one
    // machine, one server list, which is why two agy members on one machine need `HOME` moved
    // rather than a second config file (scripts/agent-lab/run.ts).
    return `agy mcp add${envArg.replace(" --env ", " --env ")} ${shell(target.name)} -- ${shell(command)} ${args.map(shell).join(" ")}`;
  }
  return `claude mcp add ${shell(target.name)} --scope local${envArg} -- ${shell(command)} ${args.map(shell).join(" ")}`;
}

/** Where a harness keeps the block, for a person who wants to paste it by hand. */
export function configLocation(harness: Harness): string {
  if (harness === "codex") return "~/.codex/config.toml";
  if (harness === "claude") return ".mcp.json in the project, or ~/.claude.json";
  if (harness === "agy") return "~/.gemini/config/mcp_config.json";
  return "your MCP client's server list";
}
