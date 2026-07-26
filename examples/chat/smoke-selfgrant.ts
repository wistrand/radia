// The escalation loop, end to end, with NO MODEL:
//
//   deno run -A examples/chat/smoke-selfgrant.ts
//
// A scoped session hits `forbidden` on the ops plane, asks for authority as a record, a human
// approves (here: the script, standing in for the person at the REPL), and the same call then
// succeeds — answering over the session's OWN records only, with another principal's records
// present in the same space to prove it.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { bootstrap, CHAT_USER } from "./space/roles.ts";
import { ToolSet } from "./client/turn.ts";
import { reviewGrantRequests } from "./client/grants.ts";

const PORT = 7797;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT)],
  stdout: "null",
  stderr: "inherit",
}).spawn();

const admin = new RadiaClient(url); // operator: the REPL's bootstrap credential
for (let i = 0; i < 100; i++) {
  try {
    await admin.health();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
await registerChatKinds(admin);
const { sessionToken, toolsToken } = await bootstrap(admin, "user");
const session = new RadiaClient(url, { token: sessionToken! });

// A BUSY space must not hide the newest tool. Discovery reads a bounded page, and a limited query
// returns the OLDEST matches — so on a space holding more capability records than that page, an
// ascending read shows every tool EXCEPT the most recently published. That is the exact failure
// that made a live session report "I don't have a request_grant tool": these fillers stand in for
// the records a long-lived space accumulates, and the worker below publishes the real tools after
// them, exactly as a restart does.
for (let i = 0; i < 520; i++) {
  await admin.put({
    kind: "capability",
    body: {
      tool: `filler_${i}`,
      def: { type: "function", function: { name: `filler_${i}`, description: "filler", parameters: { type: "object", properties: {} } } },
    },
  });
}

// The tools worker, running space_* as the SESSION principal — the arrangement that produces the
// 403s, and the one that serves request_grant.
const worker = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    `--allow-net=127.0.0.1:${PORT}`,
    "--allow-read=examples/chat/sandbox",
    "examples/chat/workers/tools.ts",
    "--url",
    url,
    "--token",
    toolsToken,
    "--session-token",
    sessionToken!,
    "--dir",
    "examples/chat/sandbox",
  ],
  stdout: "null",
  stderr: "inherit",
}).spawn();

