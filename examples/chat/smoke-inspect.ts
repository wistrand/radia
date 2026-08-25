// The inspection TOOLS themselves, against a busy space:
//
//   deno run -A examples/chat/smoke-inspect.ts
//
// The distinction this suite exists for: `smoke-selfgrant.ts` proves the SERVER's scoped-ops
// contract, and it does so by paging the event log itself. The chat does not reach the server
// directly; it reaches it through `extensions/ts/agent-tools.ts`, and those were the broken half.
// A live session asked "what happened in my space", got `{events: [], withheld: 500}` from a log of
// 11,588, retried, got the identical answer with the identical cursor, and reported that its
// pending grant must not have been approved. Every layer under the tool was behaving correctly.
//
// So: drive the tools, not the client, and make the space busy enough that a single page cannot
// reach the session's own activity.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { CHAT_USER, mintSession } from "./space/roles.ts";
import { INSPECT_SCHEMAS, makeInspectTools } from "../../extensions/ts/agent-tools.ts";
import { reviewGrantRequests } from "./client/grants.ts";
import { installUI } from "./client/ui.ts";
import { terminalUI } from "./client/terminal.ts";

installUI(terminalUI); // a suite prints, and the protocol half no longer brings a terminal with it

const PORT = 7802;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT)],
  stdout: "null",
  stderr: "inherit",
}).spawn();

const probe = new RadiaClient(url); // liveness only: /v0/health is public
let admin: RadiaClient;
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
// The conversation exists before the credential that is scoped to it (see chat.ts).
const mine = (await admin.put({ kind: "conversation", body: { title: "mine" } })).id;
const sessionToken = await mintSession(admin, CHAT_USER, { conversationId: mine });
const session = new RadiaClient(url, { token: sessionToken! });
const tools = makeInspectTools(session);

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

// A wall of somebody else's activity, ahead of anything this session does. Each put is an event,
// so this is ~700 events the session may not see, sitting in front of its own.
const conv = (await admin.put({ kind: "conversation", body: { title: "theirs" } })).id;
for (let i = 0; i < 700; i++) {
  await admin.put({ kind: "message", body: { conversationId: conv, role: "user", index: i, content: `theirs ${i}` } });
}

// …and then the session's own, at the far end of the log.
const myRecords = new Set<string>([mine]);
for (let i = 0; i < 3; i++) {
  const { id } = await session.put({ kind: "message", body: { conversationId: mine, role: "user", index: i, content: `mine ${i}` } });
  myRecords.add(id);
}

// The session's ops access, as the transcript's session had it: a self-scoped read grant on the
// kind it writes. Without at least one, the ops plane is shut entirely and there is nothing to page.
await admin.put({
  kind: "grant",
  body: {
    principal: "agent:chat-user",
    kind: "message",
    operations: ["query", "read_one"],
    scope: { createdBy: "self" },
    // Patterned to the same conversation as the base grant. Without this the grant UNIONS with the
    // patterned one and reopens every conversation: a widening performed by adding a "narrower"
    // grant, which is why the approval flow now inherits the pattern it is narrowing.
    pattern: { conversationId: mine },
  },
});

// ---- the bug from the transcript ----
const ev = await tools.space_events({ limit: 20 }) as {
  events: { recordId?: string }[];
  withheld?: number;
  withheldNote?: string;
  complete?: boolean;
  scope?: unknown;
};
check("space_events reaches the session's own activity past a wall of foreign events", ev.events.length > 0, `${ev.events.length} events, ${ev.withheld ?? 0} withheld`);
check("…and says it reached the end of the log", ev.complete === true);
check("…and still says the answer is scoped, so empty never reads as idle", Boolean(ev.scope));
check("…and reports what it could not show", (ev.withheld ?? 0) > 0, `withheld ${ev.withheld}`);
// The number alone reads as "ask for a grant and this goes away". It does not: the log is filtered
// by WHO ACTED, so no grant on any record kind widens it. Four sessions in a row spent their turns
// requesting kind grants (and inventing kinds to request) chasing an answer no grant can give.
check(
  "…and says why, so the count does not read as a missing grant",
  (ev.withheldNote ?? "").includes("filtered by which principal performed the operation"),
  (ev.withheldNote ?? "(none)").slice(0, 60),
);

