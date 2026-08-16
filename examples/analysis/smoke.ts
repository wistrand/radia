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
import { registerAnalysisKinds, STAGES } from "./kinds.ts";
import { bootstrap, grantUser } from "./roles.ts";
import { planAll } from "./planner.ts";
import { makeHandler } from "./serve.ts";

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
const { workerToken, plannerToken } = await bootstrap(admin);
const alice = "human:alice";
await grantUser(admin, alice);

const planner = new RadiaClient(url, { definitionToken: plannerToken });
const workers = STAGES.map((stage) =>
  new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "examples/analysis/worker.ts", "--url", url, "--stage", stage, "--token", workerToken],
    stdout: "null",
    stderr: "piped",
  }).spawn()
);
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

// Wait for all three workers to advertise, or the planner reports "blocked" for a stage whose
// worker is merely slow to start.
for (let i = 0; i < 60; i++) {
  if ((await planner.query({ kind: "stage_code" }, 10)).length >= STAGES.length) break;
  await new Promise((r) => setTimeout(r, 250));
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

const reportOf = async () => {
  const r = (await admin.query({ kind: "stage_result", match: { stage: "report", ok: "yes" } }, 1, { dir: "desc" }))[0];
  const b = r?.body as { outputArtifact?: string } | undefined;
  return b?.outputArtifact ? JSON.parse(new TextDecoder().decode(await admin.getArtifact(b.outputArtifact))) : null;
};
const first = await reportOf();
check("the report names the most variable column", first?.headline?.startsWith("c "), JSON.stringify(first?.headline));
check("…and the bad row was dropped by clean", first?.rows === 3, `rows=${first?.rows}`);

// ---- 2. changing NOTHING re-runs nothing ----
const before = (await admin.query({ kind: "stage_result" }, 100)).length;
for (let i = 0; i < 3; i++) await planAll(planner, { apply: true });
await new Promise((r) => setTimeout(r, 400));
const after = (await admin.query({ kind: "stage_result" }, 100)).length;
check("re-planning an unchanged pipeline computes nothing", after === before, `${before} → ${after}`);

// ---- 3. changing a STAGE's code re-runs it and everything downstream ----
//
// Simulated the way a real change works: a worker advertising a DIFFERENT digest. Editing
// stages.ts would do it too, and cannot be done from inside a running test.
const bumped = "s1:deadbeefdeadbeefdeadbeefdeadbeef";
const cleanResultsBefore = (await admin.query({ kind: "stage_result", match: { stage: "clean" } }, 50)).length;
await admin.put(
  { kind: "stage_code", body: { stage: "features", codeDigest: bumped, about: "a changed analysis" } },
  `stage-code:features:${bumped}`,
);
steps = await planAll(planner, { apply: true });
const featuresStep = steps.find((s) => s.stage === "features");
check("the planner asks for the CHANGED stage", featuresStep?.state === "requested" && featuresStep.codeDigest === bumped,
  JSON.stringify(featuresStep));
check("…and leaves the stage before it alone",
  (await admin.query({ kind: "stage_result", match: { stage: "clean" } }, 50)).length === cleanResultsBefore);
check("…and nothing downstream is asked for yet, because its input does not exist",
  !steps.some((s) => s.stage === "report" && s.state === "requested"));

// Nothing serves that digest, so the request sits unclaimed — which is itself the correct
// behaviour and worth pinning: a stage whose code nobody runs must not silently use another version.
await new Promise((r) => setTimeout(r, 800));
const orphan = (await admin.query({ kind: "stage_result", match: { stage: "features", codeDigest: bumped } }, 5)).length;
check("a request for code nobody serves is left unclaimed, never answered by the wrong version", orphan === 0);

// ASKING TWICE IS ONE REQUEST. The planner runs on every result, so an in-flight stage is planned
// over and over; without dedupe each pass would queue the same work again and the stage would run
// as many times as the planner woke. This is the only place that path is reachable — everywhere
// else the stages finish, and a finished stage returns before the request code.
for (let i = 0; i < 4; i++) await planAll(planner, { apply: true });
const queued = (await admin.query({ kind: "stage_request", match: { stage: "features", codeDigest: bumped } }, 20)).length;
check("planning an in-flight stage repeatedly queues it ONCE", queued === 1, `${queued} requests`);

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
