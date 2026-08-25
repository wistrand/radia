// The two routes from model output to a stored file, and the guidance that decides between them:
//
//   deno run -A examples/chat/smoke-save.ts
//
// `save_content` takes text the model WROTE. `run_javascript` + `save_as` takes bytes a program COMPUTED.
// Both end in the same place (an `artifact` record + blob), so nothing fails when the wrong one is
// picked; it just costs the content twice and buries an authored document inside a program that
// only echoes it.
//
// That is exactly what happened. Asked to "create a web page with a js clock", the assistant wrote
// the HTML as a JS string literal, console.log'd it, and stored stdout. The cause was in the
// descriptions, which is where a tool's usage lives in this app: `run_javascript` claimed "that is how
// you save a file (SVG, JSON, CSV, Markdown, code) for the user" with no condition and no mention
// of `save_content`, while `save_content` deferred politely in the other direction and gated its
// own trigger on the user saying "save" (which "create a web page" does not).
//
// WHAT THIS SUITE CAN AND CANNOT PROVE. It cannot prove which tool a model picks; that needs a
// model. It pins the two things that are checkable without one: the descriptions the assistant
// actually reads (from `capability` records, the same source `ToolSet` builds its list from) still
// state the boundary, and the direct route works end to end so preferring it is not advice toward
// something broken.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { publishCapability } from "../../extensions/ts/capability.ts";
import { makeSaveTools, makeShareTools, makeWorkspaceTools, SAVE_SCHEMAS, SHARE_SCHEMAS, WORKSPACE_SCHEMAS } from "./tools/save.ts";
import { bootstrap, mintSession } from "./space/roles.ts";
import { summarizeWorkspaces } from "../../extensions/ts/workspace.ts";
import type { ToolDef } from "./provider/openrouter.ts";

const PORT = 7809;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  // With the isolated artifact origin ON, as a real chat run has it: a capability URL points there
  // so an HTML artifact RENDERS somewhere that shares nothing with the console.
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", String(PORT + 1)],
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

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

// ── the descriptions, read the way the assistant reads them ──────────────────────────────────────
// Not imported as constants: published as `capability` records and queried back, because that is
// the path the guidance actually travels. A description fixed in source but never republished would
// pass an import-based test while the running fleet still advertised the old text. So `run_javascript`'s
// comes from the exec-worker PROCESS, launched here exactly as the chat launches it.
for (const def of SAVE_SCHEMAS) await publishCapability(admin, def);
const tokens = await bootstrap(admin);
const wsRoot = Deno.makeTempDirSync({ prefix: "radia-ws-" });
const worker = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    `--allow-net=127.0.0.1:${PORT}`,
    "--allow-run=deno",
    "--allow-env=HOME",
    // A procedure is a WORKSPACE now, so every call materialises a tree and the worker needs
    // somewhere to put it. fleet.ts has always done this; these launchers predate the change.
    `--allow-write=${wsRoot}`,
    `--allow-read=${wsRoot}`,
    "examples/chat/workers/exec.ts",
    "--workspace-root",
    wsRoot,
    "--url",
    url,
    "--token",
    tokens.execToken,
  ],
  stdout: "null",
  stderr: "inherit",
  stdin: "null",
}).spawn();
// It advertises on startup; wait for the record rather than guessing at a sleep.
for (let i = 0; i < 100; i++) {
  if ((await admin.queryOldest({ kind: "capability", match: { tool: "run_javascript" } }, 1)).length > 0) break;
  await new Promise((r) => setTimeout(r, 200));
}

const caps = new Map(
  (await admin.queryAll({ kind: "capability" }))
    .map((r) => r.body as { tool: string; def: ToolDef })
    .map((b) => [b.tool, b.def.function.description ?? ""]),
);
const runCode = caps.get("run_javascript") ?? "";
const saveContent = caps.get("save_content") ?? "";

check("both tools are advertised as capability records", runCode.length > 0 && saveContent.length > 0);

// The asymmetry that caused the bug: only one of the two knew the other existed, so the one making
// the unconditional claim won. Each must now name the other.
check("run_javascript names save_content", /save_content/.test(runCode));
// The counterpart reference stays GENERIC ("a code runner"), because there are two of them now and
// only one is advertised on a host without bubblewrap. A description naming a tool that this space
// does not serve is the same defect as one naming no tool at all.
check("save_content names the code runner", /code runner/.test(saveContent));

