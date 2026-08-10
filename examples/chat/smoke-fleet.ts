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
// This is a script, not a `*.test.ts`: `deno task conformance` is for PORT contracts, not examples.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { liveModels, publishModel, retireModel } from "../../extensions/ts/model.ts";

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

const countModels = async () => (await client.query({ kind: "model" }, 500)).length;

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
const moved = (await client.query({ kind: "model", match: { tier: "fast" } }, 1, { dir: "desc" }))[0];
check("…and the newest one wins", (moved.body as { model: string }).model === "vendor/small-v2");

// ---- withdrawal ----
await retireModel(client, { ...FAST, model: "vendor/small-v2" });
check("a retired tier leaves rotation", (await liveTiers()).join(",") === "deep", (await liveTiers()).join(","));
check("the other tier is untouched", (await liveTiers()).includes("deep"));

// Nothing is deleted: the audit trail of what was offered, and when, survives the withdrawal.
check("the history is still there", (await client.query({ kind: "model", match: { tier: "fast" } }, 50)).length >= 3);

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

space.kill();
await space.status;
console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
