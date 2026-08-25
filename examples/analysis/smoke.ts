// The pipeline, headless: does keying on digests actually do what the design claims?
//
//   deno run -A examples/analysis/smoke.ts
//
// Three properties, and the second is the one the whole example exists to demonstrate:
//
//   1. an upload runs every stage, in order, chained by content digest
//   2. changing a stage's CODE re-runs it and everything after it, and nothing before it
//   3. changing nothing re-runs nothing, however many times the planner executes
//
// No browser and no OIDC here: this drives the same functions the app calls, against a real space,
// so the pipeline is tested even though the sign-in dance is not.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerAnalysisKinds, STAGES, type StageName } from "./kinds.ts";
import { publishStageWorkspaces } from "./stages.ts";
import { bootstrap, deployStages, grantUser, stageAgent } from "./roles.ts";
import { planAll } from "./planner.ts";
import { makeHandler } from "./serve.ts";
import { BINDING, readBindings } from "../../extensions/ts/host.ts";
import { pinnedDigests, promote } from "../../extensions/ts/promotion.ts";
import { writeWorkspace } from "../../extensions/ts/workspace.ts";

const PORT = 7903;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
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

console.log("── analysis ────────────────────────────────────────────────────");
console.log("   a staged pipeline keyed on content: what re-runs when code changes\n");

const admin = new RadiaClient(url, { token: operatorToken(url) });
await registerAnalysisKinds(admin);
const published = await publishStageWorkspaces(admin);
const { agentTokens, readerToken, plannerToken } = await bootstrap(admin);
await deployStages(admin, published);
const alice = "human:alice";
await grantUser(admin, alice);

const planner = new RadiaClient(url, { definitionToken: plannerToken });
const workers = [
  new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "examples/analysis/host.ts",
      "--url",
      url,
      "--reader-token",
      readerToken,
      ...STAGES.flatMap((stage) => ["--agent", `${stage}=${agentTokens[stage]}`]),
    ],
    stdout: "null",
    stderr: "piped",
  }).spawn(),
];
// Drain stderr or a chatty worker blocks on a full pipe.
for (const w of workers) w.stderr.pipeTo(new WritableStream()).catch(() => {});

/** Run the planner to a fixed point: it asks for one stage at a time, by design. */
const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) {
    await planAll(planner, { apply: true });
    await new Promise((r) => setTimeout(r, 250));
    const steps = await planAll(planner, { apply: false });
    if (steps.length > 0 && steps.every((s) => s.state === "done" || s.state === "failed" || s.state === "blocked")) {
      return steps;
    }
  }
  return await planAll(planner, { apply: false });
};

// ---- 0. discovery and enforcement read the same state ----
//
// No advertisement exists any more: the planner discovers live code from the BINDINGS, and the
// promotion pins enforce the same digests. Both must name the published trees, read back from the
// records that respectively route and refuse. Nothing to wait for, either: deployment is
// synchronous, where the old self-advertisement needed a worker to boot first.
{
  const bindings = await readBindings(admin);
  const bound = (s: string) => bindings.find((b) => b.agent === stageAgent(s as StageName))?.workspaceDigest;
  check("each stage's binding names its published treeDigest",
    STAGES.every((s) => bound(s) === published[s]),
    STAGES.map((s) => `${s}:${bound(s) === published[s] ? "=" : `${bound(s)?.slice(0, 10)}≠${published[s].slice(0, 10)}`}`).join(" "));
  const pinsOk = await Promise.all(STAGES.map(async (s) => {
    const pins = await pinnedDigests(admin, { principal: stageAgent(s), tier: "prod", kind: "stage_request" });
    return pins.length === 1 && pins[0] === published[s];
  }));
  check("…and each stage's take-pin enforces the same digest", pinsOk.every(Boolean));
}

// ---- 1. an upload runs every stage ----
const csv = "a,b,c\n1,2,30\n4,5,90\n2,2,20\nnot,a,row\n";
const art = await admin.putArtifact(new TextEncoder().encode(csv), {
  mediaType: "text/csv",
  filename: "sales.csv",
  meta: { owner: alice },
});
await admin.put({
  kind: "dataset",
  body: { name: "sales", digest: art.digest, artifactId: art.id, owner: alice },
  parentIds: [art.id],
});

