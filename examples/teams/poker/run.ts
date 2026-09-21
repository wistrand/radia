// One experimental run: a fresh team label on a space that keeps running.
//
//   deno task poker-run team-llm-blind-deepseek.json
//   deno task poker-run team-llm-fine.json --model x-ai/grok-4.6 --hands 12 --label probe-7
//   deno task poker-run team-llm-blind.json --url http://127.0.0.1:7788 --dry
//
// A LABEL, NOT A SPACE. Every run used to get its own `radia dev`, because a second run on one
// space let the players read the previous run's channel and because an ejected seat could not be
// re-seated. Both are solved by a fresh team label: a member's `note` grant is scoped to
// `{team: <label>}` and grants filter reads server side, so a seat cannot see another label's
// notes even asking for all of them; `grantKey` encodes the pattern, so the new label's grants
// are new records rather than a collision; and an ejection tombstone belongs to the label it was
// written under. What made labels unusable was `team up` skipping re-provision on a relabel
// (`satisfiesPattern` in `src/surfaces/cli.ts`), and that is fixed.
//
// Ten stray `radia dev` processes, a port collision with an artifact origin (it follows at
// port+1) and a readiness check that accepted that origin as a space are what this replaces.

import { flag, has, positional } from "../../../src/flags.ts";

const OPTIONS = ["url", "label", "model", "hands", "stacks", "timeout", "prompt", "penalty", "judge-model"] as const;
const args: Record<string, string | undefined> = {};
for (const name of OPTIONS) args[name] = flag(Deno.args, `--${name}`);
const dry = has(Deno.args, "--dry");
const keep = has(Deno.args, "--keep");
const file = positional(Deno.args, 1, new Set(["--dry", "--keep"]))[0] ?? "";
if (!file) {
  console.error(
    [
      "usage: deno task poker-run <team-file.json> [options]",
      "",
      "  --url <url>          the space to run on (default http://127.0.0.1:7788)",
      "  --label <name>       team label (default poker-<timestamp>, always fresh)",
      "  --model <slug>       override every player's model",
      "  --hands <n>          override the dealer's hand count",
      "  --stacks a=400,...   override the per-seat starting stacks",
      "  --timeout <s>        override the dealer's action timeout",
      "  --prompt <path>      override the partnership seats' system prompt",
      "  --penalty <p>        floor penalty: eject | warn | fine:<chips>",
      "  --judge-model <slug> the floor's judge",
      "  --dry                print the generated file and the command, run nothing",
      "  --keep               leave the generated file in place afterwards",
    ].join("\n"),
  );
  Deno.exit(2);
}

const dir = new URL(".", import.meta.url).pathname;
const src = file.includes("/") ? file : `${dir}${file}`;
const team = JSON.parse(await Deno.readTextFile(src)) as {
  team: string;
  kinds?: { kind: string }[];
  members: { name: string; command: string[]; grants?: unknown[] }[];
};

// The label is what isolates the run, so it defaults to something that cannot repeat.
const label = args.label ?? `poker-${Date.now().toString(36)}`;
team.team = label;

/**
 * Set `--flag <value>` on a member's command.
 *
 * `add` APPENDS when the flag is absent, which the dealer's and floor's options need: a file
 * written for ejection carries no `--penalty` at all, and replace-only silently did nothing while
 * still reporting the override as applied. `--model` and `--system-file` stay replace-only, since
 * appending them to the dealer or the floor would hand a flag to a process that does not take one.
 */
const set = (cmd: string[], flag: string, value: string, add = false) => {
  const at = cmd.indexOf(flag);
  if (at >= 0) cmd[at + 1] = value;
  else if (add) cmd.push(flag, value);
  else return false;
  return true;
};

const applied = new Set<string>();
for (const m of team.members) {
  set(m.command, "--team", label);
  if (args.model && set(m.command, "--model", args.model)) applied.add("model");
  if (m.name === "dealer") {
    for (const [name, flag] of [["hands", "--hands"], ["timeout", "--action-timeout"], ["stacks", "--stacks"]] as const) {
      if (args[name] && set(m.command, flag, args[name]!, true)) applied.add(name);
    }
  }
  if (m.name === "supervisor") {
    for (const [name, flag] of [["penalty", "--penalty"], ["judge-model", "--judge-model"]] as const) {
      if (args[name] && set(m.command, flag, args[name]!, true)) applied.add(name);
    }
  }
  if (args.prompt && set(m.command, "--system-file", args.prompt.startsWith("/") ? args.prompt : `{{repo}}/${args.prompt}`)) {
    applied.add("prompt");
  }
}
// Only what LANDED, so a typo or an option this file has no member for is visible rather than
// reported as applied.
const changes: string[] = [`team ${label}`, ...OPTIONS.filter((n) => applied.has(n)).map((n) => `${n} ${args[n]}`)];
const ignored = OPTIONS.filter((n) => args[n] && n !== "url" && n !== "label" && !applied.has(n));
if (ignored.length) console.error(`poker-run: NOT APPLIED, no member takes them: ${ignored.join(", ")}`);

// A FINE NEEDS ITS KIND AND ITS GRANTS, or the floor fails on every ruling and says nothing.
// `--penalty fine:5` against a file written for ejection left `poker_penalty` unregistered: the
// floor's write threw, its own catch swallowed it, no ruling was ever posted, and the run looked
// like a table where nobody cheated. An override that cannot work must not run quietly.
if ((args.penalty ?? "").startsWith("fine:")) {
  team.kinds ??= [];
  if (!team.kinds.some((k) => k.kind === "poker_penalty")) {
    team.kinds.push({
      kind: "poker_penalty",
      indexedPaths: [
        { path: "player", type: "keyword" },
        { path: "session", type: "keyword" },
        { path: "team", type: "keyword" },
      ],
      claimable: false,
      usage: "A fine the floor levied on one player, in chips, with the reason and the note that " +
        "earned it. The dealer applies each one once, at the start of the next hand, and says so.",
    } as { kind: string });
    changes.push("added the poker_penalty kind");
  }
  for (const m of team.members) {
    if (m.name !== "dealer" && m.name !== "supervisor") continue;
    m.grants ??= [];
    if (!m.grants.some((g) => typeof g === "string" && g.startsWith("poker_penalty"))) {
      m.grants.push("poker_penalty:put,query,read_one");
      changes.push(`granted poker_penalty to ${m.name}`);
    }
  }
}

// Beside the source file, so `{{repo}}` paths inside it still resolve.
const out = `${dir}.run-${label}.json`;
await Deno.writeTextFile(out, `${JSON.stringify(team, null, 2)}\n`);

const url = args.url ?? "http://127.0.0.1:7788";
const cmd = ["run", "-A", "src/main.ts", "team", "up", out, "--url", url, "--init"];
console.error(`poker-run: ${changes.join(", ")}`);
console.error(`poker-run: deno ${cmd.join(" ")}`);
if (dry) {
  console.error(await Deno.readTextFile(out));
  if (!keep) await Deno.remove(out);
  Deno.exit(0);
}

const child = new Deno.Command("deno", { args: cmd, cwd: `${dir}../../../`, stdout: "inherit", stderr: "inherit" }).spawn();
const status = await child.status;
if (!keep) await Deno.remove(out).catch(() => {});
console.error(`poker-run: ${label} finished; read it back with`);
console.error(`  deno run -A examples/poker/follow.ts --url ${url} --team ${label}`);
console.error(`  deno run -A examples/teams/poker/softplay.ts --url ${url} --team ${label}`);
Deno.exit(status.code);