// The events it did return must be the session's OWN records, not a leak from the wall it paged
// through. Paging further must not widen what a scoped caller sees, only reach more of it.
const leaked = ev.events.filter((e) => e.recordId !== undefined && !myRecords.has(e.recordId));
check("paging further does not leak another author's events", leaked.length === 0, `${leaked.length} foreign of ${ev.events.length}`);

// ---- one session, one conversation ----
// The leak this closes: every chat session runs as the SAME `agent:chat-user`, so a kind-scoped
// `message: query` grant let any session read every message in the space. A ten-minute session
// reconstructed two days of other people's conversations from it. It did so correctly, because
// nothing enforced the "its own results" the grant comment claimed. The grants are now
// pattern-scoped to the conversation the session is attached to.
const visible = await tools.space_query({ kind: "message", limit: 25 }) as { count: number; more: boolean };
check(
  "a session reads only ITS conversation's messages",
  visible.count === 3 && !visible.more,
  `${visible.count}${visible.more ? "+" : ""} of ${3 + 700} in the space`,
);
const counted = await tools.space_count({ kind: "message" }) as { count: number; scope?: { narrowedBy?: unknown[] }; distinct?: unknown };
check("…and counts only those", counted.count === 3, `${counted.count}`);
check("a kind with one record per thing reports no version count", counted.distinct === undefined);

// A count of RECORDS is not a count of THINGS on a kind that keeps its history, and the difference
// is invisible in the number. Live case: a workspace saved fifteen times answered `count: 15`, and
// that was reported as "15 instances of a workspace named fireworks" while `radia workspaces` said
// one workspace with 15 versions. Every registry here has this shape, so the count has to carry the
// correction with it — prose in a description arrives after the number has already been quoted.
type Counted = { count: number; distinct?: { by: string; count: number; note: string } };
for (let v = 0; v < 4; v++) {
  await admin.put({ kind: "workspace", body: { name: "saved-often", conversationId: mine, owner: CHAT_USER, treeDigest: `t1:v${v}`, files: [] } });
}
await admin.put({ kind: "workspace", body: { name: "saved-once", conversationId: mine, owner: CHAT_USER, treeDigest: "t1:x", files: [] } });
const ws = await tools.space_count({ kind: "workspace" }) as Counted;
check("a registry kind's count is of VERSIONS, and says so", ws.count === 5 && ws.distinct?.count === 2, `${ws.count} records, ${ws.distinct?.count} distinct`);
check("…naming the field it deduplicated on", ws.distinct?.by === "name", ws.distinct?.by ?? "(none)");
check("…and saying which number to report", (ws.distinct?.note ?? "").includes("VERSIONS"), (ws.distinct?.note ?? "").slice(0, 60));

// The reason four sessions in a row reported their own slice as the space: a narrowed read looked
// exactly like an unrestricted one. The ops plane has always described its scope; the coordination
// plane (the one the assistant actually reads records through) never did, so "3 messages" was
// indistinguishable from "this space has 3 messages".
const scoped = visible as unknown as { scope?: { narrowedBy?: Record<string, unknown>[]; note?: string } };
check("a narrowed query SAYS it was narrowed", Boolean(scoped.scope), JSON.stringify(scoped.scope ?? {}).slice(0, 70));
check(
  "…and names what narrowed it, so the limit is explainable rather than mysterious",
  JSON.stringify(scoped.scope?.narrowedBy ?? []).includes(mine),
);
check("a narrowed COUNT says so too, since it is the number most likely to be quoted", Boolean(counted.scope));

// …and an unrestricted read stays exactly as it was: no scope, nothing for a caller to explain away.
const openRead = await admin.queryPage({ kind: "message" }, 5);
check("an unrestricted read carries no scope at all", openRead.scope === undefined);
check(
  "…while the other conversation's messages are really there",
  (await admin.queryOldest({ kind: "message", match: { conversationId: conv } }, 5)).length === 5,
);

