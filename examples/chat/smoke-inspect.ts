// The inspection TOOLS themselves, against a busy space:
//
//   deno run -A examples/chat/smoke-inspect.ts
//
// The distinction this suite exists for: `smoke-selfgrant.ts` proves the SERVER's scoped-ops
// contract, and it does so by paging the event log itself. The chat does not reach the server
// directly — it reaches it through the tools in `tools/space.ts`, and those were the broken half.
// A live session asked "what happened in my space", got `{events: [], withheld: 500}` from a log of
// 11,588, retried, got the identical answer with the identical cursor, and reported that its
// pending grant must not have been approved. Every layer under the tool was behaving correctly.
//
// So: drive the tools, not the client, and make the space busy enough that a single page cannot
// reach the session's own activity.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { bootstrap } from "./space/roles.ts";
import { makeInspectTools } from "./tools/space.ts";
import { reviewGrantRequests } from "./client/grants.ts";

const PORT = 7802;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT)],
  stdout: "null",
  stderr: "inherit",
}).spawn();

const admin = new RadiaClient(url);
for (let i = 0; i < 100; i++) {
  try {
    await admin.health();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
await registerChatKinds(admin);
// The conversation exists before the credential that is scoped to it (see chat.ts).
const mine = (await admin.put({ kind: "conversation", body: { title: "mine" } })).id;
const { sessionToken } = await bootstrap(admin, "user", mine);
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
    // Templated to the same conversation as the base grant. Without this the grant UNIONS with the
    // templated one and reopens every conversation — a widening performed by adding a "narrower"
    // grant, which is why the approval flow now inherits the template it is narrowing.
    template: { conversationId: mine },
  },
});

// ---- the bug from the transcript ----
const ev = await tools.space_events({ limit: 20 }) as {
  events: { recordId?: string }[];
  withheld?: number;
  complete?: boolean;
  scope?: unknown;
};
check("space_events reaches the session's own activity past a wall of foreign events", ev.events.length > 0, `${ev.events.length} events, ${ev.withheld ?? 0} withheld`);
check("…and says it reached the end of the log", ev.complete === true);
check("…and still says the answer is scoped, so empty never reads as idle", Boolean(ev.scope));
check("…and reports what it could not show", (ev.withheld ?? 0) > 0, `withheld ${ev.withheld}`);

// The events it did return must be the session's OWN records, not a leak from the wall it paged
// through — paging further must not widen what a scoped caller sees, only reach more of it.
const leaked = ev.events.filter((e) => e.recordId !== undefined && !myRecords.has(e.recordId));
check("paging further does not leak another author's events", leaked.length === 0, `${leaked.length} foreign of ${ev.events.length}`);

// ---- one session, one conversation ----
// The leak this closes: every chat session runs as the SAME `agent:chat-user`, so a kind-scoped
// `message: query` grant let any session read every message in the space. A ten-minute session
// reconstructed two days of other people's conversations from it — correctly, because nothing
// enforced the "its own results" the grant comment claimed. The grants are now template-scoped to
// the conversation the session is attached to.
const visible = await tools.space_query({ kind: "message", limit: 25 }) as { count: number; more: boolean };
check(
  "a session reads only ITS conversation's messages",
  visible.count === 3 && !visible.more,
  `${visible.count}${visible.more ? "+" : ""} of ${3 + 700} in the space`,
);
const counted = await tools.space_count({ kind: "message" }) as { count: number };
check("…and counts only those", counted.count === 3, `${counted.count}`);
check(
  "…while the other conversation's messages are really there",
  (await admin.query({ kind: "message", match: { conversationId: conv } }, 5)).length === 5,
);

// A template scope binds writes too: the body must match, so a session cannot file records into
// another conversation any more than it can read one.
let wroteElsewhere = true;
try {
  await session.put({ kind: "message", body: { conversationId: conv, role: "user", index: 999, content: "intrusion" } });
} catch {
  wroteElsewhere = false;
}
check("…and cannot write into another conversation either", !wroteElsewhere);

// The kinds keyed by callId rather than by conversation: `llm_chunk`, `llm_result`, `tool_result`.
// They carry `conversationId` solely so a grant can bind them — a session that learned a callId
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
  (await session.query({ kind: "llm_chunk", match: { callId: theirCall } }, 10)).length === 0);

// The other direction, which is what breaks the chat if a writer forgets the field: the session
// must still read its OWN results. A missed stamp is not a leak, it is a hang.
const myCall = "call-mine";
await admin.put({ kind: "llm_result", body: { callId: myCall, conversationId: mine, message: { role: "assistant", content: "ok" } } });
await admin.put({ kind: "tool_result", body: { callId: myCall, conversationId: mine, ok: true, output: "ok" } });
await admin.put({ kind: "llm_chunk", body: { callId: myCall, conversationId: mine, index: 0, delta: "ok" } });
check("its own llm_result is readable", (await session.readOne({ kind: "llm_result", match: { callId: myCall } })) !== null);
check("its own tool_result is readable", (await session.readOne({ kind: "tool_result", match: { callId: myCall } })) !== null);
check("its own chunks are readable", (await session.query({ kind: "llm_chunk", match: { callId: myCall } }, 10)).length === 1);

