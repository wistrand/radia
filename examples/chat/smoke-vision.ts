// Reading an image: the `analyze_image` tool, end to end, with no API key and no model.
//
//   deno run -A examples/chat/smoke-vision.ts
//
// A stub provider stands in for the vision model, which is what makes the interesting half testable:
// the question is not whether a model can describe a cat, it is whether the WORKER hands it the
// right bytes under the right permissions and refuses the rest before spending a request.
//
// Three properties with a history behind them:
//
//   THE ANNOUNCEMENT AND THE ENFORCEMENT ARE ONE VALUE. A tool description that lists formats the
//   worker then rejects teaches the model something false, and it only finds out by being refused.
//   The accepted set is checked here in both places at once.
//
//   THE GRANT SHIPS WITH THE CAPABILITY. `analyze_image` needs `artifact: read_one`, which this
//   worker did not have. Twice before, a chat worker gained a capability and its grant list did not
//   follow, and both times the contract suites stayed green while every real call answered
//   `forbidden`. Driving the real worker under its real run token is the only thing that catches it.
//
//   REFUSING COSTS NOTHING. An unreadable type, an oversized blob and an id that does not resolve
//   are all answered without a provider request, and answered as a `tool_result` rather than a nack:
//   a failed call is something the model should see and act on.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { bootstrap } from "./space/roles.ts";
import { liveModels } from "./space/model.ts";
import type { ToolDef } from "./provider/openrouter.ts";

const PORT = 7819;
const STUB_PORT = 7820;
const url = `http://127.0.0.1:${PORT}`;
const VISION_MODEL = "vendor/eyes";
const TYPES = ["image/png", "image/jpeg", "application/pdf"];
const MAX_BYTES = 512;
const ANSWER_TOKENS = 777;

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

// ---- the stub provider ----
// It records every request, which is how "the worker sent THESE bytes to THAT model" becomes an
// assertion rather than an inference from the answer coming back at all.
interface Seen {
  model: string;
  text: string;
  /** The kind of media part that carried the bytes: `image_url` for pictures, `file` for a PDF. */
  partType: string;
  dataUrl: string;
  filename: string;
  maxTokens?: number;
}
const seen: Seen[] = [];
/** Set to make the stub answer as a model that ran out of budget: well-formed text that stops. */
let truncateNext = false;
const stub = Deno.serve({ port: STUB_PORT, onListen: () => {} }, async (req) => {
  const body = await req.json() as {
    model: string;
    max_tokens?: number;
    messages: {
      content: {
        type: string;
        text?: string;
        image_url?: { url: string };
        file?: { filename: string; file_data: string };
      }[];
    }[];
  };
  const parts = body.messages[0].content;
  const media = parts.find((p) => p.type !== "text");
  seen.push({
    model: body.model,
    text: parts.find((p) => p.type === "text")?.text ?? "",
    partType: media?.type ?? "",
    dataUrl: media?.image_url?.url ?? media?.file?.file_data ?? "",
    filename: media?.file?.filename ?? "",
    maxTokens: body.max_tokens,
  });
  return Response.json(
    truncateNext
      ? {
        choices: [{ message: { role: "assistant", content: "a tabby cat on a windowsill, its fur" }, finish_reason: "length" }],
        usage: { total_tokens: 64 },
      }
      : {
        choices: [{ message: { role: "assistant", content: "a tabby cat on a windowsill" }, finish_reason: "stop" }],
        usage: { total_tokens: 12 },
      },
  );
});

const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
  stdout: "null",
  stderr: "inherit",
}).spawn();

const probe = new RadiaClient(url); // liveness only: /v0/health is public
for (let i = 0; i < 100; i++) {
  try {
    await probe.health();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
const admin = new RadiaClient(url, { token: operatorToken(url) });
await registerChatKinds(admin);

const conv = (await admin.put({ kind: "conversation", body: { title: "vision" } })).id;
const tokens = await bootstrap(admin, { conversationId: conv });
const worker = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "--allow-net",
    "--allow-env",
    "examples/chat/workers/images.ts",
    "--url",
    url,
    "--token",
    tokens.imagesToken,
    "--vision-model",
    VISION_MODEL,
    "--vision-types",
    TYPES.join(","),
    "--max-image-bytes",
    String(MAX_BYTES),
    "--answer-tokens",
    String(ANSWER_TOKENS),
  ],
  env: { ...Deno.env.toObject(), RADIA_CHAT_API_BASE: `http://127.0.0.1:${STUB_PORT}`, OPENROUTER_API_KEY: "stub" },
  stdout: "null",
  stderr: "inherit",
  stdin: "null",
}).spawn();

