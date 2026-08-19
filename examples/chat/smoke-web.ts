// The web UI's server half: the page, and the relay everything else in the browser goes through.
//
// No browser here, and none is needed. What can go wrong on this side is all record- or
// header-level, and each check below is one property the page depends on:
//
//   1. the relay HOLDS NO CREDENTIAL, even when one is sitting in its environment
//   2. artifact responses keep the security headers the space set (the page's origin holds a token)
//   3. SSE is not buffered, and a reconnect resumes where it stopped (a watch is how a turn moves)
//   4. the page is served with a policy of its own, and nothing else is served at all
//   5. the session's own tools answer with NO watch stream, which is how a tab has to serve them
//   6. an attachment keeps the label and the conversation stamp its headers carried
//
// Phases 0-5 of agent_docs/plan-chat-web-ui.md. The sign-in dance itself is browser-side and is
// covered against a real issuer by conformance/oidc.test.ts.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { makeHandler } from "./web/serve.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { serveSessionTools } from "./client/session-tools.ts";
import { attachArtifact } from "./client/attach.ts";
import { installUI } from "./client/ui.ts";
import { terminalUI } from "./client/terminal.ts";

installUI(terminalUI); // the tool worker reports through the port like anything else

const PORT = 7826;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT)],
  stdout: "null",
  stderr: "inherit",
}).spawn();

const probe = new RadiaClient(url);
for (let i = 0; i < 100; i++) {
  try {
    await probe.health();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "OK  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

console.log("── web ─────────────────────────────────────────────────────────");
console.log("   the page server and its relay: what it forwards, what it holds, what it streams\n");

const token = operatorToken(url);
const admin = new RadiaClient(url, { token });

// The environment this handler is built in HOLDS AN OPERATOR TOKEN. That is the interesting case:
// a relay that read one would be a hole no grant could close and would be invisible from outside.
Deno.env.set("RADIA_TOKEN", token);
const app = makeHandler(url);

const get = (path: string, init: RequestInit = {}) => app(new Request("http://app" + path, init));
const auth = { authorization: "Bearer " + token };

// ---- 0. the protocol half carries no terminal ----
//
// The `ChatUI` port (client/ui.ts) is only real if the code behind it can leave Deno behind, and a
// grep over imports cannot show that: what matters is what the TRANSITIVE graph pulls. So bundle
// it and look, the same check `scripts/build-browser.sh` makes of the jail bundle. A reference
// that survives the tree-shake fails here rather than in a tab.
{
  const dir = await Deno.makeTempDir({ prefix: "radia-chat-web-" });
  const entry = `${dir}/entry.ts`;
  const client = new URL("./client/", import.meta.url).pathname;
  const web = new URL("./web/", import.meta.url).pathname;
  await Deno.writeTextFile(
    entry,
    // The browser ENTRY, plus the two protocol files it does not happen to reach (`grants.ts` is
    // phase 4's, `waiting.ts` arrives through `turn.ts`). Bundling the real entry rather than a
    // stand-in is what makes this a check on the shipped page.
    [`import "${web}app.ts";`, ...["turn", "thread", "waiting", "grants", "ui"].map((m) => `export * from "${client}${m}.ts";`)]
      .join("\n"),
  );
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["bundle", "--minify", "-o", `${dir}/bundle.js`, entry],
    stdout: "null",
    stderr: "piped",
  }).output();
  const bundled = out.success ? await Deno.readTextFile(`${dir}/bundle.js`) : "";
  check("the protocol half bundles for a browser", out.success, out.success ? "" : new TextDecoder().decode(out.stderr).split("\n")[0]);
  const refs = [...new Set(bundled.match(/Deno\.[a-zA-Z]+/g) ?? [])];
  check("and reaches no platform API", bundled.length > 0 && refs.length === 0, refs.join(" "));
  await Deno.remove(dir, { recursive: true });
}