let steps = await settle();
check("every stage ran", steps.length === STAGES.length && steps.every((s) => s.state === "done"),
  steps.map((s) => `${s.stage}:${s.state}`).join(" "));
check("…in order", steps.map((s) => s.stage).join(",") === STAGES.join(","));
// The chain: each stage's input digest is the previous stage's output digest. That is the whole
// mechanism, so it is asserted rather than assumed.
check("…chained by content digest",
  steps.slice(1).every((s, i) => s.inputDigest === steps[i].outputDigest),
  steps.map((s) => `${s.inputDigest.slice(0, 6)}→${(s.outputDigest ?? "").slice(0, 6)}`).join(" "));

// The pin vocabulary: requests and results carry {workspace, tier}, the exact paths promotion's
// grant pattern binds, which is what step 4's enforcement claims and refuses on.
{
  const [req] = await admin.queryOldest({ kind: "stage_request", match: { workspace: published.clean, tier: "prod" } }, 1);
  check("requests carry the pin vocabulary {workspace, tier}, matchable", req !== undefined);
  const [res] = await admin.queryOldest({ kind: "stage_result", match: { workspace: published.report } }, 1);
  check("results name the tree that produced them, matchable", res !== undefined);
}

// A stage run in the jail knows its output's DIGEST, not the artifact id the capture assigned, so
// readers resolve content-addressed: the same move the planner makes when chaining.
const reportOf = async () => {
  const r = (await admin.queryNewest({ kind: "stage_result", match: { stage: "report", ok: "yes" } }, 1))[0];
  const b = r?.body as { outputDigest?: string } | undefined;
  if (!b?.outputDigest) return null;
  const [art] = await admin.queryNewest({ kind: "artifact", match: { digest: b.outputDigest } }, 1);
  return art ? JSON.parse(new TextDecoder().decode(await admin.getArtifact(art.id))) : null;
};
const first = await reportOf();
check("the report names the most variable column", first?.headline?.startsWith("c "), JSON.stringify(first?.headline));
check("…and the bad row was dropped by clean", first?.rows === 3, `rows=${first?.rows}`);

// The host stamped the output artifact with the REQUEST's owner (binding.outputMeta), which is
// what keeps the person's {owner}-scoped artifact grant reaching bytes an agent authored.
{
  const r = (await admin.queryNewest({ kind: "stage_result", match: { stage: "report", ok: "yes" } }, 1))[0];
  const digest = (r?.body as { outputDigest?: string })?.outputDigest ?? "";
  const [mine] = await admin.queryOldest({ kind: "artifact", match: { digest, owner: alice } }, 1);
  check("the report artifact carries the person as owner, not the agent", mine !== undefined);
}

// ---- 1b. all-garbage data completes, and the report refuses to headline nothing ----
//
// Broken ROWS are dropped and counted (asserted above via the sales CSV). ALL-broken input is the
// sharper case: clean reads a lettered first line as a header, so columns exist with n=0
// throughout, and the report used to print "vvv varies most (cv 0, mean 0 over 0 values)" — a
// confident sentence about nothing. Only a column that held values may headline.
{
  const junk = await admin.putArtifact(new TextEncoder().encode("vvv\nooo\n???\n"), {
    mediaType: "text/csv",
    meta: { owner: alice },
  });
  await admin.put({
    kind: "dataset",
    body: { name: "noise", digest: junk.digest, artifactId: junk.id, owner: alice },
    parentIds: [junk.id],
  });
  const steps1b = await settle();
  const noise = steps1b.filter((s) => s.dataset === "noise");
  check("an all-garbage upload still runs every stage to done", noise.length === STAGES.length && noise.every((s) => s.state === "done"),
    noise.map((s) => `${s.stage}:${s.state}`).join(" "));
  const [r] = await admin.queryNewest({ kind: "stage_result", match: { stage: "report", dataset: "noise", ok: "yes" } }, 1);
  const digest = (r?.body as { outputDigest?: string })?.outputDigest ?? "";
  const [art] = await admin.queryNewest({ kind: "artifact", match: { digest } }, 1);
  const report = art ? JSON.parse(new TextDecoder().decode(await admin.getArtifact(art.id))) : null;
  check("…and its report says so instead of headlining a column with no values",
    report?.headline === "no numeric data was found", JSON.stringify(report?.headline));
}