const check = (label: string, pass: boolean, detail = "") => console.log(`  ${pass ? "OK  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);

/** Call a tool the way the chat does — a record — and wait for its result. */
async function callTool(tool: string, args: unknown, conversationId: string, timeoutMs = 20_000) {
  const { id } = await admin.put({ kind: "tool_call", body: { tool, args, conversationId }, parentIds: [conversationId] });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await admin.readOne({ kind: "tool_result", match: { callId: id } });
    if (r) return r.body as { ok: boolean; output: unknown };
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error(`no tool_result for ${tool} within ${timeoutMs}ms`);
}
const forbidden = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return String(e).includes("forbidden");
  }
};

// Another principal's records, so "my own" is a claim that can actually fail.
await admin.put({ kind: "message", body: { conversationId: "other", index: 0, role: "user", content: "not mine" } });
await admin.put({ kind: "message", body: { conversationId: "other", index: 1, role: "user", content: "also not mine" } });

// The session's own records.
const conv = (await session.put({ kind: "conversation", body: { title: "mine" } })).id;
for (let i = 0; i < 3; i++) {
  await session.put({ kind: "message", body: { conversationId: conv, index: i, role: "user", content: `m${i}` } });
}

// 1. The wall: the ops plane is shut to a scoped session.
check("a scoped session cannot reach ops/stats", await forbidden(() => session.getStats()));
check("…nor diagnostics", await forbidden(() => session.diagnostics()));

// 2. The escalation tool is DISCOVERABLE — the transcript's failure was a tool that existed but
//    was never reached, so its presence in the published capability set is worth asserting.
//    Waiting on the tool ITSELF, not on "any capability": the fillers above mean the set is never
//    empty, and a wait that only checks for non-emptiness returns before the worker has published
//    (which is also how the chat's own startup wait was too weak).
let published: string[] = [];
for (let i = 0; i < 60; i++) {
  published = (await admin.query({ kind: "capability" }, 500, { dir: "desc" }))
    .map((c) => (c.body as { tool: string }).tool);
  if (published.includes("request_grant")) break;
  await new Promise((r) => setTimeout(r, 250));
}
check("request_grant is published as a capability", published.includes("request_grant"));

const discovered = new ToolSet(session);
await discovered.scopeTo(conv);
check(
  "the newest tools are still discovered on a space past the page cap",
  discovered.all().some((t) => t.function.name === "request_grant"),
  `${discovered.all().length} tools visible, ${published.length} newest records read`,
);

// 3. It asks THROUGH THE TOOL, as the session. It cannot grant — only ask.
const asked0 = await callTool("request_grant", { kind: "message", operations: ["query"], why: "to count what I created" }, conv);
check("request_grant succeeds", asked0.ok, JSON.stringify(asked0.output).slice(0, 70));
const asked = await session.query({ kind: "grant_request", match: { conversationId: conv } }, 10);
check("the request is a record the human can read", asked.length === 1);
check("and the asker is recorded by the server, not by the body", asked[0].runtimeMeta.createdBy.startsWith("run:"));
check("the session still cannot grant itself anything", await forbidden(() =>
  session.put({ kind: "grant", body: { principal: CHAT_USER, kind: "message", operations: ["query"] } })));

// 3. The human approves, through the REAL review path — which is where the narrowing logic lives.
//    Approving the narrow option withdraws the wider bootstrap grant on that kind (grants union, so
//    a narrow grant beside a broad one changes nothing) while KEEPING the operations it was not
//    asked about. Getting that wrong killed a live session: narrowing `query` on `message` retired
//    the bootstrap {put, query} grant wholesale, and the chat died writing its next message.
await reviewGrantRequests(session, admin, CHAT_USER, conv, () => Promise.resolve("y"));

check(
  "the session can STILL write after its reads were narrowed",
  await (async () => {
    try {
      await session.put({ kind: "message", body: { conversationId: conv, index: 99, role: "user", content: "after" } });
      return true;
    } catch {
      return false;
    }
  })(),
);

// 4. The same call now works, and answers over the session's own records only.
// An empty scoped answer must be distinguishable from an empty space. A session once read
// `stats: []` and told its user "the space is empty and healthy" — the data was right, the claim
// was not, and nothing in the response contradicted it.
const report = await session.getStatsReport();
check("a scoped response says it is scoped", Boolean(report.scope?.self), JSON.stringify(report.scope?.kinds));
check("and names the kinds it was narrowed to", report.scope?.kinds.includes("message") === true);
const emptyish = await session.getEventsPage("0", 5);
check("a scoped event page says it is scoped too", Boolean(emptyish.scope));
const diag0 = await session.diagnostics() as { scope?: { self?: boolean } };
check("so does diagnostics", Boolean(diag0.scope?.self));

const stats = await session.getStats();
const messages = stats.filter((s) => s.kind === "message").reduce((a, s) => a + s.count, 0);
check("ops/stats now answers", messages > 0, `message count = ${messages}`);
check("and counts ONLY the session's records", messages === 4, `expected 4 of the session's own (2 others' excluded), got ${messages}`);
check("kinds outside the grant are absent entirely", !stats.some((s) => s.kind === "conversation"));

const diag = await session.diagnostics() as { counts: Record<string, number> };
check("diagnostics is a genuine self-aggregate", diag.counts.available === 4, `available = ${diag.counts.available}`);

// 5. THE EVENT LOG IS FILTERED. A scope that opened `ops/events` unfiltered would hand over every
//    record id, kind and operation in the space — the whole point of scoping, undone by the one
//    endpoint whose payload is a list of everything that happened.
// Page to the END of the log: `getEvents` walks forward from a cursor, so reading only the first
// page of a busy space says nothing about events written recently — which is exactly where this
// session's own activity is.
async function drainEvents(c: typeof admin) {
  const out: { runId: string; kind?: string }[] = [];
  let cursor: string | undefined = "0";
  // Paged by `nextAfter`, not by "did this page have anything" — for a scoped caller a page can be
  // empty while the log continues, so an empty-page break would stop at the first run of events it
  // is not allowed to see.
  for (let page = 0; page < 20 && cursor !== undefined; page++) {
    const got = await c.getEventsPage(cursor, 500);
    out.push(...got.events);
    cursor = got.nextAfter;
  }
  return out;
}
const mineEvents = await drainEvents(session);
const allEvents = await drainEvents(admin);
check("a scoped caller does not get the whole event log", mineEvents.length < allEvents.length, `${mineEvents.length} of ${allEvents.length}`);
check("but does see its OWN activity", mineEvents.length > 0, `${mineEvents.length} events`);
check(
  "and only on kinds it is granted",
  mineEvents.every((e) => e.kind === undefined || e.kind === "message"),
  [...new Set(mineEvents.map((e) => e.kind))].join(","),
);
check(
  "and only events it caused",
  mineEvents.every((e) => e.runId.startsWith("run:")),
  [...new Set(mineEvents.map((e) => e.runId))].join(",").slice(0, 60),
);

// 6. The write half of the plane stays shut, scope or no scope.
check("remediation is still refused", await forbidden(() => session.remediate("reclaim", { state: "leased" })));

// 6b. THE PROMISE THE PROMPT MAKES: "only its OWN records of that kind" must hold on the plane the
//     agent actually reads records through, not only on the ops aggregates. This was live — a
//     session granted self-scoped `message` saw its own records in ops/stats and ALL of them via
//     query, and noticed the contradiction itself.
const viaQuery = await session.query({ kind: "message" }, 100);
check(
  "a self-scoped grant narrows query too, not just the aggregates",
  viaQuery.length === 4,
  `query returned ${viaQuery.length}, stats said ${messages}`,
);
check("and the aggregate agrees with the query", viaQuery.length === messages);
check(
  "the records really are the session's own",
  viaQuery.every((r) => r.runtimeMeta.createdBy.startsWith("run:")),
);
const someoneElses = await admin.query({ kind: "message", match: { conversationId: "other" } }, 10);
check("the other author's records exist but are unreachable", someoneElses.length === 2);

// 7. An operator still sees everything — the scope narrowed the caller, not the space.
const all = await admin.getStats();
check("the operator still sees both authors", all.filter((s) => s.kind === "message").reduce((a, s) => a + s.count, 0) === 6);

// 8. The `role` index: the aggregation the model reached for four times and could not make.
const byRole = await session.query({ kind: "message", match: { conversationId: conv, role: "user" } }, 50);
check("messages are countable by role", byRole.length === 4, `role=user -> ${byRole.length}`);

try {
  worker.kill();
  space.kill();
} catch { /* already gone */ }
Deno.exit(0);