// run_code must no longer claim the whole job. The exact sentence is gone; what replaces it has to
// carry a CONDITION, because an unconditional claim beats a conditional one when a model compares.
check(
  "run_javascript no longer claims to be how you save a file",
  !/that is how you\s+save a file/i.test(runCode),
);
check(
  "…and conditions save_as on the bytes being computed",
  /\bCOMPUTED\b/.test(runCode) && /\bONLY\b/.test(runCode),
);

// The trigger that never fired. "create a web page" contains no form of "save", so a description
// that waits to be asked to save is unreachable for the request that most needs it.
check(
  "save_content does not wait for the user to say 'save'",
  /whether or not|none of them contain the word|not only when/i.test(saveContent),
);
// It must still claim the DEFAULT, or the original bug returns: the model reached for run_code to
// store an authored document because save_content sounded optional. Scoped to documents now, so it
// claims the default without competing for code.
check(
  "…and claims the default for authored DOCUMENTS",
  /\bDEFAULT\b/.test(saveContent) && /document/i.test(saveContent),
);

// The specific shape the model produced. Naming it is what makes the guidance actionable: a model
// about to do this reads a description that describes what it is about to do.
check(
  "run_javascript warns against printing authored content back through it",
  /roundtrip|twice/i.test(runCode),
);

// The failing turn was "create a web page", so HTML has to be listed among what save_content takes.
// It was not, and every other format the assistant might reach for was.
check("save_content lists HTML among what it stores", /HTML/.test(saveContent));

// ── three tools, one boundary each ───────────────────────────────────────────────────────────────
// Adding save_workspace reintroduced the exact overlap this suite was written for: `save_content`
// still listed "code" among what it stores and still claimed to be "the DEFAULT way to give the
// user a file", so for a program it competed with a tool that is strictly better at it. A workspace
// can be RUN, keeps every version, and is what a verdict attaches to; an artifact is bytes.
//
// The rule the three now state consistently:
//   document for the user      -> save_content
//   code, one file or twenty   -> save_workspace, then run_javascript {workspace}
//   throwaway calculation      -> run_javascript {code}, keep nothing
for (const def of WORKSPACE_SCHEMAS) await publishCapability(admin, def);
// Published here as well as further down, because the boundary between share_artifact and
// share_workspace is asserted against THIS map. Publishing is content-keyed, so the second call
// writes nothing.
for (const def of SHARE_SCHEMAS) await publishCapability(admin, def);
const desc = new Map(
  (await admin.queryAll({ kind: "capability" }))
    .map((r) => r.body as { tool: string; def: ToolDef })
    .map((b) => [b.tool, b.def.function.description ?? ""]),
);
const saveWs = desc.get("save_workspace") ?? "";
const runCodeNow = desc.get("run_javascript") ?? "";
const saveNow = desc.get("save_content") ?? "";

check("save_workspace is advertised", saveWs.length > 0);
check("save_content no longer offers to store CODE", !/\bcode\b/.test(saveNow.split("NOT for code")[0]));
check("…and sends a program to save_workspace instead", /save_workspace/.test(saveNow));
check("…saying WHY, since a model needs a reason and not an instruction", /can be RUN|only bytes/.test(saveNow));
check("save_workspace claims code whatever its size", /one file or twenty|single file/.test(saveWs));
check("…and names the one thing that is NOT a workspace", /throwaway/.test(saveWs));
check("run_javascript distinguishes its two shapes", /THROWAWAY/.test(runCodeNow) && /workspace/.test(runCodeNow));

// A retired tool name in a live description is unreachable advice: the model calls it and gets
// "unknown tool". `run_code` became `run_javascript` when a second language arrived, and the names
// survived in six descriptions the rename did not touch, because nothing compiled against them.
const stale = [...desc.entries()].filter(([, d]) => /\brun_code\b/.test(d)).map(([t]) => t);
check(`no description names the retired run_code${stale.length ? ": " + stale.join(", ") : ""}`, stale.length === 0);
check(
  "…and does not still claim bare code is for generating files",
  !/generating file content/i.test(runCodeNow),
);

