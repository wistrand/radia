// Every `deno task X` that CI or a script invokes is a task `deno.json` actually defines.
//
// Written after `check` vanished from `deno.json`: a new `dev:pg:oidc:s3` task was pasted over its
// line, and `embedded` then failed at its FIRST step on every run with "Task not found: check".
// Nothing local noticed, because the task nobody can run is also the task nobody sees fail, and the
// error arrives only where the workflow does.
//
// The reverse is deliberately not checked. A task no workflow calls is a convenience for people
// (`dev`, `chat`, `bench`), not drift.

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const root = dirname(fromFileUrl(new URL("../deno.json", import.meta.url)));

async function filesIn(dir: string, ext: string): Promise<{ name: string; text: string }[]> {
  const out: { name: string; text: string }[] = [];
  try {
    for await (const e of Deno.readDir(join(root, dir))) {
      if (e.isFile && e.name.endsWith(ext)) {
        out.push({ name: `${dir}/${e.name}`, text: await Deno.readTextFile(join(root, dir, e.name)) });
      }
    }
  } catch { /* the directory is optional */ }
  return out;
}

Deno.test("tasks: the version the binary reports is the version deno.json publishes", async () => {
  // `scripts/build-release.sh` stamps deno.json's version onto every artifact, while the binary
  // answers `radia version` from a constant it compiled in, because it has no deno.json beside it.
  // Two homes, so they can drift, and a binary reporting a version its package does not carry is
  // worse than one reporting nothing.
  const config = JSON.parse(await Deno.readTextFile(join(root, "deno.json"))) as { version: string };
  const source = await Deno.readTextFile(join(root, "src/version.ts"));
  const declared = source.match(/export const VERSION = "([^"]*)"/)?.[1];
  assert(declared, "src/version.ts no longer declares VERSION the way this guard reads it");
  assertEquals(declared, config.version, "src/version.ts and deno.json disagree about the version");
});

Deno.test("tasks: every `deno task` a workflow or script runs is defined in deno.json", async () => {
  const config = JSON.parse(await Deno.readTextFile(join(root, "deno.json"))) as { tasks: Record<string, string> };
  const defined = new Set(Object.keys(config.tasks));
  assert(defined.size > 5, "failed to read the task list; deno.json may have been reshaped");

  const callers = [...await filesIn(".github/workflows", ".yml"), ...await filesIn("scripts", ".sh")];
  assert(callers.length > 2, "found no workflows or scripts to scan");

  const missing: string[] = [];
  const seen = new Set<string>();
  for (const f of callers) {
    // `deno task <name>`, with the task name being the first word after it. A trailing `--` or a
    // flag belongs to the task, not to its name.
    for (const m of f.text.matchAll(/deno task ([a-z][a-z0-9:-]*)/g)) {
      seen.add(m[1]);
      if (!defined.has(m[1])) missing.push(`${f.name} runs \`deno task ${m[1]}\``);
    }
  }
  assert(seen.size > 3, "no `deno task` invocations found; the extraction is broken");
  assertEquals(missing, [], "a workflow or script names a task deno.json does not define");
});