// Artifacts. The last kind a session could not be scoped on: the body is computed from the bytes,
// so until `putArtifact` accepted application fields there was nothing for a template to bind and
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
// be absent, and one that was granted must be present — that is the whole point of asking the
// enforcement instead of inferring from another call's scope line.
check("a kind that was never granted is absent", !(perms.kinds ?? []).some((k) => k.kind === "kind_def"));
await admin.put({ kind: "grant", body: { principal: "agent:chat-user", kind: "kind_def", operations: ["query", "read_one"], scope: { createdBy: "self" } } });
const after = await tools.space_permissions({}) as { kinds?: { kind: string; readsScopedToSelf?: boolean }[] };
const kindDef = (after.kinds ?? []).find((k) => k.kind === "kind_def");
check("a newly granted kind shows up immediately", Boolean(kindDef));
check("…and says the read is narrowed to its own records", kindDef?.readsScopedToSelf === true);

// ---- the phantom kind from the transcript ----
// The assistant asked for `space_event` — the name of a TOOL, not a record kind — and had it
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
// `kind_def` records are written by whoever declares kinds — never by the chat session. So a
// SELF-SCOPED read grant on it authorizes a view of nothing, and `space_kinds` answers `[]` while
// the space has plenty. The tool is behaving correctly; the GRANT is the wrong shape, which is why
// the approval prompt now measures this and recommends against self-scope for such a kind.
const kinds = await tools.space_kinds({}) as { kinds: unknown[] };
check(
  "a self-scoped grant on a registry kind exposes nothing (the approval prompt warns about this)",
  kinds.kinds.length === 0,
  `${kinds.kinds.length} kinds`,
);
const asOperator = await admin.listKinds();
check("…while the space really does have kinds", asOperator.length > 0, `${asOperator.length} declared`);


// ---------------------------------------------------------------------------
// The approval loop, from the asking side to the answer — the case a live session walked into
// three times in a row: a grant is requested, a human approves it, the assistant reports "the grant
// landed", and every read still returns nothing. Nothing errors. The grant is real. It authorizes
// reads of records this session never wrote.
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

// A kind only somebody else has written to — the shape that makes a self-scoped read empty.
for (let i = 0; i < 3; i++) {
  await admin.put({ kind: "procedure", body: { name: `theirs_${i}`, artifactId: "x", description: "not mine" } });
}

// --- the dead end: asking for "own" on a kind you do not write ---
await tools.request_grant(
  { kind: "procedure", operations: ["query", "read_one"], why: "to read the saved procedures", scope: "own" },
  { callId: "smoke", conversationId: mine },
);
let stop = capture();
await reviewGrantRequests(session, admin, "agent:chat-user", mine, () => Promise.resolve("y"));
const narrowPrompt = stop();

check(
  "the prompt warns that 'own records only' would expose nothing",
  narrowPrompt.includes("written by others") && narrowPrompt.includes("NOTHING"),
);
check("…and stops recommending the narrow option", !narrowPrompt.includes("OWN records of that kind — reads only (recommended)"));
check("…and recommends the wider one instead", narrowPrompt.includes("ALL records of that kind in this space (recommended here)"));
check(
  "…and if the human narrows anyway, says plainly that the grant authorizes nothing",
  narrowPrompt.includes("and there are none"),
  narrowPrompt.split("\n").find((l) => l.includes("and there are none"))?.trim() ?? "(absent)",
);

const afterNarrow = await tools.space_query({ kind: "procedure", limit: 25 }) as { count: number };
check("the approved grant really does return nothing", afterNarrow.count === 0, `${afterNarrow.count} records`);
check("…while the records are plainly there", (await admin.query({ kind: "procedure" }, 25)).length === 3);

// --- the fix: the asker can say which it needs, and the prompt shows it ---
await tools.request_grant(
  { kind: "kind_def", operations: ["query", "read_one"], why: "to list the kinds before surveying them", scope: "all" },
  { callId: "smoke", conversationId: mine },
);
stop = capture();
await reviewGrantRequests(session, admin, "agent:chat-user", mine, () => Promise.resolve("a"));
const widePrompt = stop();

check("the prompt relays that the assistant asked for ALL records", widePrompt.includes("asked for ALL records of this kind"));
const listed = await tools.space_kinds({}) as { kinds: unknown[] };
check("and approving that way actually answers the question", listed.kinds.length > 0, `${listed.kinds.length} kinds`);

// The same ask at the narrower scope is a DIFFERENT request, not a duplicate of the one already
// handled — otherwise re-asking un-scoped after a scoped grant disappointed would be silently
// dropped as "already reviewed".
const requests = await session.query({ kind: "grant_request", match: { conversationId: mine } }, 50);
const scopes = new Set(requests.map((r) => (r.body as { kind: string; scope?: string }).kind + ":" + ((r.body as { scope?: string }).scope ?? "own")));
check("a re-ask at a different scope is its own request", scopes.has("kind_def:all") && scopes.has("procedure:own"), [...scopes].join(" "));

space.kill();
await space.status;
console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