// ---- 2. changing NOTHING re-runs nothing ----
const before = (await admin.queryOldest({ kind: "stage_result" }, 100)).length;
for (let i = 0; i < 3; i++) await planAll(planner, { apply: true });
await new Promise((r) => setTimeout(r, 400));
const after = (await admin.queryOldest({ kind: "stage_result" }, 100)).length;
check("re-planning an unchanged pipeline computes nothing", after === before, `${before} → ${after}`);

// ---- 3. changing a STAGE's code re-runs it and everything downstream ----
//
// Simulated the way a real change works: the operator REBINDING the stage to a different digest.
// Editing a stage's tree and redeploying would do it too, and cannot be done from inside a
// running test.
const bumped = "s1:deadbeefdeadbeefdeadbeefdeadbeef";
const cleanResultsBefore = (await admin.queryOldest({ kind: "stage_result", match: { stage: "clean" } }, 50)).length;
await admin.put({
  kind: BINDING,
  body: { agent: stageAgent("features"), workspaceDigest: bumped, entrypoint: "features/main.ts" },
});
steps = await planAll(planner, { apply: true });
const featuresStep = steps.find((s) => s.stage === "features");
check("the planner asks for the CHANGED stage", featuresStep?.state === "requested" && featuresStep.workspace === bumped,
  JSON.stringify(featuresStep));
check("…and leaves the stage before it alone",
  (await admin.queryOldest({ kind: "stage_result", match: { stage: "clean" } }, 50)).length === cleanResultsBefore);
check("…and nothing downstream is asked for yet, because its input does not exist",
  !steps.some((s) => s.stage === "report" && s.state === "requested"));

// The pin still says the OLD digest, so no agent may claim the bumped request: rebinding without
// promoting deploys nothing, by construction, and the request waits for the missing half of the
// two locks rather than being answered by whatever code is around.
await new Promise((r) => setTimeout(r, 800));
const orphan = (await admin.queryOldest({ kind: "stage_result", match: { stage: "features", workspace: bumped } }, 5)).length;
check("a request whose digest no pin covers is left unclaimed, never answered by the wrong version", orphan === 0);

// ASKING TWICE IS ONE REQUEST. The planner runs on every result, so an in-flight stage is planned
// over and over; without dedupe each pass would queue the same work again and the stage would run
// as many times as the planner woke. This is the only place that path is reachable — everywhere
// else the stages finish, and a finished stage returns before the request code.
for (let i = 0; i < 4; i++) await planAll(planner, { apply: true });
// PER DATASET, which is the unit the dedupe key covers: each dataset legitimately queues its own
// features request under the bumped digest, and each must do so exactly once.
const bumpedReqs = await admin.queryOldest({ kind: "stage_request", match: { stage: "features", workspace: bumped } }, 20);
const perDataset = new Map<string, number>();
for (const r of bumpedReqs) {
  const d = (r.body as { dataset: string }).dataset;
  perDataset.set(d, (perDataset.get(d) ?? 0) + 1);
}
check("planning an in-flight stage repeatedly queues it ONCE per dataset",
  perDataset.size > 0 && [...perDataset.values()].every((n) => n === 1),
  [...perDataset.entries()].map(([d, n]) => `${d}:${n}`).join(" "));