// A pattern scope binds writes too: the body must match, so a session cannot file records into
// another conversation any more than it can read one.
let wroteElsewhere = true;
try {
  await session.put({ kind: "message", body: { conversationId: conv, role: "user", index: 999, content: "intrusion" } });
} catch {
  wroteElsewhere = false;
}
check("…and cannot write into another conversation either", !wroteElsewhere);

// The kinds keyed by callId rather than by conversation: `llm_chunk`, `llm_result`, `tool_result`.
// They carry `conversationId` solely so a grant can bind them. A session that learned a callId
// from elsewhere could otherwise read another conversation's streamed tokens, model output, or
// tool results, none of which the conversation scoping above touches.
const theirCall = "call-elsewhere";
await admin.put({ kind: "llm_result", body: { callId: theirCall, conversationId: conv, message: { role: "assistant", content: "secret" } } });
await admin.put({ kind: "tool_result", body: { callId: theirCall, conversationId: conv, ok: true, output: "secret" } });
await admin.put({ kind: "llm_chunk", body: { callId: theirCall, conversationId: conv, index: 0, delta: "secret" } });

check("another conversation's llm_result is unreadable even with its callId",
  (await session.readOne({ kind: "llm_result", match: { callId: theirCall } })) === null);
check("…its tool_result too",
  (await session.readOne({ kind: "tool_result", match: { callId: theirCall } })) === null);
check("…and its streamed chunks",
  (await session.queryOldest({ kind: "llm_chunk", match: { callId: theirCall } }, 10)).length === 0);

// The other direction, which is what breaks the chat if a writer forgets the field: the session
// must still read its OWN results. A missed stamp is not a leak, it is a hang.
const myCall = "call-mine";
await admin.put({ kind: "llm_result", body: { callId: myCall, conversationId: mine, message: { role: "assistant", content: "ok" } } });
await admin.put({ kind: "tool_result", body: { callId: myCall, conversationId: mine, ok: true, output: "ok" } });
await admin.put({ kind: "llm_chunk", body: { callId: myCall, conversationId: mine, index: 0, delta: "ok" } });
check("its own llm_result is readable", (await session.readOne({ kind: "llm_result", match: { callId: myCall } })) !== null);
check("its own tool_result is readable", (await session.readOne({ kind: "tool_result", match: { callId: myCall } })) !== null);
check("its own chunks are readable", (await session.queryOldest({ kind: "llm_chunk", match: { callId: myCall } }, 10)).length === 1);

// Artifacts. The last kind a session could not be scoped on: the body is computed from the bytes,
// so until `putArtifact` accepted application fields there was nothing for a pattern to bind and
// any holder of an id could read the bytes.
const theirArt = await admin.putArtifact(new TextEncoder().encode("their secret"), {
  mediaType: "text/plain",
  meta: { conversationId: conv },
});
const myArt = await admin.putArtifact(new TextEncoder().encode("my bytes"), {
  mediaType: "text/plain",
  meta: { conversationId: mine },
});
const canRead = async (id: string) => {
  try {
    await session.getArtifact(id);
    return true;
  } catch {
    return false;
  }
};
check("another conversation's artifact bytes are refused", !(await canRead(theirArt.id)));
check("…while its own are served", await canRead(myArt.id));
check(
  "…and the runtime's own fields survive the app's",
  (await admin.getRecord(myArt.id))!.body !== null &&
    typeof ((await admin.getRecord(myArt.id))!.body as { digest?: string }).digest === "string",
);

// ---- being able to answer "which grants do i have" ----
const perms = await tools.space_permissions({}) as {
  principal: string;
  kinds?: { kind: string; operations: string[]; readsScopedToSelf?: boolean }[];
  complete?: boolean;
};
check("space_permissions answers for a SCOPED session, not just an operator", Array.isArray(perms.kinds), perms.principal);
check("…and names the principal it answered for", perms.principal.startsWith("run:") || perms.principal.startsWith("agent:"), perms.principal);
check("…and lists the kinds the session can actually read", (perms.kinds ?? []).some((k) => k.kind === "message"), (perms.kinds ?? []).map((k) => k.kind).join(","));
check("…and the view is complete, not a prefix", perms.complete !== false);