// ── the assistant can see what it already built ──────────────────────────────────────────────────
// `save_workspace` shipped without a counterpart, and the gap had a cost: an assistant that can only
// WRITE a tree cannot resume one. Told to "fix the bug", it re-created the project from memory,
// losing every file it was not currently thinking about, because "what did I already build" had no
// answer. That is the discovery-not-hardcode rule failing in the direction that spends tokens.
const wsConv = (await admin.put({ kind: "conversation", body: { title: "trees" } })).id;
// In process, like the rest of this suite: only the exec worker runs here, and what is under test
// is the TOOL plus the description the fleet publishes, not the claim path (smoke.ts covers that).
const wsTools = makeWorkspaceTools(admin);
const toolCall = (tool: string, args: Record<string, unknown>, conversationId = wsConv) =>
  wsTools[tool](args, { owner: "human:alice", conversationId, callId: "smoke" }) as Promise<Record<string, unknown>>;
type Listing = {
  workspaces: { name: string; files: number; versions: number; paths?: string[]; forked?: boolean; thisConversation?: boolean }[];
  incomplete?: boolean;
};

check("list_workspaces is advertised", desc.has("list_workspaces"));
// An empty answer must be EMPTY, not an error and not a missing field: "nothing yet" is the state
// every conversation starts in, and a model that cannot read it will not ask again.
const empty = await toolCall("list_workspaces", {}) as Listing;
check("a conversation with no trees lists none", Array.isArray(empty.workspaces) && empty.workspaces.length === 0);

await toolCall("save_workspace", { name: "solver", files: { "main.py": "print(1)\n", "lib.py": "X=1\n" } });
await toolCall("save_workspace", { name: "solver", files: { "main.py": "print(2)\n", "lib.py": "X=1\n" } });
await toolCall("save_workspace", { name: "notes", files: { "a.md": "hi\n" } });
const listed = await toolCall("list_workspaces", {}) as Listing;
check("…and both trees after saving", listed.workspaces.map((w) => w.name).sort().join(",") === "notes,solver", JSON.stringify(listed.workspaces.map((w) => w.name)));

// The iteration count is the point of the field: three saves of one tree are ONE workspace with a
// history, not three workspaces. A raw `query workspace` cannot say that, which is why the tool
// exists rather than the model being told to query.
const solver = listed.workspaces.find((w) => w.name === "solver")!;
check("a tree saved twice is one workspace with two versions", solver.versions === 2 && solver.files === 2, JSON.stringify(solver));

// NOT scoped to the conversation, and the reason is a live failure. Hiding the rest made this tool
// contradict `space_count`, which is owner-scoped by the grant: one said 8 workspaces, the other said
// none, both correctly, and the model burned eight tool rounds trying to reconcile them.
const otherConv = (await admin.put({ kind: "conversation", body: { title: "elsewhere" } })).id;
await toolCall("save_workspace", { name: "unrelated", files: { "z.txt": "z\n" } }, otherConv);
const across = await toolCall("list_workspaces", {}) as Listing;
check("a tree from another conversation IS listed", across.workspaces.some((w) => w.name === "unrelated"));
// …but marked, because a code runner only materialises a tree from its own conversation. A name the
// model cannot use, with no way to know why, is what sent it in circles in the first place.
check(
  "…and marked so the runnable ones are distinguishable",
  across.workspaces.find((w) => w.name === "solver")?.thisConversation === true &&
    across.workspaces.find((w) => w.name === "unrelated")?.thisConversation === undefined,
  JSON.stringify(across.workspaces.map((w) => [w.name, w.thisConversation ?? false])),
);
const narrowed = await toolCall("list_workspaces", { conversation_only: true }) as Listing;
check("…and conversation_only narrows on request", !narrowed.workspaces.some((w) => w.name === "unrelated"));
check("the count agrees with what the space itself reports", across.workspaces.length === (await summarizeWorkspaces(admin)).workspaces.length);