// ---- 4. a result cannot lie about which code produced it ----
//
// The check the old architecture could not express: `stage_result: put` comes ONLY from the
// promotion pin {workspace, tier}, so a result naming any other digest is refused at the door by
// `bodyMatchesGrant` — not filed and doubted later. Every "has this version already run" answer
// rests on this field, and it is now enforced rather than reported.
{
  const features = new RadiaClient(url, { definitionToken: agentTokens.features });
  const forged = {
    stage: "features",
    dataset: "smoke-forged", // no such dataset, so the control write below cannot poison the memo
    inputDigest: "x",
    workspace: bumped,
    tier: "prod",
    outputDigest: "y",
    owner: alice,
    ok: "yes",
  };
  const status = await features.put({ kind: "stage_result", body: forged })
    .then(() => "accepted", (e) => String((e as { status?: number }).status ?? e));
  check("a result under a NON-pinned digest is REFUSED at the write", status === "403", status);
  // The control: identical body, pinned digest, accepted — so the refusal above is about the
  // digest and nothing else.
  const control = await features.put({ kind: "stage_result", body: { ...forged, workspace: published.features } })
    .then(() => "accepted", (e) => String((e as { status?: number }).status ?? e));
  check("…and the same result under the pinned digest is accepted", control === "accepted", control);
}

// ---- 5. the pipeline's SHAPE is data: a NEW stage deploys into the live pipeline ----
//
// The chat-to-pipeline path, end to end: a workspace authored like any other (save_procedure
// yields exactly this shape) becomes a fourth stage by DEPLOYMENT alone — def + promote + bind
// plus a host holding its token — and only the new suffix computes. No planner edit, no constant,
// no restart of anything already running.
{
  // First undo test 3's drift: rebind features to its real tree (rollback is a binding write),
  // or every walk stalls there and the new stage is unreachable.
  await admin.put({
    kind: BINDING,
    body: {
      agent: stageAgent("features"),
      workspaceDigest: published.features,
      entrypoint: "features/main.ts",
      inputs: [{ field: "inputArtifact", path: "data" }],
      outputWorkspace: "stage-features-out",
      outputMeta: ["owner", "dataset"],
    },
  });
  const countOf = async (stage: string) => (await admin.queryOldest({ kind: "stage_result", match: { stage } }, 50)).length;
  const before: Record<string, number> = {};
  for (const s of STAGES) before[s] = await countOf(s);

  // The new stage's tree: the same harness beside its own entry module.
  const harness = await Deno.readFile(new URL("./stages/harness.ts", import.meta.url));
  const tldr = await writeWorkspace(admin, {
    name: "stage-tldr",
    owner: "analysis",
    files: {
      "harness.ts": harness,
      "tldr/main.ts": `import { runStage } from "../harness.ts";
export default (record) => runStage(record, (input) => {
  const { headline } = JSON.parse(new TextDecoder().decode(input));
  return new TextEncoder().encode(headline + "\\n");
});
`,
    },
    entrypoint: "tldr/main.ts",
  });

  // Deployment, all operator writes: the def (where in the shape), the agent, both pins, the
  // binding. Index 40 lands it after report.
  await admin.put({ kind: "stage_def", body: { stage: "tldr", index: 40 } }, "stage-def:tldr:40");
  const def = await admin.createAgentDefinition("agent:analysis-tldr", [
    { principal: "agent:analysis-tldr", kind: "workspace", operations: ["put", "query"] },
    { principal: "agent:analysis-tldr", kind: "artifact", operations: ["put", "read_one"] },
  ]);
  await promote(admin, { digest: tldr.treeDigest, tier: "prod", kind: "stage_request", pins: [{ principal: "agent:analysis-tldr", operations: ["take"] }] });
  await promote(admin, { digest: tldr.treeDigest, tier: "prod", kind: "stage_result", pins: [{ principal: "agent:analysis-tldr", operations: ["put"] }] });
  await admin.put({
    kind: BINDING,
    body: {
      agent: "agent:analysis-tldr",
      workspaceDigest: tldr.treeDigest,
      entrypoint: "tldr/main.ts",
      inputs: [{ field: "inputArtifact", path: "data" }],
      outputWorkspace: "stage-tldr-out",
      outputMeta: ["owner", "dataset"],
    },
  });
  // A SECOND host, because hosting is only holding the definition token: the one already running
  // needs no restart and never learns the new stage exists.
  const tldrHost = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "examples/analysis/host.ts", "--url", url, "--reader-token", readerToken, "--agent", `tldr=${def.definitionToken}`],
    stdout: "null",
    stderr: "piped",
  }).spawn();
  tldrHost.stderr.pipeTo(new WritableStream()).catch(() => {});
  workers.push(tldrHost);

  const steps5 = await settle();
  // Scoped to ONE dataset: several are flowing by now, and chaining assertions only make sense
  // within a single dataset's walk.
  const tldrStep = steps5.find((s) => s.dataset === "sales" && s.stage === "tldr");
  const reportStep = steps5.find((s) => s.dataset === "sales" && s.stage === "report");
  check("the NEW stage runs to done", tldrStep?.state === "done", JSON.stringify(tldrStep));
  check("…chained onto report's output", tldrStep !== undefined && tldrStep.inputDigest === reportStep?.outputDigest);
  const untouched = await Promise.all(STAGES.map(async (s) => (await countOf(s)) === before[s]));
  check("…and nothing already computed re-ran", untouched.every(Boolean));
  const [tldrArt] = await admin.queryNewest({ kind: "artifact", match: { digest: tldrStep?.outputDigest ?? "" } }, 1);
  const text = tldrArt ? new TextDecoder().decode(await admin.getArtifact(tldrArt.id)) : "";
  check("…and its output is the headline alone", text.startsWith("c varies most"), JSON.stringify(text.slice(0, 40)));
}