// The question the transcript could not answer: was my grant approved? A kind never granted must
// be absent, and one that was granted must be present. That is the whole point of asking the
// enforcement instead of inferring from another call's scope line. `model` is the exemplar
// because sessions never hold it (it is a worker registry); `kind_def` used to be, until it
// joined the standard set — a fixture premise, not a lesson, so it moved.
check("a kind that was never granted is absent", !(perms.kinds ?? []).some((k) => k.kind === "model"));
await admin.put({ kind: "grant", body: { principal: "agent:chat-user", kind: "model", operations: ["query", "read_one"], scope: { createdBy: "self" } } });
const after = await tools.space_permissions({}) as { kinds?: { kind: string; readsScopedToSelf?: boolean }[] };
const modelGrant = (after.kinds ?? []).find((k) => k.kind === "model");
check("a newly granted kind shows up immediately", Boolean(modelGrant));
check("…and says the read is narrowed to its own records", modelGrant?.readsScopedToSelf === true);

// ---- "reads only" must mean reads only ----
// A live session asked for `["query","read_one","take"]` on `llm_call`; the prompt offered "only its
// OWN records, reads only" and then granted `take` verbatim. The label was false, and on a work
// kind that grant lets a chat session CLAIM calls the inference fleet is waiting for.
const claimy = await askAndAnswer(
  { kind: "llm_call", operations: ["query", "read_one", "take"], why: "to survey activity", scope: "own" },
  "own",
);
const claimyPrompt = claimy.prompt;
check("the prompt flags an operation that is not a read", claimyPrompt.includes("which is not a read") || claimyPrompt.includes("which are not a read"));
check("…and warns what 'take' does to a work kind", claimyPrompt.includes("CLAIMS records"));
const claimyGrant = (claimy.result as { granted?: { operations?: string[]; withheld?: string[] } }).granted;
check(
  "the narrow answer grants the reads and withholds the claim",
  JSON.stringify(claimyGrant?.operations) === JSON.stringify(["query", "read_one"]),
  JSON.stringify(claimyGrant?.operations),
);
check("…and says so, rather than reporting a bare success", (claimyGrant?.withheld ?? []).includes("take"));
const canTake = await session.take({ pattern: { kind: "llm_call" } }, { leaseSeconds: 5 }).then(() => true).catch(() => false);
check("…so the session still cannot claim the fleet's work", !canTake);

// An answer that is neither option must not silently become one. `y` read as plain "yes" and meant
// the NARROW grant, so a person answering "yes" to "shall I look wider?" got the opposite of what
// they said. That happened twice, in consecutive sessions, each costing the assistant its next
// turns.
const ambiguous = await askAndAnswer(
  { kind: "progress", operations: ["query"], why: "to read progress records", scope: "all" },
  ["yes", "all"],
);
check("'yes' is not accepted as an answer", ambiguous.prompt.includes("is not one of them"));
check(
  "…and the options are named, so nothing reads as a plain yes",
  !ambiguous.prompt.includes("[y]") && ambiguous.prompt.includes("[own]") && ambiguous.prompt.includes("[all]"),
);
check(
  "…and the re-ask is what decides",
  (ambiguous.result as { granted?: { scope?: string } }).granted?.scope === "all records",
  JSON.stringify((ambiguous.result as { granted?: unknown }).granted ?? {}).slice(0, 70),
);

