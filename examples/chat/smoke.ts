// The chat example's test suite. No API key, no model:
//
//   deno task chat-test              # everything
//   deno task chat-test context      # one suite, by name
//
// Why this exists. The chat app is the end-to-end exercise of the runtime, and in practice it is
// where bugs surface first. Most of them are not in the runtime but in this app's own handling of
// accumulated state: a resumed thread with a system message mid-conversation, a capability page
// that no longer reaches the newest tool, a grant narrowed in a way that removed a write
// permission. None of those needed a model to reproduce, and none were caught by reading the code.
//
// Everything here is record-level, which is what makes it possible: a tool call is a record, a
// conversation is records, and the context path is a function over rows. Each suite spawns its own
// space on its own port and cleans up.
//
// Adding one: write `smoke-<name>.ts` that prints `OK  ` / `FAIL` lines and exits 0, then add it
// below. Keep them independent: a suite that needs another to have run first is a suite that will
// fail confusingly.

const SUITES = [
  { name: "context", file: "smoke-context.ts", about: "provider payload assembly: system placement, windowing, orphaned tool replies" },
  { name: "longthread", file: "smoke-longthread.ts", about: "a long, awkward conversation: invariants checked at every position in it" },
  { name: "procedures", file: "smoke-procedures.ts", about: "saved procedures: save, call by name, read back, retire, shadowing, provenance" },
  { name: "resume", file: "smoke-resume.ts", about: "resuming a conversation across a real process restart" },
  { name: "selfgrant", file: "smoke-selfgrant.ts", about: "escalation: forbidden → request → approve → self-scoped reads, on both planes" },
  { name: "inspect", file: "smoke-inspect.ts", about: "the space_* tools on a busy space: paging past foreign events, and answering what the session may do" },
  { name: "iterate", file: "smoke-iterate.ts", about: "the code-gen loop as records: attempts that link, and verdicts the model cannot author" },
  { name: "save", file: "smoke-save.ts", about: "the two routes to a stored file, and the tool descriptions that choose between them" },
  { name: "login", file: "smoke-login.ts", about: "a person's own credential: who the session is, and that two people on one space cannot read each other" },
  { name: "join", file: "smoke-join.ts", about: "a session holding NO operator credential: it starts its own thread and takes turns, and cannot register a kind, mint a worker, grant itself anything or enumerate another conversation" },
  { name: "scope", file: "smoke-scope.ts", about: "what a scoped session may read: identity (all its own conversations) vs conversation (this thread only)" },
  { name: "encrypt", file: "smoke-encrypt.ts", about: "encrypted conversations end to end: who can fetch a key and who can open it, a real turn through the workers, a tool round the key-less turn worker still routes, a second machine, operator recovery, and erasure by destroying every key artifact" },
  { name: "runners", file: "smoke-runners.ts", about: "a second language as a capability: an unstartable jail is undiscoverable, and each name reaches its own runtime" },
  { name: "turnlink", file: "smoke-turnlink.ts", about: "the fenced turn link: a conversation call's answer IS the assistant message (the worker's ack), an inline call stays an RPC" },
  { name: "fleet", file: "smoke-fleet.ts", about: "model advertisements the router discovers: publish, restart, withdraw, revive" },
  { name: "capability", file: "smoke-capability.ts", about: "tool advertisements: replicas of one worker versus two tools wearing one name, and withdrawal" },
  { name: "input", file: "smoke-input.ts", about: "the REPL's stdin: the keystroke that went missing between a turn and the next prompt, type-ahead, and Escape" },
  { name: "edit", file: "smoke-edit.ts", about: "the line editor the prompt runs in raw mode: key decoding across split arrivals, word motion, history, scrolled redraw, and paste" },
  { name: "vision", file: "smoke-vision.ts", about: "reading an image: the accepted formats announced and enforced from one value, and what is refused before a request is spent" },
  { name: "render", file: "smoke-render.ts", about: "what the chat draws: a background writer that must not split a streaming answer, a status line that must fit the window, and colour that must not reach a pipe" },
  { name: "markdown", file: "smoke-markdown.ts", about: "rendering the answer while it arrives: the same text must render identically whether it comes whole, a line at a time, or one character at a time" },
  { name: "provider", file: "smoke-provider.ts", about: "what the provider reports while a model is still writing: a tool call's arguments stream too, and the usage the record keeps" },
  { name: "docs", file: "smoke-docs.ts", about: "reading a documentation-sized corpus: the large files a search used to skip in silence, and whether a hit inside one can actually be read" },
];

const wanted = Deno.args.filter((a) => !a.startsWith("-"));
const suites = wanted.length > 0 ? SUITES.filter((s) => wanted.includes(s.name)) : SUITES;
if (suites.length === 0) {
  console.error(`no such suite. known: ${SUITES.map((s) => s.name).join(", ")}`);
  Deno.exit(2);
}

let failed = 0;
const started = Date.now();
for (const suite of suites) {
  console.log(`\n── ${suite.name} ${"─".repeat(Math.max(0, 60 - suite.name.length))}\n   ${suite.about}\n`);
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL(`./${suite.file}`, import.meta.url).pathname],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  const text = new TextDecoder().decode(out.stdout);
  const err = new TextDecoder().decode(out.stderr);
  console.log(text.trimEnd());
  const fails = (text.match(/^ *FAIL/gm) ?? []).length;
  const oks = (text.match(/^ *OK {2}/gm) ?? []).length;
  // A suite that crashes reports nothing, which must not read as "no failures".
  if (!out.success || fails > 0 || oks === 0) {
    failed++;
    if (err.trim()) console.log(`\n   stderr:\n${err.trimEnd().split("\n").map((l) => `   ${l}`).join("\n")}`);
    console.log(`\n   ${suite.name}: ${fails} failed, ${oks} passed${out.success ? "" : " (suite exited non-zero)"}`);
  } else {
    console.log(`\n   ${suite.name}: ${oks} passed`);
  }
}

const secs = ((Date.now() - started) / 1000).toFixed(0);
console.log(`\n${failed === 0 ? "ok" : "FAILED"} | ${suites.length - failed}/${suites.length} suites (${secs}s)`);
Deno.exit(failed === 0 ? 0 : 1);
