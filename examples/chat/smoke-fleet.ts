// Fleet advertisements: what the router discovers, and what happens when a worker stops.
//
//   deno run -A examples/chat/smoke-fleet.ts
//
// No model, no API key. An advertisement is a record, so publishing, withdrawing and reviving one
// are all record operations. The two properties worth pinning both have a history: an unconditional
// publish grew the space by the whole fleet per restart until discovery's bounded page stopped
// reaching the newest entry, and a worker that goes away must leave rotation or the router
// dispatches into silence.
//
// This is a script, not a `*.test.ts`: `deno task test:runtime` is for PORT contracts, not examples.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { liveModels, publishModel, retireModel } from "../../extensions/ts/model.ts";
import { publishCapability } from "../../extensions/ts/capability.ts";
import { announceFleet, retireFleetAdvertisements } from "./client/fleet.ts";
import { explicitTier, heuristicIndex, isContinuation, previousTurnTier } from "./workers/router.ts";

const PORT = 7801;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT)],
  stdout: "null",
  stderr: "inherit",
}).spawn();

const probe = new RadiaClient(url); // liveness only: /v0/health is public
let client: RadiaClient;
for (let i = 0; i < 100; i++) {
  try {
    await probe.health();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
client = new RadiaClient(url, { token: operatorToken(url) });
await registerChatKinds(client);

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

/** What the fleet is offering, through the SHARED projection rather than a copy of it. This file
 *  had its own re-implementation, so it could only ever prove that its own loop was right: a
 *  divergence in the projection the router and the escalation ladder actually call would have gone
 *  unnoticed here. Same reason `smoke-inspect.ts` drives the tools instead of the client. */
async function liveTiers(): Promise<string[]> {
  return (await liveModels(client)).map((m) => m.tier);
}

const countModels = async () => (await client.queryOldest({ kind: "model" }, 500)).length;

const FAST = { tier: "fast", model: "vendor/small", rank: 0 };
const DEEP = { tier: "deep", model: "vendor/large", rank: 2 };

// ---- publishing ----
await publishModel(client, FAST);
await publishModel(client, DEEP);
check("both tiers are discoverable", (await liveTiers()).join(",") === "fast,deep", (await liveTiers()).join(","));

const afterFirst = await countModels();
// The restart case, which is the one that used to grow the space: same advertisement, again.
for (let restart = 0; restart < 5; restart++) {
  await publishModel(client, FAST);
  await publishModel(client, DEEP);
}
check("re-publishing an unchanged advertisement writes nothing", await countModels() === afterFirst, `${afterFirst} records`);

// A real change IS a successor. That is how a worker moves to a new model.
await publishModel(client, { ...FAST, model: "vendor/small-v2" });
check("a changed advertisement is a successor", await countModels() === afterFirst + 1);
const moved = (await client.queryNewest({ kind: "model", match: { tier: "fast" } }, 1))[0];
check("…and the newest one wins", (moved.body as { model: string }).model === "vendor/small-v2");

// ---- withdrawal ----
await retireModel(client, { ...FAST, model: "vendor/small-v2" });
check("a retired tier leaves rotation", (await liveTiers()).join(",") === "deep", (await liveTiers()).join(","));
check("the other tier is untouched", (await liveTiers()).includes("deep"));

// Nothing is deleted: the audit trail of what was offered, and when, survives the withdrawal.
check("the history is still there", (await client.queryOldest({ kind: "model", match: { tier: "fast" } }, 50)).length >= 3);

// ---- revival ----
// The restart path. This is the trap in retire-then-republish: if the publish key collided with the
// advertisement it replaces, the write would be an idempotent replay and the tier would stay dead.
await publishModel(client, { ...FAST, model: "vendor/small-v2" });
check("restarting the worker revives its tier", (await liveTiers()).join(",") === "fast,deep", (await liveTiers()).join(","));

// ---- image models are not text tiers ----
await publishModel(client, { tier: "image", model: "vendor/pix", rank: 0, modalities: ["image"] });
check("an image model is not offered for text routing", !(await liveTiers()).includes("image"), (await liveTiers()).join(","));

// ---- the escalation ladder asks the same question the router does ----
// The ladder ("which tier is one step up from mine") read the `model` records RAW, so a gracefully
// stopped tier stayed a valid escalation target and escalating to it hung until the deadline. It
// is the same projection now, which is what this pins: retire the top tier and nothing above the
// bottom one remains to escalate to.
const nextUp = async (rank: number) => (await liveModels(client)).find((m) => (m.rank ?? 0) > rank)?.tier;
check("the ladder offers the stronger tier", (await nextUp(0)) === "deep", String(await nextUp(0)));
await retireModel(client, DEEP);
check("…and offers nothing once that tier is withdrawn", (await nextUp(0)) === undefined, String(await nextUp(0)));
await publishModel(client, DEEP);
check("…and offers it again when the worker comes back", (await nextUp(0)) === "deep", String(await nextUp(0)));

const tiers4 = ["fast", "balanced", "deep", "ultra"];

// --- a tier the user NAMED wins over the classifier ---
// Live failure: "retry deep" was classified as `fast` on all four rounds of one turn. The client
// cannot own this (a `/tier` command is the anti-pattern the design principle names), so the router
// honours it, using the discovered tier list rather than any name written here.
const say = (t: string) => explicitTier(t, tiers4);
check("a named tier with a cue is honoured", say("retry deep") === "deep", String(say("retry deep")));
check("…however it is phrased", say("try again with ultra") === "ultra", String(say("try again with ultra")));
check("…and the LAST one named wins", say("switch from fast to deep") === "deep", String(say("switch from fast to deep")));
// The cue is what stops the feature firing on ordinary prose that happens to contain a tier word.
check("a tier word with no cue is not a request", say("explain deep learning") === null, String(say("explain deep learning")));
check("…nor is a passing mention", say("the fast path matters here") === null, String(say("the fast path matters here")));
// Prepositions are not cues. These read as requests only if `with`/`on`/`in` count, and they did.
check("…nor a preposition near a tier word", say("a deep dive in the code") === null, String(say("a deep dive in the code")));
check("…nor prose about one", say("notes on deep learning") === null, String(say("notes on deep learning")));
check("an ordinary question names nothing", say("convert it to webgl") === null, String(say("convert it to webgl")));

// --- a bare continuation INHERITS the previous turn's tier ---
// "continue" is eight characters of small talk however hard the work is, so classifying it on its
// own text drops a turn to the cheapest model mid-flight. Reported live: with a capable model on
// the middle tier this appeared to work, because nothing had to understand the word.
for (const t of ["continue", "Continue.", "retry", "try again", "keep going", "more", "fix it"]) {
  check(`"${t}" is a continuation`, isContinuation(t), String(isContinuation(t)));
}
for (const t of ["continue the analysis of the router", "retry deep", "what next for the schema?", "add more tests"]) {
  check(`"${t}" is NOT a bare continuation`, !isContinuation(t), String(isContinuation(t)));
}

// And the inheritance itself, against real records rather than a stub.
const conv = (await client.put({ kind: "conversation", body: {} })).id;
const putCall = (turnAt: number, tier?: string) =>
  client.put({ kind: "llm_call", body: { conversationId: conv, turnAt, ...(tier ? { tier } : {}) }, parentIds: [conv] });
await putCall(0, "deep"); // the turn being continued ran on deep
await putCall(1); // the continuation's own seed, untiered, being routed right now
check(
  "a continuation inherits the tier of the turn before it",
  (await previousTurnTier(client, { conversationId: conv, turnAt: 1 }, tiers4)) === "deep",
  String(await previousTurnTier(client, { conversationId: conv, turnAt: 1 }, tiers4)),
);
await putCall(1, "fast"); // this turn's own round, which must not be mistaken for the previous turn
check(
  "…and never from its OWN rounds",
  (await previousTurnTier(client, { conversationId: conv, turnAt: 1 }, tiers4)) === "deep",
  String(await previousTurnTier(client, { conversationId: conv, turnAt: 1 }, tiers4)),
);
check(
  "…and never a tier whose worker is gone",
  (await previousTurnTier(client, { conversationId: conv, turnAt: 1 }, ["fast", "balanced"])) === null,
  String(await previousTurnTier(client, { conversationId: conv, turnAt: 1 }, ["fast", "balanced"])),
);
check(
  "a first turn has nothing to inherit",
  (await previousTurnTier(client, { conversationId: conv, turnAt: 0 }, tiers4)) === null,
  String(await previousTurnTier(client, { conversationId: conv, turnAt: 0 }, tiers4)),
);

// --- the fallback never reaches for the most expensive tier ---
// It runs only when the classifier errored, and a keyword regex is the weakest judge here. Adding a
// fourth tier turned "hard -> the top of the list" from Sonnet into Opus without a line changing,
// so the hard band aims one below the top and the top is reachable only by a deliberate choice.
const pick = (text: string, calls = 0) => tiers4[heuristicIndex(text, tiers4.length, calls)];
check("a code block routes to the second-most capable, not the top", pick("fix this ```js\nx\n```") === "deep", pick("fix this ```js\nx\n```"));
check("…and so does a long message", pick("x".repeat(500)) === "deep", pick("x".repeat(500)));
check("…and a tool-heavy synthesis round", pick("summarise", 4) === "deep", pick("summarise", 4));
check("small talk still routes to the cheapest", pick("hi there") === "fast", pick("hi there"));
check("an ordinary question takes a middle tier", pick("explain how leases work") === "balanced", pick("explain how leases work"));
// Short does not mean small talk when the question RANKS: "which call used most tokens" is 27
// characters, both routing paths read it as a lookup, and the cheapest tier answered it by naming
// records the words brought to mind. Composing ranked queries is middle-tier work.
check("a short ranking question is not small talk", pick("which call used most tokens") === "balanced", pick("which call used most tokens"));
check("…nor a counting one", pick("total cost of this session?") === "balanced", pick("total cost of this session?"));
check("plain small talk still lands on the cheapest", pick("thanks, looks great!") === "fast", pick("thanks, looks great!"));
check(
  "NOTHING positional selects the top tier",
  !tiers4.some((_, i) => pick(["hi", "explain this code", "x".repeat(900), "```\nprove it\n```"][i]) === "ultra"),
);
// With three tiers the same rule still leaves the top one to the classifier.
check("the rule holds at three tiers too", ["fast", "balanced", "deep"][heuristicIndex("```\nx\n```", 3, 0)] === "balanced");

// ── a worker may only read what its permissions allow ────────────────────────────────────────────
// Seen live: adding `Deno.env.get("RADIA_CHAT_CONCURRENCY")` to the tools worker crashed it on
// startup with NotCapable, because the fleet runs that one with a port and its tool roots and no
// `--allow-env` at all. The launcher has the environment; a worker takes arguments. Checked
// structurally, since the failure is at STARTUP and every suite that does not launch the real
// fleet is blind to it.
{
  const fleetSrc = Deno.readTextFileSync(new URL("./client/fleet.ts", import.meta.url));
  // Each spawn(...) call: its permission flags plus the worker file it runs.
  // The optional trailing argument is the environment the launcher passes (the fleet key), so the
  // closing bracket is not always followed by the closing paren.
  const spawns = [...fleetSrc.matchAll(/spawn\(\s*[`"'][^`"']*[`"']\s*,\s*\[([\s\S]*?)\]\s*(?:,[^)]*)?\)/g)];
  check("the fleet's spawns are parseable (this guard is not silently testing nothing)", spawns.length >= 5, `${spawns.length} spawns`);
  for (const m of spawns) {
    const args = m[1];
    const file = args.match(/["'](examples\/chat\/workers\/[a-z-]+\.ts)["']/)?.[1];
    if (!file) continue;
    const src = Deno.readTextFileSync(new URL("../../" + file, import.meta.url));
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // The worker's own source AND the app modules it loads, because an env read reached through an
    // import is the same NotCapable crash. Scanning only the worker missed exactly that: the tools
    // worker was handed the fleet key in its environment with no `--allow-env` to read it, so it
    // silently served no encrypted conversation. `import type` is ERASED and never loads, so
    // following one reports a variable the worker cannot touch.
    const workerUrl = new URL("../../" + file, import.meta.url);
    const imports = [...strip(src).matchAll(/\bimport\s+(?!type\b)[^;]*?from\s+["']((?:\.\.?\/)[^"']+\.ts)["']/g)]
      .map((i) => i[1]);
    let scanned = strip(src);
    for (const rel of imports) {
      try {
        scanned += strip(Deno.readTextFileSync(new URL(rel, workerUrl)));
      } catch { /* outside the app, or unreadable: its own suite covers it */ }
    }
    const readsEnv = /Deno\.env\./.test(scanned);
    const mayReadEnv = /--allow-env/.test(args);
    check(
      `${file.split("/").pop()}: reads env only if spawned with --allow-env`,
      !readsEnv || mayReadEnv,
      readsEnv ? (mayReadEnv ? "reads env, permitted" : "READS ENV WITHOUT --allow-env") : "no env reads",
    );

    // And WHICH variables, when the flag names a list. `--allow-env` bare permits everything;
    // `--allow-env=HOME` permits one, and reading any other THROWS rather than returning undefined.
    // That is a startup crash, and it happened: the exec worker gained the fleet key through an
    // imported module and stopped advertising anything. So the worker's own source is not enough —
    // the app modules it imports are followed one level, which is where that read lived.
    //
    // LITERAL reads only. `Deno.env.get(SOME_CONST)` is invisible here, which is exactly the shape
    // the exec worker's read has, so this does not cover that case and must not be read as doing
    // so; what closes that one is `env()` in space/keys.ts answering "unset" instead of throwing.
    // EVERY advertisement a launched worker publishes must carry the presence flag, because the
    // launcher beats for it (`spawn` appends --presence) and a reader treats an untracked
    // advertisement as always-live. Missing it on ONE publish is enough: `publishCapability`
    // supersedes by (provider, tool), so a second publish without the flag strips it off the first.
    // That shipped — images.ts published its two tools directly WITH the flag and then again
    // through `serveTools` without it, so the one provider whose tools a crashed fleet kept
    // offering was the one that advertised them twice.
    for (const call of [
      ...scanned.matchAll(/publishCapability\(([^;]*?)\)\s*;/g),
      ...scanned.matchAll(/serveTools\(([\s\S]*?)\n\}\)\s*;/g),
    ]) {
      const site = call[0].slice(0, 40).replace(/\s+/g, " ");
      check(
        `${file.split("/").pop()}: '${site}…' claims presence`,
        /PRESENCE|presence:/.test(call[1]),
        /PRESENCE|presence:/.test(call[1]) ? "flagged" : "PUBLISHES WITHOUT THE PRESENCE FLAG",
      );
    }

    const allowed = args.match(/--allow-env=([A-Za-z0-9_,]+)/)?.[1]?.split(",");
    if (!allowed) continue;
    const named = [...scanned.matchAll(/Deno\.env\.get\(\s*["']([A-Za-z0-9_]+)["']/g)].map((m2) => m2[1]);
    const missing = [...new Set(named)].filter((n) => !allowed.includes(n));
    check(
      `${file.split("/").pop()}: every variable it reads is in its --allow-env list`,
      missing.length === 0,
      missing.length ? `NOT PERMITTED: ${missing.join(", ")} (allowed: ${allowed.join(", ")})` : allowed.join(", "),
    );
  }
}

// ---- one space, several fleets ----
//
// An advertisement is keyed by (provider, tool) and therefore SHARED, so "retire what I published"
// names nothing: whoever exits first would take the tool list away from a fleet still serving. It
// cost `share_artifact`, `save_content` and every file tool in a real session, and nothing brought
// them back, because an unchanged definition re-published over a tombstone replays its own key.
{
  const TOOL = { type: "function" as const, function: { name: "smoke_share", description: "d", parameters: {} } };
  const PROVIDER = "agent:chat-tools";
  const advertised = async () => {
    const rows = await client.queryNewest({ kind: "capability", match: { tool: "smoke_share", provider: PROVIDER } }, 1);
    return rows.length > 0 && !(rows[0].body as { retired?: boolean }).retired;
  };
  await publishCapability(client, TOOL, PROVIDER);
  check("a tool is advertised once published", await advertised());

  const a = new AbortController(), b = new AbortController();
  const fleetA = await announceFleet(client, a.signal);
  const fleetB = await announceFleet(client, b.signal);
  a.abort();
  await retireFleetAdvertisements(client, fleetA);
  check("one fleet exiting leaves a serving fleet's advertisements alone", await advertised());

  b.abort();
  await retireFleetAdvertisements(client, fleetB);
  check("the LAST fleet out withdraws them", !(await advertised()));

  // The cycle has to close, or a space becomes un-advertisable after one restart: the revival is a
  // fresh key anchored on the tombstone, and the next withdrawal is anchored on the revival.
  const c2 = new AbortController();
  const fleetC = await announceFleet(client, c2.signal);
  await publishCapability(client, TOOL, PROVIDER);
  check("the next fleet's publish revives it", await advertised());
  c2.abort();
  await retireFleetAdvertisements(client, fleetC);
  check("…and that fleet's exit withdraws it again", !(await advertised()));
}

space.kill();
await space.status;
console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
