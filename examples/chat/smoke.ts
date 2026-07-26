// The chat example's test suite. No API key, no model:
//
//   deno task chat-test              # everything
//   deno task chat-test context      # one suite, by name
//
// Why this exists. The chat app is the end-to-end exercise of the runtime, and in practice it is
// where bugs surface first — most of them not in the runtime but in this app's own handling of
// accumulated state: a resumed thread with a system message mid-conversation, a capability page
// that no longer reaches the newest tool, a grant narrowed in a way that removed a write
// permission. None of those needed a model to reproduce, and none were caught by reading the code.
//
// Everything here is record-level, which is what makes it possible: a tool call is a record, a
// conversation is records, and the context path is a function over rows. Each suite spawns its own
// space on its own port and cleans up.
//
// Adding one: write `smoke-<name>.ts` that prints `OK  ` / `FAIL` lines and exits 0, then add it
// below. Keep them independent — a suite that needs another to have run first is a suite that will
// fail confusingly.

const SUITES = [
  { name: "context", file: "smoke-context.ts", about: "provider payload assembly: system placement, windowing, orphaned tool replies" },
  { name: "longthread", file: "smoke-longthread.ts", about: "a long, awkward conversation — invariants checked at every position in it" },
  { name: "procedures", file: "smoke-procedures.ts", about: "saved procedures: save, call by name, read back, retire, shadowing, provenance" },
  { name: "resume", file: "smoke-resume.ts", about: "resuming a conversation across a real process restart" },
  { name: "selfgrant", file: "smoke-selfgrant.ts", about: "escalation: forbidden → request → approve → self-scoped reads, on both planes" },
  { name: "fleet", file: "smoke-fleet.ts", about: "model advertisements: publish, restart, withdraw, revive — what the router discovers" },
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