// ---- 1. the page ----
{
  const res = await get("/");
  const html = await res.text();
  check("GET / serves the page", res.status === 200 && html.includes("radia chat"));
  check("the space URL is injected", html.includes(url) && !html.includes("__SPACE_URL__"));
  check("the page carries no token", !html.includes(token));
  check("the page is markup: its script is the bundle", html.includes(`src="/app.js"`) && !/<script>[^]*\S/.test(html));
  // Either answer is correct, and which one depends on whether the bundle has been built here. What
  // must never happen is a blank page: a missing bundle says what to run.
  const js = await get("/app.js");
  check(
    "the bundle is served, or its absence explains itself",
    js.status === 200 || (js.status === 404 && (await js.clone().text()).includes("bundle-chat-web")),
    `status ${js.status}`,
  );
  const csp = res.headers.get("content-security-policy") ?? "";
  check("the page states a policy", csp.includes("connect-src 'self'") && csp.includes("frame-ancestors 'none'"), csp.slice(0, 40) + "…");
  check("the page is not sniffable", res.headers.get("x-content-type-options") === "nosniff");
  check("nothing else is served", (await get("/secrets.txt")).status === 404);
}

// ---- 2. it holds no credential ----
{
  const anon = await get("/v0/records/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "message", limit: 1 }),
  });
  check("an unauthenticated call is refused", anon.status === 401 || anon.status === 403, `status ${anon.status}`);
  const mine = await get("/v0/health", { headers: auth });
  const health = await mine.json();
  check("a call carries the CALLER's token", mine.status === 200 && health.principal.length > 0, health.principal);
}

// ---- 3. artifact bytes keep the headers the space set ----
//
// The page paints images from bytes that come through here, and its origin is where the run token
// lives. A relay that dropped `content-security-policy` or `nosniff` would put sniffable content
// next to it. Compared against the space's own answer rather than a literal, so this keeps holding
// when the space changes its policy.
{
  const { id } = await admin.putArtifact(new TextEncoder().encode("<b>hi</b>"), { mediaType: "text/html", filename: "note.html" });
  const direct = await fetch(`${url}/v0/artifacts/${id}`, { headers: auth });
  const relayed = await get(`/v0/artifacts/${id}`, { headers: auth });
  const [a, b] = [await direct.text(), await relayed.text()];
  check("artifact bytes relay unchanged", a === b && relayed.status === 200);
  for (const h of ["content-security-policy", "x-content-type-options", "content-disposition"]) {
    check(`${h} survives the relay`, relayed.headers.get(h) === direct.headers.get(h), String(relayed.headers.get(h)));
  }
}

// ---- 4. watches stream, and resume ----
//
// The page waits on records the same way the terminal does, so a relay that buffered the body would
// turn every turn into a hang, and one that dropped `Last-Event-ID` would lose whatever happened
// between a reconnect and the reconnect's first event. Neither failure announces itself.
{
  const created = await get("/v0/watches", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ kind: "progress" }),
  });
  const { watchId } = await created.json();
  check("a watch is created through the relay", created.status === 201 && typeof watchId === "string");

  const stream = await get(`/v0/watches/${watchId}/events`, { headers: auth });
  check("the stream is text/event-stream", (stream.headers.get("content-type") ?? "").includes("text/event-stream"));

  const reader = stream.body!.getReader();
  const dec = new TextDecoder();
  /** Read until the stream yields an event carrying a record id, or the deadline passes. A
   *  BUFFERED relay fails here by timing out rather than by erroring. */
  const nextEvent = async (ms: number): Promise<string> => {
    const deadline = Date.now() + ms;
    let buf = "";
    while (Date.now() < deadline) {
      const timer = new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now())));
      const chunk = await Promise.race([reader.read(), timer]);
      if (!chunk || chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      if (/^data: .*recordId/m.test(buf)) return buf;
    }
    return "";
  };

  await admin.put({ kind: "progress", body: { stage: "one", by: "smoke" } });
  const first = await nextEvent(5000);
  check("a write arrives on the stream", first.includes("recordId"), first ? "" : "nothing within 5s");
  const lastId = (first.match(/^id: (\S+)/m) ?? [])[1] ?? "";
  check("events carry a resume id", lastId.length > 0);
  await reader.cancel();

  // Write while NOBODY is listening, then reconnect from the id the first stream reported. The
  // event has to be there: that is the whole promise of a resume cursor.
  await admin.put({ kind: "progress", body: { stage: "two", by: "smoke" } });
  const resumed = await get(`/v0/watches/${watchId}/events`, { headers: { ...auth, "last-event-id": lastId } });
  const r2 = resumed.body!.getReader();
  let buf = "";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const timer = new Promise<null>((r) => setTimeout(() => r(null), 500));
    const chunk = await Promise.race([r2.read(), timer]);
    if (chunk && !chunk.done) buf += dec.decode(chunk.value, { stream: true });
    if (/recordId/.test(buf)) break;
  }
  check("Last-Event-ID resumes the missed write", /recordId/.test(buf), buf ? "" : "the gap was lost");
  await r2.cancel();
}

