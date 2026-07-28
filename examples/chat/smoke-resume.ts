// Resuming a conversation across a restart, with NO MODEL:
//
//   deno run -A examples/chat/smoke-resume.ts
//
// The conversation lives on the space, so "resume" means recovering the one piece of state the
// client held (`nextIndex`) and reattaching. This drives a real space through a genuine restart
// (the process is killed and a new one started against the same `--db`), because an in-memory
// space would make every assertion below pass for the wrong reason.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { type Identity, Thread } from "./client/thread.ts";

/** This suite drives the space with the operator credential, so that is the identity it prompts as. */
const ADMIN: Identity = { principal: "human:local", privileged: true };

const PORT = 7796;
const url = `http://127.0.0.1:${PORT}`;
const db = await Deno.makeTempDir() + "/resume.db";

function startSpace(): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--storage", "sqlite", "--db", db],
    stdout: "null",
    stderr: "inherit",
  }).spawn();
}

const client = new RadiaClient(url);
async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      await client.health();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("space did not start");
}

const check = (label: string, pass: boolean, detail = "") => console.log(`  ${pass ? "OK  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);

// ---- session one ----
let space = startSpace();
await waitUp();
await registerChatKinds(client);

const first = await Thread.open(client, ADMIN, (await client.put({ kind: "conversation", body: {} })).id);
await first.append({ role: "user", content: "hello" });
await first.append({ role: "assistant", content: "hi" });
const convId = first.id;
const beforeIndex = first.upToIndex;
check("a fresh conversation starts at index 0", first.resumedFrom === 0);

// Something conversation-scoped, to prove resume restores more than the transcript.
await client.put({
  kind: "procedure",
  body: { name: "kept", description: "survives a restart", artifactId: "x", conversationId: convId },
});

// ---- restart: kill the process, start a new one on the same database ----
space.kill();
await new Promise((r) => setTimeout(r, 700));
let down = false;
try {
  await client.health();
} catch {
  down = true;
}
check("the space really went away", down);

space = startSpace();
await waitUp();
check("and comes back on the same database", (await client.query({ kind: "message", match: { conversationId: convId } }, 50)).length > 0);

// ---- session two: reattach ----
const resumed = await Thread.resume(client, convId, ADMIN);
check("resume reattaches to the same conversation", resumed.id === convId);
check("and recovers where the transcript left off", resumed.resumedFrom === beforeIndex + 1, `resumedFrom=${resumed.resumedFrom}, was upToIndex=${beforeIndex}`);

await resumed.append({ role: "user", content: "still here?" });
const all = await client.query(
  { kind: "message", match: { conversationId: convId }, orderBy: [{ path: "index" }] },
  100,
);
const indices = all.map((r) => (r.body as { index: number }).index);
check("indices continue without collision", new Set(indices).size === indices.length, indices.join(","));
check("the earlier turns are still there", all.some((r) => (r.body as { content?: string }).content === "hello"));

// A resumed thread re-states the standing instructions rather than inheriting a stale prompt.
const systems = all.filter((r) => (r.body as { role: string }).role === "system");
check("resume appends a current system message", systems.length === 2);
check("and says the conversation was resumed", String((systems[1].body as { content: string }).content).includes("resumed"));

// The conversation-scoped things come back too (the real payoff of resuming).
const procs = await client.query({ kind: "procedure", match: { conversationId: convId } }, 10);
check("conversation-scoped procedures survive the restart", procs.length === 1);

// `last` resolves to the newest conversation. That is the keyset direction in use.
await Thread.open(client, ADMIN, (await client.put({ kind: "conversation", body: {} })).id); // a newer conversation
const newest = await client.query({ kind: "conversation" }, 1, { dir: "desc" });
check("'last' resolves to the most recent conversation", newest.length === 1 && newest[0].id !== convId);

try {
  space.kill();
} catch { /* already gone */ }
Deno.exit(0);
