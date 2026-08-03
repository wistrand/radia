// Command-line flag parsing, shared by the entry point, the CLI verbs, and the MCP adapter.
// This is the one implementation; never add a local copy of `flag()` beside a call site.
//
// Deliberately tiny: `--name value` pairs, repeatable flags, boolean switches, and positionals.
// No sub-parsers, no schema, no dependency. If radia ever needs more than this, that is a signal
// the CLI surface has grown past what a coordination runtime should expose, not that this file
// needs a framework.

/** Switches that take no value, so positional scanning does not swallow the next token. */
export const VALUELESS = new Set(["--json", "--untainted", "--help", "-h", "--all", "--drain", "--compact", "--partial"]);

/** The value of `--name`, or undefined. First occurrence wins, not last, which keeps
 *  a wrapper script's defaults overridable by appending, the usual shell expectation. */
export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/**
 * A flag whose value is OPTIONAL: `--db /tmp/x` → `"/tmp/x"`, bare `--db` → `""`, absent →
 * `undefined`. The empty string means "present, you pick", which is how a caller offers a default
 * without also making the flag meaningless when someone does want to choose.
 *
 * The next token counts as the value only if it does not start with `-`, so `--db --port 7788`
 * reads as a bare `--db` rather than silently naming the database `--port`.
 */
export function optionalFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const next = argv[i + 1];
  return next === undefined || next.startsWith("-") ? "" : next;
}

/** Every value of a repeatable flag: `--parent a --parent b` → `["a", "b"]`. */
export function flags(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === name) out.push(argv[i + 1]);
  return out;
}

/** Whether a boolean switch is present. */
export function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

/**
 * The first `n` positional arguments, skipping flags and the values they consume.
 * `valueless` names the switches that take no value; anything else starting with `--` is assumed
 * to consume the following token.
 */
export function positional(argv: string[], n: number, valueless: Set<string> = VALUELESS): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length && out.length < n; i++) {
    if (argv[i].startsWith("--")) {
      if (!valueless.has(argv[i])) i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}