// The description has to steer the model to look BEFORE writing, which is the only behaviour that
// closes the gap; a tool nobody reaches for is the same as no tool.
const listDesc = desc.get("list_workspaces") ?? "";
check("…and its description says to check before saving", /BEFORE save_workspace/i.test(listDesc));
// ── reading a tree, which is what fabrication filled in for ──────────────────────────────────────
// The live failure: asked to show a workspace file, the model tried read_file (sandbox only,
// denied), then RECONSTRUCTED the contents from earlier in the conversation, stored the
// reconstruction with save_content, and presented it as the file. It even said so. Save, list and
// run existed for trees; read did not, and fabrication was the only route left to an answer.
check("read_workspace is advertised", desc.has("read_workspace"));
const unnumber = (t: string) => t.split("\n").map((l) => l.replace(/^\s*\d+\t/, "")).join("\n");
const read = await toolCall("read_workspace", { workspace: "solver", path: "main.py" }) as Record<string, unknown>;
// Numbered for the line-range edit form, so "byte for byte" is asserted through the numbering rather
// than against it. The numbers are presentation; the bytes underneath must still be the stored ones.
check("a workspace file reads back byte for byte", unnumber(read.content as string) === "print(2)\n", JSON.stringify(read.content));
check("…numbered, with the numbers not part of the file", /^\s+1\t/.test(read.content as string));
check("…and carries the digest a line-range edit needs", typeof read.digest === "string");
check("…and says which tree it came from", typeof read.treeDigest === "string" && (read.treeDigest as string).startsWith("t1:"));

const missing = await toolCall("read_workspace", { workspace: "solver", path: "nope.py" }) as Record<string, unknown>;
check("a missing path is an error that LISTS what is there", Array.isArray(missing.paths) && (missing.paths as string[]).includes("main.py"));

// An erased payload must produce an explanation, because reconstruction is what a model does when
// it gets nothing it can use.
const doomed = await toolCall("save_workspace", { name: "leaky", files: { "keep.py": "ok\n", "secret.txt": "OOPS\n" } }) as Record<string, unknown>;
void doomed;
const leaky = (await admin.queryNewest({ kind: "workspace", match: { name: "leaky" } }, 1))[0];
const secret = (leaky.body as { files: { path: string; artifactId: string }[] }).files.find((f) => f.path === "secret.txt")!;
await admin.shredArtifact(secret.artifactId, { acknowledgeShared: true, reason: "leaked" });
const erased = await toolCall("read_workspace", { workspace: "leaky", path: "secret.txt" }) as Record<string, unknown>;
check("an erased file reports the erasure", erased.erased === true, JSON.stringify(erased.error).slice(0, 80));
check("…and tells the model not to reconstruct it", /do not reconstruct/i.test(String(erased.error)));
check("…while the rest of the tree still reads", unnumber((await toolCall("read_workspace", { workspace: "leaky", path: "keep.py" }) as Record<string, unknown>).content as string) === "ok\n");

// The listing has to carry the paths, or "what files are in X" has no data source and gets answered
// from conversation memory — which is exactly how the fabrication started.
const withPaths = await toolCall("list_workspaces", {}) as Listing;
check(
  "the listing reports the PATHS, not just a count",
  (withPaths.workspaces.find((w) => w.name === "solver")?.paths ?? []).join(",") === "lib.py,main.py",
  JSON.stringify(withPaths.workspaces.find((w) => w.name === "solver")?.paths),
);

// ── editing in place, and the boundary it opens with save_workspace ──────────────────────────────
// The fourth tool in this space, and this example has reopened a settled boundary three times by
// adding one (save_content/run_javascript, then save_workspace, then run_python). The incumbent used
// to INSTRUCT the behaviour this replaces — "iterating means saving the whole tree again with your
// fix" — which was correct until edit_workspace existed and is the bug the moment it does.
check("edit_workspace is advertised", desc.has("edit_workspace"));
const editDesc = desc.get("edit_workspace") ?? "";
const saveWsDesc = desc.get("save_workspace") ?? "";
check("save_workspace no longer tells the model to retype the tree to iterate", !/saving the whole tree again with your fix/i.test(saveWsDesc));
check("…and sends a CHANGE to edit_workspace", /edit_workspace/.test(saveWsDesc));
check("…saying why, since a model needs a reason and not an instruction", /dropped|replaces the whole tree/i.test(saveWsDesc));
check("edit_workspace names save_workspace and what selects it", /save_workspace/.test(editDesc));
check("…and warns that a whole-tree save DROPS omitted files", /DROPPED|dropped/.test(editDesc));
check("list_workspaces points a change at edit_workspace too", /edit_workspace/.test(desc.get("list_workspaces") ?? ""));

