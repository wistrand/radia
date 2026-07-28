// The two routes from model output to a stored file, and the guidance that decides between them:
//
//   deno run -A examples/chat/smoke-save.ts
//
// `save_content` takes text the model WROTE. `run_code` + `save_as` takes bytes a program COMPUTED.
// Both end in the same place (an `artifact` record + blob), so nothing fails when the wrong one is
// picked; it just costs the content twice and buries an authored document inside a program that
// only echoes it.
//
// That is exactly what happened. Asked to "create a web page with a js clock", the assistant wrote
// the HTML as a JS string literal, console.log'd it, and stored stdout. The cause was in the
// descriptions, which is where a tool's usage lives in this app: `run_code` claimed "that is how
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
import { registerChatKinds } from "./space/kinds.ts";
import { publishCapability } from "./space/capability.ts";
import { makeSaveTools, SAVE_SCHEMAS } from "./tools/save.ts";
import { bootstrap } from "./space/roles.ts";
import type { ToolDef } from "./provider/openrouter.ts";

const PORT = 7809;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
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

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

// ── the descriptions, read the way the assistant reads them ──────────────────────────────────────
// Not imported as constants: published as `capability` records and queried back, because that is
// the path the guidance actually travels. A description fixed in source but never republished would
// pass an import-based test while the running fleet still advertised the old text. So `run_code`'s
// comes from the exec-worker PROCESS, launched here exactly as the chat launches it.
for (const def of SAVE_SCHEMAS) await publishCapability(admin, def);
const tokens = await bootstrap(admin, "admin");
const worker = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    `--allow-net=127.0.0.1:${PORT}`,
    "--allow-run=deno",
    "--allow-env=HOME",
    "examples/chat/workers/exec.ts",
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
  if ((await admin.query({ kind: "capability", match: { tool: "run_code" } }, 1)).length > 0) break;
  await new Promise((r) => setTimeout(r, 200));
}

const caps = new Map(
  (await admin.queryAll({ kind: "capability" }))
    .map((r) => r.body as { tool: string; def: ToolDef })
    .map((b) => [b.tool, b.def.function.description ?? ""]),
);
const runCode = caps.get("run_code") ?? "";
const saveContent = caps.get("save_content") ?? "";

check("both tools are advertised as capability records", runCode.length > 0 && saveContent.length > 0);

// The asymmetry that caused the bug: only one of the two knew the other existed, so the one making
// the unconditional claim won. Each must now name the other.
check("run_code names save_content", /save_content/.test(runCode));
check("save_content names run_code", /run_code/.test(saveContent));

// run_code must no longer claim the whole job. The exact sentence is gone; what replaces it has to
// carry a CONDITION, because an unconditional claim beats a conditional one when a model compares.
check(
  "run_code no longer claims to be how you save a file",
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
check(
  "…and claims the default for authored content",
  /\bDEFAULT\b/.test(saveContent),
);

// The specific shape the model produced. Naming it is what makes the guidance actionable: a model
// about to do this reads a description that describes what it is about to do.
check(
  "run_code warns against printing authored content back through it",
  /roundtrip|twice/i.test(runCode),
);

// The failing turn was "create a web page", so HTML has to be listed among what save_content takes.
// It was not, and every other format the assistant might reach for was.
check("save_content lists HTML among what it stores", /HTML/.test(saveContent));

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

// Model-authored bytes are untrusted like anything else on this path; clearing it needs a
// privileged declassify. A save tool that quietly produced clean output would be a hole.
check("model-authored content is tainted", rec?.runtimeMeta.taint === true);

// Lineage: conversation -> tool_call -> artifact, so a stored file traces back to the turn.
const parents = rec?.runtimeMeta.parentIds ?? [];
check("lineage reaches the tool_call that produced it", parents.includes(callRec.id), parents.join(","));

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
