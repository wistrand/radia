// The escalation loop, end to end, with NO MODEL:
//
//   deno run -A examples/chat/smoke-selfgrant.ts
//
// A scoped session hits `forbidden` on the ops plane, asks for authority as a record, a human
// approves (here: the script, standing in for the person at the REPL), and the same call then
// succeeds, answering over the session's OWN records only, with another principal's records
// present in the same space to prove it.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { bootstrap, CHAT_USER, mintSession } from "./space/roles.ts";
import { ToolSet } from "./client/turn.ts";
import { reviewGrantRequests } from "./client/grants.ts";

const PORT = 7797;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT)],
  stdout: "null",
  stderr: "inherit",
}).spawn();

const probe = new RadiaClient(url); // liveness only: /v0/health is public
let admin: RadiaClient; // operator: the REPL's bootstrap credential
for (let i = 0; i < 100; i++) {
  try {
    await probe.health();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
admin = new RadiaClient(url, { token: operatorToken(url) });
await registerChatKinds(admin);
// The conversation exists BEFORE the session credential, because the session's grants are scoped
// to it. That is the same order chat.ts uses, and the reason a user session no longer holds
// `conversation: put` at all.
const conv = (await admin.put({ kind: "conversation", body: { title: "mine" } })).id;
const { toolsToken } = await bootstrap(admin);
const sessionToken = await mintSession(admin, CHAT_USER, { conversationId: conv });
const session = new RadiaClient(url, { token: sessionToken! });

// A BUSY space must not hide the newest tool. Discovery reads a bounded page, and a limited query
// returns the OLDEST matches, so on a space holding more capability records than that page, an
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

// The tools worker, running space_* as the SESSION principal: the arrangement that produces the
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

/** Call a tool the way the chat does (as a record) and wait for its result. */
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
for (let i = 0; i < 3; i++) {
  await session.put({ kind: "message", body: { conversationId: conv, index: i, role: "user", content: `m${i}` } });
}

// 1. The wall: the ops plane is shut to a scoped session.
check("a scoped session cannot reach ops/stats", await forbidden(() => session.getStats()));
check("…nor diagnostics", await forbidden(() => session.diagnostics()));

// 2. The escalation tool is DISCOVERABLE. The transcript's failure was a tool that existed but
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

// 3. It asks THROUGH THE TOOL, as the session. It cannot grant, only ask.
//
// The tool BLOCKS on the decision, and the human answers while it is in flight. That is the shape
// the REPL now drives (`onToolWait`). Running them concurrently is not test convenience:
// sequentially, the ask would wait out its full deadline before anyone was asked, which is
// precisely the two-turn dance this replaced.
const [asked0] = await Promise.all([
  callTool("request_grant", { kind: "message", operations: ["query"], why: "to count what I created" }, conv, 30_000),
  (async () => {
    // Approving the narrow option withdraws the wider bootstrap grant on that kind (grants union,
    // so a narrow grant beside a broad one changes nothing) while KEEPING the operations it was not
    // asked about. Getting that wrong killed a live session: narrowing `query` on `message` retired
    // the bootstrap {put, query} grant wholesale, and the chat died writing its next message.
    for (let i = 0; i < 60; i++) {
      const pending = await admin.query({ kind: "grant_request", match: { conversationId: conv } }, 10, { dir: "desc" });
      if (pending.some((r) => !(r.body as { decision?: string }).decision)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await reviewGrantRequests(session, admin, CHAT_USER, conv, () => Promise.resolve("own"));
  })(),
]);
check("request_grant succeeds", asked0.ok, JSON.stringify(asked0.output).slice(0, 70));
// The whole point of blocking: the answer comes back to the ASKER, in the same turn, and says what
// it actually got. The requester asked for one scope and may have been given another.
const decision = asked0.output as { decision?: string; granted?: { scope?: string } };
check("…and returns the human's decision to the caller", decision.decision === "granted", JSON.stringify(decision).slice(0, 90));
check("…including the scope actually granted", decision.granted?.scope === "own records only", decision.granted?.scope ?? "(none)");

const asked = await session.query({ kind: "grant_request", match: { conversationId: conv } }, 10);
check("the request is a record the human can read", asked.length >= 1);
check("and the asker is recorded by the server, not by the body", asked[0].runtimeMeta.createdBy.startsWith("run:"));
check("the session still cannot grant itself anything", await forbidden(() =>
  session.put({ kind: "grant", body: { principal: CHAT_USER, kind: "message", operations: ["query"] } })));

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
// `stats: []` and told its user "the space is empty and healthy". The data was right, the claim
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
//    record id, kind and operation in the space: the whole point of scoping, undone by the one
//    endpoint whose payload is a list of everything that happened.
// Page to the END of the log: `getEvents` walks forward from a cursor, so reading only the first
// page of a busy space says nothing about events written recently, which is exactly where this
// session's own activity is.
async function drainEvents(c: typeof admin) {
  const out: { runId: string; kind?: string }[] = [];
  let cursor: string | undefined = "0";
  // Paged by `nextAfter`, not by "did this page have anything": for a scoped caller a page can be
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
//     agent actually reads records through, not only on the ops aggregates. This was live: a
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

// 7. An operator still sees everything. The scope narrowed the caller, not the space.
const all = await admin.getStats();
check("the operator still sees both authors", all.filter((s) => s.kind === "message").reduce((a, s) => a + s.count, 0) === 6);

// 8. The `role` index: the aggregation the model reached for four times and could not make.
const byRole = await session.query({ kind: "message", match: { conversationId: conv, role: "user" } }, 50);
check("messages are countable by role", byRole.length === 4, `role=user -> ${byRole.length}`);

// 9. Approving a grant for a kind that DOES NOT EXIST must not manufacture one.
//
// The guess is usually a tool name (`space_events` is a tool; `event_log` is nothing), and the
// approver is warned. But approving anyway used to write a real grant record and print
// "granted: …" while the requester was told `no_such_kind`. The human read success, the assistant
// read failure, and the space kept a grant naming a kind nobody can hold records of. All three
// have to agree.
const bogus = "event_log";
const [askedBogus] = await Promise.all([
  callTool("request_grant", { kind: bogus, operations: ["query"], scope: "all", why: "full history" }, conv, 30_000),
  (async () => {
    for (let i = 0; i < 60; i++) {
      const rows = await admin.query({ kind: "grant_request", match: { conversationId: conv } }, 20, { dir: "desc" });
      if (rows.some((r) => {
        const b = r.body as { kind?: string; decision?: string };
        return b.kind === bogus && !b.decision;
      })) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // The human APPROVES. That is the case that used to lie.
    await reviewGrantRequests(session, admin, CHAT_USER, conv, () => Promise.resolve("own"));
  })(),
]);
const bogusOut = askedBogus.output as { ok?: boolean; decision?: string; kindsOnThisSpace?: string[] };
check("approving a nonexistent kind reports no_such_kind", bogusOut.decision === "no_such_kind", JSON.stringify(bogusOut).slice(0, 70));
check("…and tells the caller it got nothing", bogusOut.ok === false);
check("…and hands back the real kind names", (bogusOut.kindsOnThisSpace ?? []).includes("message"));

const bogusGrants = await admin.query({ kind: "grant", match: { principal: CHAT_USER, kind: bogus } }, 20);
check("no grant record is written for a kind that does not exist", bogusGrants.length === 0, `${bogusGrants.length} found`);

const decidedBogus = (await admin.query({ kind: "grant_request", match: { conversationId: conv } }, 50, { dir: "desc" }))
  .map((r) => r.body as Record<string, unknown>)
  .find((b) => b.kind === bogus && b.decision);
check("the decision record says why", decidedBogus?.decision === "no_such_kind", String(decidedBogus?.decision));
check("…and claims no grant", decidedBogus?.granted === undefined);

const perms = await admin.permissions(CHAT_USER) as { kinds: { kind: string }[] };
check("the bogus kind never reaches effective permissions", !perms.kinds.some((k) => k.kind === bogus));

// The guard rejects the SHAPE, not the asker: the same approval on a real kind still grants.
// Written directly rather than through `request_grant`, which blocks until a human answers.
await session.put({
  kind: "grant_request",
  body: { conversationId: conv, kind: "llm_call", operations: ["query"], why: "count my calls" },
});
await reviewGrantRequests(session, admin, CHAT_USER, conv, () => Promise.resolve("own"));
const realGrants = await admin.query({ kind: "grant", match: { principal: CHAT_USER, kind: "llm_call" } }, 20);
check(
  "the same approval on a REAL kind still writes a grant",
  realGrants.some((r) => !(r.body as { retired?: boolean }).retired),
  `${realGrants.length} grant records for llm_call`,
);

// 10. `client.grant()` must be able to REVIVE a retired grant.
//
// The helper is content-keyed so re-running a fleet does not append a duplicate per grant. That
// key alone cannot revive: once a retirement is the newest record, re-granting the same content
// replays the retirement. Nothing is written, the call reports success, and the principal keeps
// nothing. `createAgentDefinition` was fixed for this; the SDK helper is the other way in, and
// `examples/stress/stress.ts` uses it.
const D1 = "agent:d1-revive";
const first = await admin.grant(D1, "llm_call", ["query"]);
const beforeRetire = await admin.permissions(D1) as { kinds: { kind: string }[] };
check("client.grant assigns a grant", beforeRetire.kinds.some((k) => k.kind === "llm_call"), first.id);

// Retire it the way a revocation or a supersede would: a successor carrying `retired: true`.
await admin.put({ kind: "grant", body: { principal: D1, kind: "llm_call", operations: ["query"], retired: true } });
const afterRetire = await admin.permissions(D1) as { kinds: { kind: string }[] };
check("…retiring it takes the grant away", !afterRetire.kinds.some((k) => k.kind === "llm_call"));

// Re-granting the identical content must write a NEW record, not replay the retirement.
const second = await admin.grant(D1, "llm_call", ["query"]);
check("re-granting after a retirement writes a new record", second.id !== first.id, `${first.id} -> ${second.id}`);
const revived = await admin.permissions(D1) as { kinds: { kind: string }[] };
check("…and the grant is in force again", revived.kinds.some((k) => k.kind === "llm_call"));

// Still idempotent where it should be: an unchanged re-grant against a LIVE grant writes nothing.
const third = await admin.grant(D1, "llm_call", ["query"]);
check("…while re-granting a live grant is still deduped", third.id === second.id, `${second.id} -> ${third.id}`);

// 11. The fleet's topology is visible, and a scoped session is told when it is not.
//
// This is the payoff of interests-as-records: a real worker is running above, `agentLoop` published
// what it listens for without the worker author doing anything, and the operator can now see it.
const opDigest = await admin.digest();
const edge = opDigest.interests.find((i) => i.kind === "tool_call" && i.agent === "agent:chat-tools");
check(
  "a running worker's interest is visible to the operator",
  Boolean(edge),
  `${opDigest.interests.length} edges: ${opDigest.interests.map((i) => `${i.agent}->${i.kind}`).join(", ")}`,
);
check(
  "…grouped as ONE edge per (kind, agent), with the pattern count beside it",
  (edge?.patterns ?? 0) > 1 && edge?.runs === 1,
  `${edge?.patterns} patterns across ${edge?.runs} run`,
);
check("the operator's digest withholds nothing", opDigest.interestsWithheld === undefined);

// The scoped session sees only its own, which is none: it is not a worker. Reporting that as an
// empty list would have the model announce an idle fleet while five workers are running.
const sessionDigest = await session.digest();
check(
  "a scoped session is TOLD its interest list is partial",
  (sessionDigest.interestsWithheld ?? 0) > 0 && Boolean(sessionDigest.interestsNote),
  `withheld ${sessionDigest.interestsWithheld}`,
);
check(
  "…and the note says an empty list is not an idle fleet",
  (sessionDigest.interestsNote ?? "").includes("does NOT mean nothing is listening"),
);
check("…while the rest of the digest still answers", sessionDigest.kinds.length > 0, `${sessionDigest.kinds.length} kinds`);

// ── 5. what [own] TAKES AWAY, disclosed before the choice ────────────────────────────────────────
//
// Narrowing retires the wider grant carrying the same operations — correct, since grants union and
// leaving the broad one standing makes the narrowing theatre. It also means the conservative-sounding
// answer is DESTRUCTIVE, and a live session lost its workspace-file reads that way: it held
// `artifact: read_one` patterned to its owner, the assistant misdiagnosed an unrelated failure as a
// permissions problem, the human chose [own] to be careful, and the working grant was retired for a
// self-scoped one matching nothing. The consequence line existed and printed AFTER the decision.
//
// So this asserts three things: that the cost is REAL (the read stops working), that it is disclosed,
// and that the disclosure arrives BEFORE the options rather than after the fact.
await admin.put({
  kind: "grant",
  body: { principal: CHAT_USER, kind: "artifact", operations: ["read_one"], pattern: { owner: CHAT_USER } },
});
const theirs = await admin.putArtifact(new TextEncoder().encode("a file in a tree\n"), {
  mediaType: "text/plain",
  // Stamped the way a workspace file is (`writeWorkspace` sets the same fields), so the pattern on
  // the wider grant matches it and the read below genuinely goes through that grant.
  meta: { owner: CHAT_USER, conversationId: conv },
});
check("the session reads an artifact through its WIDER grant", (await session.getArtifact(theirs.id)).length > 0);

await session.put({
  kind: "grant_request",
  body: { principal: CHAT_USER, kind: "artifact", operations: ["read_one"], why: "to read a file", conversationId: conv },
});

// `write` goes straight to Deno.stdout, so the prompt is captured at the descriptor. try/finally,
// or a failure here would swallow the rest of this suite's output.
const realWrite = Deno.stdout.writeSync.bind(Deno.stdout);
let prompt = "";
try {
  Deno.stdout.writeSync = (b: Uint8Array) => {
    prompt += new TextDecoder().decode(b);
    return b.length;
  };
  await reviewGrantRequests(session, admin, CHAT_USER, conv, () => Promise.resolve("own"));
} finally {
  Deno.stdout.writeSync = realWrite;
}

const plain = prompt.replace(/\x1b\[[0-9;]*m/g, "");
check("the prompt warns that [own] REMOVES existing access", /\[own\] REMOVES access this session already has/.test(plain));
check("…naming the operation and kind that would go", /read_one on artifact/.test(plain), plain.split("\n").find((l) => l.includes("REMOVES")) ?? "(absent)");
// THE ORDERING IS THE FIX. The receipt was always printed; a cost disclosed after the choice is not
// a disclosure, so the warning has to precede the options it is about.
const warnAt = plain.indexOf("REMOVES access");
const optionAt = plain.indexOf("[own] its OWN records");
check("…before the options, not after the decision", warnAt >= 0 && optionAt > warnAt, `warn@${warnAt} option@${optionAt}`);
// And an option that takes access away must never be the recommended one.
check(
  "…and [own] is not recommended when it would take something away",
  !/\[own\][^\n]*\(recommended\)/.test(plain),
  plain.split("\n").find((l) => l.includes("[own] its OWN")) ?? "(absent)",
);

// The cost is real, which is what makes the warning load-bearing rather than decorative. If
// narrowing is ever made non-destructive, this fails and the warning should go with it.
//
// And it fails as 404, not 403 — deliberately. A scoped principal must not be able to tell
// "someone else's record" from "no such record", or a per-record endpoint becomes an existence
// oracle. Asserting the CODE rather than just the failure keeps that property pinned here too: an
// earlier draft of this check looked for "forbidden" and read the correct 404 as a regression.
const after = await (async () => {
  try {
    await session.getArtifact(theirs.id);
    return "readable";
  } catch (e) {
    return String(e);
  }
})();
check("the wider read is genuinely gone afterwards", after !== "readable", after.slice(0, 60));
check("…and answers 404, so it is not an existence oracle", /not_found/.test(after), after.slice(0, 60));

try {
  worker.kill();
  space.kill();
} catch { /* already gone */ }
Deno.exit(0);