// The git story lives here because nothing serves it as a tool (both are CLI verbs). Asked "how do
// I export to git over http", the assistant gave GitHub boilerplate and an invented ZIP flow: the
// old sentence never said the words "over HTTP" and gave no clone URL, so the cheap tier had
// nothing to match the question against.
const wsShareDesc = desc.get("share_workspace") ?? "";
check("share_workspace teaches the local git export", /workspace-git <name> --dir/.test(wsShareDesc));
check("…and git OVER HTTP, in those words", /OVER HTTP/.test(wsShareDesc) && /git-serve/.test(wsShareDesc));
check("…with the clone URL shape and its default port", /git clone http:\/\/127\.0\.0\.1:7790\/<name>\.git/.test(wsShareDesc));
check("…and says the export is already a repo, not a tree to git-init", /already committed|no git init/.test(wsShareDesc));
check("…and forbids the failure mode by name", /never with generic git hosting advice/.test(wsShareDesc));

// Both addressing forms have to be discoverable, and the line-range one is useless without its
// precondition being stated as required.
check("edit_workspace documents the line-range form", /start_line/.test(editDesc) && /end_line/.test(editDesc));
check("…and that a range REQUIRES the digest", /needs `expect_digest`|Required with start_line/.test(editDesc));
check("…and the boundary quotes, with WHY the last one matters", /expect_last_line/.test(editDesc) && /reaching further than you meant/.test(editDesc));
check("…and says to read the preview rather than report intent", /rather than reporting what you intended/.test(editDesc));
check("…and tells the model not to paste the line-number prefix", /line-number prefix/i.test(editDesc));
check("…and says to READ before editing, which is what a guessed old_string costs", /READ THE FILE FIRST/.test(editDesc));

const edited = await toolCall("save_workspace", { name: "iter", files: { "main.py": "print(1)\n", "lib.py": "X = 1\n" } }) as Record<string, unknown>;
void edited;
const e1 = await toolCall("edit_workspace", {
  workspace: "iter",
  edits: [{ path: "main.py", old_string: "print(1)", new_string: "print(2)" }],
}) as { changed: string[]; digests: Record<string, string>; error?: string };
check("an edit changes one file", e1.changed?.join(",") === "main.py", JSON.stringify(e1.error ?? e1.changed));
check("…and returns the new digest, so a range edit needs no second read", typeof e1.digests?.["main.py"] === "string");

// The snake_case wire names are the trained ones; a model filling old_string/new_string is doing
// what it already does. Verify the mapping to the extension's camelCase actually landed.
const readBack = await toolCall("read_workspace", { workspace: "iter", path: "main.py" }) as { content: string; digest: string };
check("the read is NUMBERED, which is what makes a line range usable", /^\s+1\tprint\(2\)/.test(readBack.content), JSON.stringify(readBack.content));
const e2 = await toolCall("edit_workspace", {
  workspace: "iter",
  edits: [{
    path: "main.py",
    start_line: 1,
    end_line: 1,
    new_string: "print(3)\n",
    expect_digest: readBack.digest,
    expect_first_line: "print(2)",
  }],
}) as { changed: string[]; preview?: { path: string; text: string }[]; error?: string };
check("a line-range edit applies with the digest from the read", e2.changed?.join(",") === "main.py", JSON.stringify(e2.error));
// The result SHOWS the change, so the model need not describe it from intent — which is how an edit
// that removed six structural tags got reported as "the style block is now ZZZZZ".
check("…and the result previews what actually changed", /print\(3\)/.test(e2.preview?.[0]?.text ?? ""), JSON.stringify(e2.preview));
// A range that reaches past what the caller quoted is refused, and the LAST line is what catches it.
const e4 = await toolCall("edit_workspace", {
  workspace: "iter",
  edits: [{ path: "main.py", start_line: 1, end_line: 1, new_string: "x\n", expect_digest: (await toolCall("read_workspace", { workspace: "iter", path: "main.py" }) as { digest: string }).digest, expect_first_line: "not this line" }],
}) as { error?: string };
check("…and a misquoted boundary is refused", /expectFirstLine does not match/.test(e4.error ?? ""), JSON.stringify(e4.error).slice(0, 90));
const e3 = await toolCall("edit_workspace", {
  workspace: "iter",
  edits: [{ path: "main.py", start_line: 1, end_line: 1, new_string: "nope\n" }],
}) as { error?: string };
check("…and without one it is refused", /expectDigest/.test(e3.error ?? ""), JSON.stringify(e3.error));

