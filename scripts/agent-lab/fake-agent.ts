#!/usr/bin/env -S deno run -A
// A harness with no model in it: reads the MCP config the runner wrote, speaks JSON-RPC to the
// adapter, and makes a fixed sequence of calls.
//
// Two jobs. It proves the LAB's plumbing (a space, a member, a config, a trace, the live output)
// without spending a token, which is what you want when the question is "is my runner wired up"
// rather than "how does a model behave". And it is the seed of phase 3: a recorded trace replayed
// against a fresh binary is this file with its script read from a file instead of written in it.
//
// The sequence is deliberately the one a real session got wrong: claim by `$in` on an array path
// (answers empty, looks like an idle queue) and then by `$any` (claims). A run whose trace does not
// show `empty` then `ok` for those two is a runner that is not recording what it claims to.

const configPath = Deno.args[Deno.args.indexOf("--config") + 1];
if (!configPath) {
  console.error("usage: fake-agent.ts --config <mcp config json>");
  Deno.exit(2);
}
const config = JSON.parse(await Deno.readTextFile(configPath)) as {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
};
const server = Object.values(config.mcpServers)[0];

const child = new Deno.Command(server.command, {
  args: server.args,
  env: { ...Deno.env.toObject(), ...server.env },
  stdin: "piped",
  stdout: "piped",
  stderr: "inherit",
}).spawn();

const w = child.stdin.getWriter();
const enc = new TextEncoder();
const send = async (msg: unknown) => await w.write(enc.encode(`${JSON.stringify(msg)}\n`));

// Drained rather than parsed: the assertions live in the trace file, which is the point of the
// exercise. An unread stdout would fill its pipe and wedge the adapter.
const drain = (async () => {
  for await (const _ of child.stdout) { /* discard */ }
})();

const team = Deno.args[Deno.args.indexOf("--team") + 1] ?? "lab";
const steps: [string, Record<string, unknown>][] = [
  ["space_kinds", {}],
  ["space_put", { kind: "task", body: { team, tags: ["image"], description: "a seal, please" } }],
  ["space_take", { kind: "task", match: { tags: { $in: ["image"] } } }],
  ["space_take", { kind: "task", match: { tags: { $any: "image" } } }],
];

await send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
console.log("connected to the adapter");
let id = 1;
for (const [name, args] of steps) {
  console.log(`calling ${name}`);
  await send({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } });
  // Paced so the runner's live output is legible; a real harness is far slower than this.
  await new Promise((r) => setTimeout(r, 700));
}
console.log("done");
await w.close();
await drain;
await child.status;