// ---- a guessed kind is corrected IN THE TURN, not discovered a round later ----
// A session that cannot list kinds guesses, and the guess is usually a tool name: `space_event`
// for the `space_events` tool, twice in consecutive sessions. Approving it produced a grant that
// authorized nothing and the assistant only found out by using it. The decision now carries the
// real names back to the asker.
const guessed = await askAndAnswer(
  { kind: "space_event", operations: ["query"], why: "to read the activity log", scope: "all" },
  "own",
);
const guessedOut = guessed.result as { ok: boolean; decision?: string; kindsOnThisSpace?: string[]; note?: string };
check("a guessed kind comes back as no_such_kind, not as success", guessedOut.decision === "no_such_kind", guessedOut.decision ?? "?");
check("…and the answer is not ok, so the caller cannot read it as authority", guessedOut.ok === false);
check(
  "…and it names the kinds that DO exist, so the next ask can be right",
  (guessedOut.kindsOnThisSpace ?? []).includes("message"),
  (guessedOut.kindsOnThisSpace ?? []).slice(0, 5).join(","),
);
// A kind an app REDECLARES (the chat does this to `artifact`) is both a kind_def record and a
// reserved name, and the list read "artifact" twice back to the user.
const listed2 = guessedOut.kindsOnThisSpace ?? [];
check("…each kind once", new Set(listed2).size === listed2.length, listed2.filter((k, i) => listed2.indexOf(k) !== i).join(",") || "no duplicates");

// ---- the phantom kind from the transcript ----
// The assistant asked for `space_event` (the name of a TOOL, not a record kind) and had it
// approved. Nothing failed: the grant exists, it appears in scope lines, and it authorizes
// absolutely nothing. The permissions view is where that has to be visible, because it is the one
// answer an agent is supposed to trust about its own authority.
await admin.put({
  kind: "grant",
  body: { principal: "agent:chat-user", kind: "space_event", operations: ["query"], scope: { createdBy: "self" } },
});
const phantom = (await tools.space_permissions({}) as { kinds?: { kind: string; kindNotDeclared?: boolean }[] })
  .kinds?.find((k) => k.kind === "space_event");
check("a grant on a kind that does not exist is reported as such", phantom?.kindNotDeclared === true);
const real = (await tools.space_permissions({}) as { kinds?: { kind: string; kindNotDeclared?: boolean }[] })
  .kinds?.find((k) => k.kind === "message");
check("…and a grant on a real kind is not flagged", real !== undefined && real.kindNotDeclared === undefined);

// ---- the trap that grant walks into ----
// `model` records are written by the launcher, never by the chat session. So the SELF-SCOPED
// read grant minted above authorizes a view of nothing, and a query answers `[]` while the
// space has tiers. The tool is behaving correctly; the GRANT is the wrong shape, which is why
// the approval prompt measures this and recommends against self-scope for such a kind.
// (`kind_def` was the original exemplar; it is in the standard set now, and grants are
// additive, so the unscoped one would win and the trap could no longer be seen through it.)
// This harness never launches the fleet, so the registry the launcher would fill is seeded here.
await admin.put({ kind: "model", body: { tier: "fast", model: "test/model" } });
const modelRows = await tools.space_query({ kind: "model", limit: 10 }) as { records: unknown[] };
check(
  "a self-scoped grant on a registry kind exposes nothing (the approval prompt warns about this)",
  modelRows.records.length === 0,
  `${modelRows.records.length} model records`,
);
const asOperator = await admin.queryOldest({ kind: "model" }, 10);
check("…while the space really does have models", asOperator.length > 0, `${asOperator.length} tiers`);


// ---------------------------------------------------------------------------
// The approval loop, from the asking side to the answer. This is the case a live session walked
// into three times in a row: a grant is requested, a human approves it, the assistant reports "the
// grant landed", and every read still returns nothing. Nothing errors. The grant is real. It
// authorizes reads of records this session never wrote.
// ---------------------------------------------------------------------------

/** Capture what the approval prompt PRINTS, so the guidance itself can be asserted on. It is the
 *  only part of this loop the human acts on, which makes it the part worth pinning. */
function capture(): () => string {
  const chunks: string[] = [];
  const orig = Deno.stdout.writeSync.bind(Deno.stdout);
  Deno.stdout.writeSync = (p: Uint8Array) => {
    chunks.push(new TextDecoder().decode(p));
    return p.length;
  };
  return () => {
    Deno.stdout.writeSync = orig;
    return chunks.join("");
  };
}

/** Ask and answer CONCURRENTLY, as the REPL does: `request_grant` blocks on the decision, and the
 *  human is prompted while it is in flight. Sequentially the ask would wait out its whole deadline
 *  before anyone was asked, which is the two-turn dance this replaced. */