async function analyzeCapability(): Promise<ToolDef | undefined> {
  const rows = await admin.query({ kind: "capability", match: { tool: "analyze_image" } }, 1, { dir: "desc" });
  return (rows[0]?.body as { def?: ToolDef } | undefined)?.def;
}
let def: ToolDef | undefined;
for (let i = 0; i < 150; i++) {
  def = await analyzeCapability();
  if (def) break;
  await new Promise((r) => setTimeout(r, 200));
}

/** Drive a tool the way the chat does: put a `tool_call`, wait for its `tool_result`. */
async function call(tool: string, args: Record<string, unknown>) {
  const { id } = await admin.put({
    kind: "tool_call",
    body: { tool, args, conversationId: conv, owner: "agent:chat-user" },
    parentIds: [conv],
  });
  for (let i = 0; i < 200; i++) {
    const r = await admin.readOne({ kind: "tool_result", match: { callId: id } });
    if (r) return { record: r, body: r.body as { ok: boolean; output: unknown } };
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`no tool_result for ${tool}`);
}

// A one-pixel PNG. Small enough that the whole payload is checkable, real enough to have a media type.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (ch) => ch.charCodeAt(0),
);

// ---- the announcement ----
check("the tool is advertised at all", def !== undefined);
const description = def?.function.description ?? "";
check(
  "…and its description names every accepted media type",
  TYPES.every((t) => description.includes(t)),
  description.slice(0, 90),
);
check("…and the size limit it will actually enforce", description.includes("512 bytes"), description.slice(0, 90));

const ads = await admin.query({ kind: "model", match: { tier: "vision" } }, 1, { dir: "desc" });
const ad = ads[0]?.body as { model?: string; inputMediaTypes?: string[] } | undefined;
check("the vision model is on a record, not only in prose", ad?.model === VISION_MODEL, String(ad?.model));
check(
  "…carrying the same accepted set the description announced",
  JSON.stringify(ad?.inputMediaTypes) === JSON.stringify(TYPES),
  JSON.stringify(ad?.inputMediaTypes),
);
check(
  "…and it is not offered as a text tier",
  !(await liveModels(admin)).some((m) => m.tier === "vision"),
);

// ---- reading an image ----
const image = await admin.putArtifact(PNG, {
  mediaType: "image/png",
  filename: "cat.png",
  parentIds: [conv],
  taint: ["net"], // as though a provider had drawn it
  meta: { conversationId: conv, owner: "agent:chat-user" },
});
const analyzed = await call("analyze_image", { artifactId: image.id, question: "what animal is this?" });
const output = analyzed.body.output as { answer?: string; model?: string; mediaType?: string };
check("an image artifact can be analyzed", analyzed.body.ok === true, JSON.stringify(analyzed.body.output).slice(0, 90));
check("…and the answer is the model's text", output.answer === "a tabby cat on a windowsill", String(output.answer));
check("…asked of the configured vision model", seen.at(-1)?.model === VISION_MODEL, String(seen.at(-1)?.model));
check("…with the question the caller asked", seen.at(-1)?.text === "what animal is this?", String(seen.at(-1)?.text));
// The point of the whole worker: the ARTIFACT's bytes reached the provider, which only happens if
// the run token's `artifact: read_one` grant is really there.
check(
  "…and the artifact's own bytes, as a data URL",
  seen.at(-1)?.dataUrl === `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`,
  (seen.at(-1)?.dataUrl ?? "").slice(0, 40),
);
check("…in an image part", seen.at(-1)?.partType === "image_url", String(seen.at(-1)?.partType));
// An unset budget is the provider's to pick, and providers pick small: a description of one image
// came back cut off mid-sentence, with nothing in the result saying so.
check("…under an answer budget the worker set", seen.at(-1)?.maxTokens === ANSWER_TOKENS, String(seen.at(-1)?.maxTokens));
check("a complete answer says it finished", (analyzed.body.output as { finishReason?: string }).finishReason === "stop");
check("…and is not flagged as truncated", (analyzed.body.output as { truncated?: boolean }).truncated === undefined);