// A whole tree as a link. The boundary with share_artifact is the fourth in this space and the same
// rule applies: each names the other and states what selects it. One file goes to share_artifact; a
// site whose page needs a stylesheet cannot, because a capability over one artifact leaves the rest
// unreachable however many you mint.
check("share_workspace is advertised", desc.has("share_workspace"));
const shareWsDesc = desc.get("share_workspace") ?? "";
check("…and says share_artifact opens only ONE file", /share_artifact can only ever open ONE file/.test(shareWsDesc));
check("…and that the link is a SNAPSHOT, not a live view", /share again after changing/.test(shareWsDesc));
check("share_artifact points a multi-file site at share_workspace", /share_workspace/.test(desc.get("share_artifact") ?? ""));

const shared = await toolCall("share_workspace", { workspace: "solver" }) as {
  url?: string;
  files?: number;
  entry?: string | null;
  note?: string;
  error?: string;
};
// The affordance has to travel with the RESULT, not sit in a description. A model holding a freshly
// split multi-file page reasoned that opaque artifact URLs made relative links impossible and told
// the user no link was possible — with share_workspace in its tool list the whole time.
const sited = await toolCall("save_workspace", { name: "asite", files: { "index.html": "<h1>hi</h1>\n", "style.css": "h1{}\n" } }) as Record<string, unknown>;
check("saving a tree with an index.html says it is a browsable site", sited.site === true, JSON.stringify(sited.note ?? "").slice(0, 60));
check("…and names share_workspace at the moment it applies", /share_workspace/.test(String(sited.note)));
const plain = await toolCall("save_workspace", { name: "nosite", files: { "a.py": "x\n" } }) as Record<string, unknown>;
check("…and a tree that is not a site says nothing", plain.site === undefined);

check("a tree shares as a URL", typeof shared.url === "string" && shared.files === 2, JSON.stringify(shared.error ?? shared));
// solver has no index.html, so the base URL opens nothing — said rather than handed over silently.
check("…and a tree with no index.html says the base URL opens nothing", shared.entry === null && /no index.html/.test(shared.note ?? ""));

const readDesc = desc.get("read_workspace") ?? "";
check("read_workspace forbids reproducing a file from memory", /NEVER reproduce/i.test(readDesc));
check("…and says read_file does not reach workspaces", /read_file/.test(readDesc));
// Numbering is a presentation choice with a cost: a model relaying a file to a person will show the
// numbers unless told they are not the file. Cheaper to say it than to have it happen once.
check("…and says the line numbers are not part of the file", /NOT part of the file/.test(readDesc));

// The marker is useless unless the description says what to DO about it.
check("…and says how to use a tree from another conversation", /save_workspace them here first/i.test(listDesc));
check("…and warns that an incomplete list is not an absent workspace", /incomplete/i.test(listDesc));