async function askAndAnswer(
  request: Record<string, unknown>,
  answer: string | string[],
): Promise<{ result: unknown; prompt: string }> {
  const replies = Array.isArray(answer) ? [...answer] : [answer];
  let stop: (() => string) | undefined;
  // The QUESTION is handed to the reader rather than written ahead of it, because the line editor
  // erases the row it is about to draw and would wipe anything printed first. So the stand-in has to
  // record what it was asked: that text is on the person's screen either way, and a test that only
  // captures `write` would stop seeing half the prompt.
  let asked = "";
  const [result] = await Promise.all([
    tools.request_grant(request, { callId: "smoke", conversationId: mine }),
    (async () => {
      for (let i = 0; i < 100; i++) {
        const pending = await admin.queryNewest({ kind: "grant_request", match: { conversationId: mine } }, 10);
        if (pending.some((r) => !(r.body as { decision?: string }).decision)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      stop = capture();
      await reviewGrantRequests(session, admin, "agent:chat-user", mine, (prompt?: string) => {
        asked += prompt ?? "";
        return Promise.resolve(replies.shift() ?? "no");
      });
    })(),
  ]);
  return { result, prompt: (stop ? stop() : "") + asked };
}

// A kind only somebody else has written to: the shape that makes a self-scoped read empty.
for (let i = 0; i < 3; i++) {
  await admin.put({ kind: "procedure", body: { name: `theirs_${i}`, artifactId: "x", description: "not mine" } });
}

// --- the dead end: asking for "own" on a kind you do not write ---
const narrow = await askAndAnswer(
  { kind: "procedure", operations: ["query", "read_one"], why: "to read the saved procedures", scope: "own" },
  "own",
);
const narrowPrompt = narrow.prompt;
check(
  "the decision comes back to the asker in the same call",
  (narrow.result as { decision?: string }).decision === "granted",
  JSON.stringify(narrow.result).slice(0, 80),
);

check(
  "the prompt warns that 'own records only' would expose nothing",
  narrowPrompt.includes("written by others") && narrowPrompt.includes("NOTHING"),
);
check("…and stops recommending the narrow option", !narrowPrompt.includes("OWN records of that kind, reads only (recommended)"));
check("…and recommends the wider one instead", narrowPrompt.includes("ALL records of that kind in this space (recommended here)"));
check(
  "…and if the human narrows anyway, says plainly that the grant authorizes nothing",
  narrowPrompt.includes("and there are none"),
  narrowPrompt.split("\n").find((l) => l.includes("and there are none"))?.trim() ?? "(absent)",
);

const afterNarrow = await tools.space_query({ kind: "procedure", limit: 25 }) as { count: number };
check("the approved grant really does return nothing", afterNarrow.count === 0, `${afterNarrow.count} records`);
check("…while the records are plainly there", (await admin.queryOldest({ kind: "procedure" }, 25)).length === 3);

// --- the fix: the asker can say which it needs, and the prompt shows it ---
const wide = await askAndAnswer(
  { kind: "kind_def", operations: ["query", "read_one"], why: "to list the kinds before surveying them", scope: "all" },
  "all",
);
const widePrompt = wide.prompt;
check(
  "…and reports the scope it actually got, not just that it got something",
  (wide.result as { granted?: { scope?: string } }).granted?.scope === "all records",
  JSON.stringify(wide.result).slice(0, 90),
);

check("the prompt relays that the assistant asked for ALL records", widePrompt.includes("asked for ALL records of this kind"));
const listed = await tools.space_kinds({}) as { kinds: unknown[] };
check("and approving that way actually answers the question", listed.kinds.length > 0, `${listed.kinds.length} kinds`);

// The same ask at the narrower scope is a DIFFERENT request, not a duplicate of the one already
// handled. Otherwise re-asking un-scoped after a scoped grant disappointed would be silently
// dropped as "already reviewed".
const requests = await session.queryOldest({ kind: "grant_request", match: { conversationId: mine } }, 50);
const scopes = new Set(requests.map((r) => (r.body as { kind: string; scope?: string }).kind + ":" + ((r.body as { scope?: string }).scope ?? "own")));
check("a re-ask at a different scope is its own request", scopes.has("kind_def:all") && scopes.has("procedure:own"), [...scopes].join(" "));

// The point of the recent surface: the chat can inspect ITSELF through the same tools the model
// holds. Driven as the operator (admin) because the scoped session's route to these is the
// escalation flow, which smoke-selfgrant already covers.
const adminTools = makeInspectTools(admin);
const digest = await adminTools.space_digest({}, undefined) as {
  kinds: { kind: string }[];
  interests: { kind: string; agent?: string }[];
  complete: boolean;
  permissions: unknown;
};
check("space_digest orients in one call", digest.kinds.some((k) => k.kind === "message"), `${digest.kinds.length} kinds`);
check("…and is complete, never a silent prefix", digest.complete === true);
check("…and includes what the caller may do", digest.permissions !== undefined);

// A conversation is a thread: ask from a record in the MIDDLE and get the whole story. The other
// messages in this suite are written flat (no parentIds) because nothing above needed lineage; the
// real client parents every message, so this one is written the way the chat writes it.
const linked = await admin.put({
  kind: "message",
  body: { conversationId: mine, role: "user", index: 100, content: "linked" },
  parentIds: [mine],
});
await admin.put({ kind: "llm_call", body: { conversationId: mine, messages: [] }, parentIds: [linked.id] });
const story = await adminTools.space_thread({ recordId: linked.id }, undefined) as {
  root: string;
  count: number;
  records: { id: string }[];
};
check("space_thread finds the conversation from one of its messages", story.root === mine, `root ${story.root}`);
check("…and the story holds the ancestor and the descendant too", story.count >= 3, `${story.count} records`);

// The server explains a bad query instead of letting it succeed silently.
const misquery = await adminTools.space_query({ kind: "no_such_kind" }, undefined) as { notes?: string[] };
check(
  "space_query carries the server's notes for an undeclared kind",
  (misquery.notes ?? []).some((n) => n.includes("no kind 'no_such_kind'")),
  (misquery.notes ?? []).join(" | ").slice(0, 80),
);

// THE CHAT'S OWN RETENTION DECLARATIONS, pinned where they are actually declared. The GC
// conformance suite proves the MECHANISM with kinds of its own, so deleting the three
// `defaultRetentionSeconds` lines from space/kinds.ts would leave every suite green while chunks
// went back to being permanent — the exact silent regression that made them permanent for a month.
// The chunk written above went through `registerChatKinds`, so its stamp is the declaration's.
// ── what a turn COST is a query, not a body nobody can address ──────────────────────────────────
// The provider's `usage` was written onto every assistant message from the start and reachable by
// nothing: an undeclared body field is invisible to matching AND to `space_digest`, so an agent
// asked "which call used most tokens" could not discover the numbers existed.
const priced = (await admin.put({ kind: "conversation", body: {} })).id;
const spend = (i: number, tokens: number, cost: number) =>
  admin.put({
    kind: "message",
    body: { conversationId: priced, owner: CHAT_USER, index: i, role: "assistant", usage: { total_tokens: tokens, cost } },
    parentIds: [priced],
  });
// Anti-correlated on purpose: this is what a mixed-tier turn really looks like, and it is why cost
// is ranked separately rather than inferred from tokens.
await spend(0, 13100, 0.00283);
await spend(1, 16900, 0.00128);
await spend(2, 41000, 0.00065);
await admin.put({ kind: "message", body: { conversationId: priced, owner: CHAT_USER, index: 3, role: "user", content: "asks" }, parentIds: [priced] });

const rank = async (path: string) =>
  (await admin.queryOrdered({ kind: "message", match: { conversationId: priced, role: "assistant" }, orderBy: [{ path, dir: "desc" }] }, 3)).map((r) => (r.body as { usage?: Record<string, number> }).usage ?? {});
const topTokens = await rank("usage.total_tokens");
const topCost = await rank("usage.cost");
check("the biggest call by TOKENS is a query", topTokens[0]?.total_tokens === 41000, JSON.stringify(topTokens.map((u) => u.total_tokens)));
check("…and the priciest is a DIFFERENT one", topCost[0]?.cost === 0.00283, JSON.stringify(topCost.map((u) => u.cost)));
check("…so cost is not inferable from tokens", topTokens[0]?.total_tokens !== undefined && topCost[0]?.cost !== 0.00065);
const pricey = await admin.queryOldest({ kind: "message", match: { conversationId: priced, "usage.cost": { $gt: 0.002 } } }, 10);
check("a fractional path is matchable too, not only sortable", pricey.length === 1, `${pricey.length} over $0.002`);

// THROUGH THE TOOL, not only the client — a wrapper is a place a bug can hide from every test of
// the thing it wraps. This is the exact call an assistant needs for "which call used most tokens",
// and the two rules its description teaches: rank on the kind that DECLARES the field, and pair a
// desc sort with $exists.
// In the SESSION's own conversation, because the tool runs under the scoped session: records in
// another thread are (correctly) invisible to it, which the first version of this case proved by
// accident.
for (const [i, tok] of [[301, 7000], [302, 21000]] as const) {
  await admin.put({
    kind: "message",
    body: { conversationId: mine, owner: CHAT_USER, index: i, role: "assistant", usage: { total_tokens: tok, cost: tok / 1e7 } },
    parentIds: [mine],
  });
}
const ranked = await tools.space_query({
  kind: "message",
  match: { "usage.total_tokens": { $exists: true } },
  orderBy: [{ path: "usage.total_tokens", dir: "desc" }],
  limit: 3,
}) as { records?: { body?: { usage?: { total_tokens?: number } } }[] };
check(
  "the space_query TOOL answers 'which call used most tokens'",
  ranked.records?.[0]?.body?.usage?.total_tokens === 21000,
  JSON.stringify(ranked.records?.map((r) => r.body?.usage?.total_tokens)),
);
// The description is where the model learns both rules; a reworded description that drops them is
// this failure shipping again (the pattern smoke-save uses for edit_workspace's own rules).
const qDesc = (INSPECT_SCHEMAS.find((d) => d.function.name === "space_query")?.function.description) ?? "";
check("…and its description teaches the $exists pairing", /\$exists: true\}\}/.test(qDesc) && /MISSING the field sort FIRST/.test(qDesc));
check("…and to query the kind that DECLARES the field", /DECLARES the field/.test(qDesc));