// ---- the web app's relay: it holds nothing, and forwards what it is given ----
{
  const handler = makeHandler(url);
  const res = await handler(new Request(`http://127.0.0.1:1/v0/health`));
  check("the app relays to the space", res.status === 200);
  const anon = await handler(new Request(`http://127.0.0.1:1/v0/records/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "dataset", limit: 5 }),
  }));
  // No Authorization forwarded means no identity invented: the space decides, and for a space with
  // auth required that is a refusal. The app has no credential to fall back on, which is the point.
  check("…and an unauthenticated call is refused by the SPACE, not answered by the app",
    anon.status === 401 || anon.status === 403, String(anon.status));
  const page = await handler(new Request("http://127.0.0.1:1/"));
  const html = await page.text();
  check("the page is served with the space's URL injected", html.includes(url) && !html.includes("__SPACE_URL__"));
}

// ---- the pass is FLAT in the number of datasets ----
//
// It runs on every result landing, so a per-dataset cost multiplies: it used to ask per dataset per
// stage, which is O(datasets x stages) queries per stage completion. Counted rather than asserted,
// because "should be cheaper now" is not a property anything can hold onto.
//
// LAST in the file, because it creates datasets and several checks above count records across the
// whole space. A test that quietly changes what the next one measures is worse than no test.
{
  const count = (c: RadiaClient) => {
    let n = 0;
    return {
      client: new Proxy(c, {
        get(t, prop, recv) {
          const v = Reflect.get(t, prop, recv);
          if (prop === "query" && typeof v === "function") {
            return (...args: unknown[]) => {
              n++;
              return (v as (...a: unknown[]) => unknown).apply(t, args);
            };
          }
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      }) as RadiaClient,
      reads: () => n,
    };
  };

  const one = count(planner);
  await planAll(one.client, { apply: false });
  const withOne = one.reads();

  // Four more datasets, already planned to completion by nobody: the point is the READ cost of a
  // pass, which must not grow with how many there are.
  for (let i = 0; i < 4; i++) {
    const a = await admin.putArtifact(new TextEncoder().encode(`a,b\n${i},${i + 1}\n`), {
      mediaType: "text/csv",
      meta: { owner: alice },
    });
    await admin.put({
      kind: "dataset",
      body: { name: `bulk-${i}`, digest: a.digest, artifactId: a.id, owner: alice },
      parentIds: [a.id],
    });
  }
  const five = count(planner);
  await planAll(five.client, { apply: false });
  check("a planning pass costs the same for 5 datasets as for 1", five.reads() === withOne,
    `${withOne} reads for 1, ${five.reads()} for 5`);
  check("…and that cost is a handful of reads, not a handful per dataset", withOne <= 6, `${withOne} reads`);
}

console.log(`\n${failures === 0 ? "ok" : `${failures} FAILED`}`);
for (const w of workers) {
  try {
    w.kill();
  } catch { /* gone */ }
  await w.status;
}
space.kill();
await space.status;
Deno.exit(failures === 0 ? 0 : 1);
