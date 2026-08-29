#!/usr/bin/env -S deno run -A
// The authoring step of the workspace scenario, with no model behind it.
//
// It exists for the same reason `fake-agent.ts` does: the chain it exercises (author a tree,
// promote a digest, bind an agent, run it brokered) has four moving parts and none of them needs a
// model to be wrong. This answers "is the workspace chain wired up" in seconds and for nothing,
// which is what makes a failed REAL run readable: if this passes and the model run does not, the
// finding is about the model or the tool descriptions rather than about the plumbing.
//
// The tree it writes is deliberately the one the real scenario asks a model for, so the two runs
// differ in exactly one variable.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { writeWorkspace } from "../../extensions/ts/workspace.ts";

const argv = Deno.args;
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const url = flag("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const name = flag("--workspace") ?? "inventory";
const team = flag("--team") ?? "lab";
const definitionToken = Deno.env.get("RADIA_DEFINITION_TOKEN");
if (!definitionToken) {
  console.error("author-workspace: RADIA_DEFINITION_TOKEN is required (the lab runner mints one per member)");
  Deno.exit(2);
}
const client = new RadiaClient(url, { definitionToken });
await client.ensureCredential();
const owner = (await client.health()).agent ?? "agent:unknown";

// The entrypoint contract the host imposes: a default export taking `(record, space)`, where
// `space` is the BROKER's three methods and nothing else. Returning the ack result is what makes
// the answer fenced; putting it directly would be a second, unfenced write.
const main = `export default async function (record, space) {
  const notes = await space.query({ kind: "note", match: { topic: "inventory" } }, 100);
  let total = 0;
  for (const n of notes) {
    const m = /(\\d+) in stock/.exec(String(n.body.message ?? ""));
    if (m) total += Number(m[1]);
  }
  // NO team field: the binding declares it and the host stamps it, which is what stops a
  // compartment being something model-written code has to remember.
  return { kind: "note", body: { to: "all", topic: "inventory-total", message: String(total) } };
}
`;

const r = await writeWorkspace(client, {
  name,
  owner,
  files: { "main.js": main },
  entrypoint: "main.js",
  // The compartment label, stamped on every file's artifact and on the manifest. Without it a
  // member's team-scoped `artifact` grant refuses the file puts and no tree is written at all.
  meta: { team },
});
console.log(JSON.stringify({ workspace: name, treeDigest: r.treeDigest, entrypoint: r.entrypoint, files: r.files.map((f) => f.path) }));