// THE TRAP, pinned so it is not rediscovered: `desc` negates the whole comparison, including the
// missing-value rule, so a record with NO usage sorts FIRST. "The biggest" would be a user message.
const unfiltered = await admin.queryOrdered({ kind: "message", match: { conversationId: priced }, orderBy: [{ path: "usage.total_tokens", dir: "desc" }] }, 1);
check(
  "a descending sort puts records with NO value first, so the match must exclude them",
  (unfiltered[0]?.body as { role?: string }).role === "user",
  JSON.stringify((unfiltered[0]?.body as { role?: string }).role),
);

const stamped = await admin.queryOldest({ kind: "llm_chunk", match: { callId: myCall } }, 1);
check("an llm_chunk is born with the kind's retention stamped in", Boolean(stamped[0]?.retentionUntil), stamped[0]?.retentionUntil ?? "(none)");
const { id: callRec } = await admin.put({ kind: "llm_call", body: { conversationId: mine } });
check("an llm_call too", Boolean((await admin.getRecord(callRec))?.retentionUntil));
const { id: prog } = await admin.put({ kind: "progress", body: { conversationId: mine, callId: myCall, stage: "running", by: "agent:x" } });
check("and a progress record", Boolean((await admin.getRecord(prog))?.retentionUntil));
// The other side of the same declaration: the THREAD is permanent. A default that leaked onto
// `message` would quietly give conversations an expiry date nobody chose.
const { id: msg } = await admin.put({ kind: "message", body: { conversationId: mine, role: "user", index: 99, content: "keep me" } });
check("a message carries NO retention: the thread is permanent", (await admin.getRecord(msg))?.retentionUntil === undefined);

space.kill();
await space.status;
console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