// ---- an answer that ran out of budget ----
// The property is that TRUNCATION IS VISIBLE. A cut-off answer is well-formed text that stops, so a
// result carrying only the text reads as complete, and the assistant reported half an account of an
// image as the whole picture. It cost a second call to notice, and only because the sentence ended
// oddly; a description that happened to stop at a full stop would not have been noticed at all.
truncateNext = true;
const cut = await call("analyze_image", { artifactId: image.id, question: "describe everything" });
const cutOut = cut.body.output as { answer?: string; truncated?: boolean; finishReason?: string; note?: string };
truncateNext = false;
check("a truncated answer still succeeds", cut.body.ok === true);
check("…and says it was truncated", cutOut.truncated === true, JSON.stringify(cutOut).slice(0, 80));
check("…naming the reason the provider gave", cutOut.finishReason === "length", String(cutOut.finishReason));
check("…and what to do instead", (cutOut.note ?? "").includes("narrower"), String(cutOut.note));
check("…while keeping the partial text", (cutOut.answer ?? "").endsWith("its fur"), String(cutOut.answer));

// Lineage, not assertion: the image is a data parent of the answer, so its labels are the answer's.
// An image is a prompt-injection vector, and a paragraph derived from one inherits that.
check(
  "the answer names the image as a data parent",
  analyzed.record.runtimeMeta.parentIds.includes(image.id),
  analyzed.record.runtimeMeta.parentIds.join(","),
);
check(
  "…so the image's labels ride into the answer",
  analyzed.record.runtimeMeta.taint.includes("net"),
  analyzed.record.runtimeMeta.taint.join(","),
);

// ---- a PDF is a document, not a picture ----
// The Flash models take a PDF as native input, so pages arrive with their layout. It travels in a
// `file` part with a filename, which is what tells the provider which parser to run; sending it as
// an `image_url` type-checks and is refused at the provider, so the shape is worth pinning here.
const pdf = await admin.putArtifact(new TextEncoder().encode("%PDF-1.4\n%%EOF\n"), {
  mediaType: "application/pdf",
  filename: "invoice.pdf",
  parentIds: [conv],
  meta: { conversationId: conv, owner: "agent:chat-user" },
});
const read = await call("analyze_image", { artifactId: pdf.id, question: "what is the total?" });
check("a PDF is accepted by the same tool", read.body.ok === true, JSON.stringify(read.body.output).slice(0, 90));
check("…as a file part, not an image", seen.at(-1)?.partType === "file", String(seen.at(-1)?.partType));
check("…named, so the provider knows what to parse", seen.at(-1)?.filename.endsWith(".pdf") === true, String(seen.at(-1)?.filename));

// ---- refusing, without spending a request ----
const requests = seen.length;
const textFile = await admin.putArtifact(new TextEncoder().encode("not an image"), {
  mediaType: "text/plain",
  filename: "notes.txt",
  parentIds: [conv],
  meta: { conversationId: conv, owner: "agent:chat-user" },
});
const wrongType = await call("analyze_image", { artifactId: textFile.id });
check("a media type the model cannot read is refused", wrongType.body.ok === false);
check(
  "…and the refusal names what it CAN read",
  TYPES.every((t) => String(wrongType.body.output).includes(t)),
  String(wrongType.body.output),
);

const big = await admin.putArtifact(new Uint8Array(MAX_BYTES + 1), {
  mediaType: "image/png",
  filename: "huge.png",
  parentIds: [conv],
  meta: { conversationId: conv, owner: "agent:chat-user" },
});
const tooBig = await call("analyze_image", { artifactId: big.id });
check("an oversized image is refused", tooBig.body.ok === false);
check("…against the limit it announced", String(tooBig.body.output).includes("512 bytes"), String(tooBig.body.output));

const missing = await call("analyze_image", { artifactId: "01JZZZZZZZZZZZZZZZZZZZZZZZ" });
check("an id that resolves to nothing is an ANSWER, not a hang", missing.body.ok === false, String(missing.body.output));

const noArg = await call("analyze_image", {});
check("a call with no artifactId says so", noArg.body.ok === false, String(noArg.body.output));

check("…and none of the four refusals reached the provider", seen.length === requests, `${seen.length - requests} calls`);

worker.kill();
await worker.status;
space.kill();
await space.status;
await stub.shutdown();
console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