// ---- 5. the session's own tools, served the way a tab serves them ----
//
// The inspection tools cannot be delegated to a worker at all: a delegated run carries no ops power
// and loses `scope: {createdBy: "self"}`, so whoever is asking has to be the one answering
// (client/session-tools.ts). What is new in a browser is HOW: `agentLoop` would park a stream per
// kind, and a page's six connections per origin are worth more than a wakeup, so it claims on the
// tick alone. This is that posture, end to end.
{
  await registerChatKinds(admin);
  const stop = new AbortController();
  const served = serveSessionTools(admin, stop.signal, undefined, false);
  const conversationId = (await admin.put({ kind: "conversation", body: {} })).id;
  const call = await admin.put({
    kind: "tool_call",
    body: { tool: "space_stats", args: {}, conversationId },
    parentIds: [conversationId],
  });
  let answer: { ok?: boolean } | null = null;
  for (let i = 0; i < 60 && !answer; i++) {
    const r = await admin.readOne({ kind: "tool_result", match: { callId: call.id } });
    if (r) answer = r.body as { ok?: boolean };
    else await new Promise((res) => setTimeout(res, 150));
  }
  check("a session tool is answered with no watch stream", answer?.ok === true, JSON.stringify(answer)?.slice(0, 60) ?? "no answer");
  stop.abort();
  await served.catch(() => {});
}

// ---- 6. an attachment, uploaded the way the page uploads one ----
//
// Through the RELAY, because that is the path a browser takes and the headers are where it can go
// wrong: an upload whose `x-radia-taint` is dropped does not fail, it stores the bytes unlabelled,
// and nothing notices until a policy that reads the label silently permits something. `x-radia-meta`
// carries the conversation stamp a grant matches on the way in.
{
  const conversationId = (await admin.put({ kind: "conversation", body: {} })).id;
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const res = await get("/v0/artifacts", {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "image/png",
      "x-radia-filename": "shot.png",
      "x-radia-meta": JSON.stringify({ conversationId, owner: "human:t" }),
      "x-radia-taint": "file",
    },
    body: bytes,
  });
  const stored = await res.json() as { id?: string };
  check("an attachment uploads through the relay", res.status === 201 && !!stored.id, `status ${res.status}`);
  const rec = stored.id ? await admin.getRecord(stored.id) : null;
  check("…keeping the label it raised", (rec?.runtimeMeta.taint ?? []).includes("file"), JSON.stringify(rec?.runtimeMeta.taint));
  check(
    "…and the conversation stamp a grant binds to",
    (rec?.body as { conversationId?: string })?.conversationId === conversationId,
  );

  // The MARKER is what the assistant reads, and both front ends produce it from one function
  // (client/attach.ts), so its shape is worth pinning: `artifactId <id>` is how a later tool call
  // reaches these bytes.
  const marker = await attachArtifact(admin, { bytes, mediaType: "image/png", filename: "shot.png" }, {
    conversationId,
    owner: "human:t",
  });
  check("the marker names the artifact by id", /^\[attached shot\.png · image\/png · \d+ KB · artifactId [A-Z0-9]{26}\]$/.test(marker), marker);
}

console.log(`\n  ${failures === 0 ? "web: all checks passed" : `web: ${failures} failed`}`);
try {
  space.kill();
} catch { /* already gone */ }
await space.status;
Deno.exit(failures === 0 ? 0 : 1);