// ── the same tools, through the REAL worker ──────────────────────────────────────────────────────
//
// Everything above drives `makeWorkspaceTools(admin)` in process, with an OPERATOR client. That is
// right for testing descriptions and edit semantics and CANNOT catch the defect that actually shipped:
// the tools worker held `artifact: put` and no `read_one`, so every read_workspace and every
// edit_workspace in a real chat answered `forbidden` while these assertions stayed green. The
// operator client had authority the worker does not.
//
// So one pass through a live worker over real `tool_call` records. It is slower and it tests a
// different thing: not what the tool does, but whether the identity that runs it may.
const toolsWorker = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    `--allow-net=127.0.0.1:${PORT}`,
    "--allow-read=.",
    "examples/chat/workers/tools.ts",
    "--url",
    url,
    "--token",
    tokens.toolsToken,
    "--dir",
    ".",
  ],
  stdout: "null",
  stderr: "inherit",
  stdin: "null",
}).spawn();
try {
  for (let i = 0; i < 100; i++) {
    if ((await admin.queryOldest({ kind: "capability", match: { tool: "edit_workspace" } }, 1)).length > 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const wConv = (await admin.put({ kind: "conversation", body: { title: "worker" } })).id;
  const viaWorker = async (tool: string, args: unknown) => {
    const { id } = await admin.put({ kind: "tool_call", body: { tool, args, conversationId: wConv, owner: "human:alice" } });
    for (let i = 0; i < 150; i++) {
      const r = await admin.readOne({ kind: "tool_result", match: { callId: id } });
      if (r) return (r.body as { output: Record<string, unknown> }).output;
      await new Promise((res) => setTimeout(res, 200));
    }
    throw new Error(`no tool_result for ${tool}`);
  };

  await viaWorker("save_workspace", { name: "wk", files: { "a.py": "print(1)\n" } });
  const wRead = await viaWorker("read_workspace", { workspace: "wk", path: "a.py" }) as Record<string, unknown>;
  check("the WORKER may read a workspace file", typeof wRead.content === "string", JSON.stringify(wRead.error ?? "").slice(0, 80));
  const wEdit = await viaWorker("edit_workspace", {
    workspace: "wk",
    edits: [{ path: "a.py", old_string: "print(1)", new_string: "print(2)" }],
  }) as Record<string, unknown>;
  check("…and may edit one", (wEdit.changed as string[] | undefined)?.join(",") === "a.py", JSON.stringify(wEdit.error ?? "").slice(0, 80));
} finally {
  try {
    toolsWorker.kill();
    await toolsWorker.status;
  } catch { /* already gone */ }
}

// ── the direct route works ───────────────────────────────────────────────────────────────────────
// Advice to prefer save_content is only sound if one call really does produce the artifact.
const conv = (await admin.put({ kind: "conversation", body: { title: "clock" } })).id;
const callRec = await admin.put({
  kind: "tool_call",
  body: { callId: "call-1", conversationId: conv, owner: "human:alice", tool: "save_content" },
});
const tools = makeSaveTools(admin);
const page = "<!DOCTYPE html>\n<html><body><div id=t></div><script>setInterval(()=>t.textContent=new Date().toLocaleTimeString(),1000)</script></body></html>";
const saved = await tools.save_content(
  { content: page, filename: "clock.html" },
  { callId: callRec.id, conversationId: conv, owner: "human:alice" },
) as { artifactId: string; mediaType: string; size: number };

check("one call stores the content", typeof saved.artifactId === "string" && saved.artifactId.length > 0);
check("…with the media type taken from the extension", saved.mediaType === "text/html", saved.mediaType);
check("…and the byte count of what was passed", saved.size === new TextEncoder().encode(page).length, String(saved.size));

const bytes = new TextDecoder().decode(await admin.getArtifact(saved.artifactId));
check("…and the bytes come back unchanged", bytes === page);

const rec = await admin.getRecord(saved.artifactId);
const body = rec?.body as { conversationId?: string; owner?: string; mediaType?: string; filename?: string };
check("the artifact record is pinned to the conversation", body.conversationId === conv, String(body.conversationId));
check("…and stamped with the session owner, so a grant pattern can bind it", body.owner === "human:alice", String(body.owner));
check("…and carries the filename for the download", body.filename === "clock.html", String(body.filename));

// NO label, and that is the point of the vocabulary. "The model wrote this" is a graph fact the log
// already answers; a label exists only for what a BARRIER tests, and nothing bars content for
// having been authored. What the model READ to write it is labelled on the parents this inherits.
check("authored content carries no barrier label", (rec?.runtimeMeta.taint ?? []).length === 0, JSON.stringify(rec?.runtimeMeta.taint));

// Lineage: conversation -> tool_call -> artifact, so a stored file traces back to the turn.
const parents = rec?.runtimeMeta.parentIds ?? [];
check("lineage reaches the tool_call that produced it", parents.includes(callRec.id), parents.join(","));

// ── sharing: an id refers, a capability opens ────────────────────────────────────────────────────
// The assistant could produce a file and then had no honest way to hand it over: the id-based URL
// needs an Authorization header, which a browser cannot attach to a typed address or an <img src>,
// and nothing let it mint the alternative. So it quoted a URL that 401s, or invented one.
const shareCaps = new Map(
  (await admin.queryAll({ kind: "capability" }))
    .map((r) => r.body as { tool: string; def: ToolDef })
    .map((b) => [b.tool, b.def.function.description ?? ""]),
);
for (const def of SHARE_SCHEMAS) await publishCapability(admin, def);
const shareDesc = (await admin.queryAll({ kind: "capability", match: { tool: "share_artifact" } }))
  .map((r) => (r.body as { def: ToolDef }).def.function.description ?? "")[0] ?? "";
check("share_artifact is advertised", shareDesc.length > 0);
check("…and says the id URL is a reference, not a link", /401|Authorization header/i.test(shareDesc));
check("…and forbids constructing such a URL by hand", /never construct/i.test(shareDesc));
check("save_content points at it", /share_artifact/.test(saveContent) || /share_artifact/.test(shareCaps.get("save_content") ?? ""));

// It must run as the SESSION, not the worker. Authorization happens at MINT time, so a link can
// only exist for an artifact the caller may already read.
const aliceTok = await mintSession(admin, "agent:sharer", { owner: "human:alice" });
const alice = new RadiaClient(url, { token: aliceTok });
const mine = await admin.putArtifact(new TextEncoder().encode(page), {
  mediaType: "text/html",
  filename: "mine.html",
  meta: { conversationId: conv, owner: "human:alice" },
});
const theirs = await admin.putArtifact(new TextEncoder().encode("not yours"), {
  mediaType: "text/html",
  filename: "theirs.html",
  meta: { conversationId: conv, owner: "human:bob" },
});
const share = makeShareTools(alice);
const link = await share.share_artifact({ artifact_id: mine.id }) as { url: string; expiresAt: string };
check("a session can share its own artifact", typeof link.url === "string" && link.url.includes("/v0/a/"), link.url);
// SHORT: the capability names one record, so the id and a `?capability=` spelling were ~70
// characters of nothing in a link a person is shown, pastes and sometimes reads aloud.
check("…as a short URL, with no redundant record id", !link.url.includes(mine.id) && link.url.length < 60, `${link.url.length} chars`);
check("…as an ABSOLUTE url an agent can hand over", /^https?:\/\//.test(link.url), link.url);
check("…on the isolated artifact origin, not the console's", link.url.includes(String(PORT + 1)) && !link.url.includes(`:${PORT}/`), link.url);
check("…and the link carries its own authorization", /\/v0\/a\/[A-Za-z0-9_-]{22}$/.test(link.url), link.url);
check("…and expires", !!Date.parse(link.expiresAt));

// The link really works with no header, which is the whole point of minting one.
const opened = await fetch(link.url);
check("the capability URL opens with no Authorization header", opened.ok, `HTTP ${opened.status}`);
check("…and returns the bytes", (await opened.text()) === page);

// The capability IS the authorization, so altering it opens nothing. There is no id left in the
// URL to substitute, which is the other half of why the short form is not a weaker one.
const truncated = await fetch(link.url.slice(0, -4));
check("a truncated capability is refused", !truncated.ok, `HTTP ${truncated.status}`);
const idUrl = `${new URL(link.url).origin}/v0/artifacts/${mine.id}`;
const bare = await fetch(idUrl);
check("and the id URL with no capability is refused", !bare.ok, `HTTP ${bare.status}`);

let stolen = "minted";
try {
  await share.share_artifact({ artifact_id: theirs.id });
} catch (e) {
  stolen = (e as Error).message;
}
check("a session cannot mint a link for an artifact it may not read", stolen !== "minted", stolen);

// ── the roundtrip is not forbidden, only unnecessary ─────────────────────────────────────────────
// Nothing here blocks run_code + save_as, and it must not: computed bytes are its job. The point is
// that the two routes land in the same place, which is exactly why only the description can choose.
const viaProgram = await admin.putArtifact(new TextEncoder().encode(page), {
  mediaType: "text/html",
  filename: "clock.html",
  meta: { conversationId: conv, owner: "human:alice" },
});
check("both routes produce the same bytes", viaProgram.size === saved.size);
check("…so nothing FAILS when the wrong one is picked, which is why the wording is the fix", viaProgram.id !== saved.artifactId);

try {
  worker.kill();
  await worker.status;
} catch { /* already gone */ }
space.kill();
await space.status;
console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
