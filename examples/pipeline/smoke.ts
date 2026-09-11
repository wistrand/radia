// The aggregator's READ DISCIPLINE, asserted. `deno task demo:ci` runs the pipeline end to end and
// proves the happy path; this proves the part that only shows up on a space with history, which is
// where both of this file's recorded bugs lived (agent_docs/plan-bounded-reads.md, incidents 26-27).
//
//   deno task test:pipeline
//
// Every case here is a job the aggregator must or must not summarize, planted directly as
// `pipeline_result` records so the fixture is exact. A fixed page fails at least one of them
// whichever way it faces: the oldest-N version stranded `late`, the newest-N version stranded
// `buried`, and only a forward walk from a watermark answers all three.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { resolveToken } from "../../src/credentials.ts";
import { registerDemoKinds } from "./kinds.ts";
import { aggregatorLoop } from "./aggregator.ts";

const PORT = 7897;
const url = `http://127.0.0.1:${PORT}`;
/** Unrelated results either side of the fixtures. More than 500 in total, which is what both
 *  recorded windows (the oldest 500, the newest 200) need to be seen failing. All ONE never-ending
 *  job, so the volume is in RECORDS and not in candidates: 500 separate jobs would make this file
 *  measure how fast a thousand round trips are and call the answer a correctness check. */
const FILLER = 250;
let failures = 0;
const check = (what: string, ok: boolean, detail: unknown = "") => {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${what}${detail === "" ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const dir = await Deno.makeTempDir({ prefix: "radia-pipeline-" });
const env = { RADIA_CREDENTIALS: `${dir}/credentials.json`, RADIA_DIR: `${dir}/radia`, RADIA_TOKEN: "", RADIA_DEFINITION_TOKEN: "" };
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
  env,
  stdout: "null",
  stderr: "null",
}).spawn();

try {
  const probe = new RadiaClient(url);
  for (let i = 0; i < 400; i++) {
    try {
      await probe.health();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  Deno.env.set("RADIA_CREDENTIALS", env.RADIA_CREDENTIALS);
  const c = new RadiaClient(url, { token: resolveToken(url)! });
  await registerDemoKinds(c);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const result = (jobId: string, index: number, total: number | undefined, output: string) =>
    c.put({ kind: "pipeline_result", body: { op: "upper", output, jobId, index, total } });
  const summaryOf = async (jobId: string) =>
    (await c.readOne<{ text: string }>({ kind: "pipeline_summary", match: { jobId } }))?.body.text ?? null;
  let fillerIndex = 0;
  const filler = async (n: number) => {
    for (let i = 0; i < n; i++) await result("filler", fillerIndex++, 999_999, "f");
  };
  /** Wait for something to become true, so no check is decided by how fast a pass happened to be.
   *  Both arity cases below passed VACUOUSLY under a fixed sleep: the pass that would have
   *  summarized them had not reached them yet, and "not summarized" read as "refused". */
  const until = async (what: string, ok: () => Promise<boolean>, ms = 60_000) => {
    const t0 = Date.now();
    while (!(await ok())) {
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  };

  console.log(`pipeline: the aggregator on a space with history (${FILLER * 2} unrelated results)`);

  // `buried`: complete before this process ever started, then pushed out of any newest-first window.
  await result("buried", 0, 3, "X");
  await result("buried", 1, 3, "Y");
  await result("buried", 2, 3, "Z");
  await filler(FILLER);
  // `late`: begun early, finished last, so any oldest-first window holds only its first two parts.
  await result("late", 0, 3, "A");
  await result("late", 1, 3, "B");
  await filler(FILLER);
  await result("late", 2, 3, "C");
  // `replayed`: a redelivered fan-out wrote index 0 twice. Three results, two distinct indexes.
  await result("replayed", 0, 3, "A");
  await result("replayed", 0, 3, "A");
  await result("replayed", 1, 3, "B");

  // `unsized`: a result that names no `total` claims nothing about how many there are. Comparing
  // against it completed a one-result job of unknown length.
  await result("unsized", 0, undefined, "only");
  // `disagreeing`: the same defect from the other side, two parts claiming different arities.
  await result("disagreeing", 0, 2, "P");
  await result("disagreeing", 1, 3, "Q");

  const ac = new AbortController();
  const loop = aggregatorLoop(c, ac.signal);

  const settled = async () => (await summaryOf("buried")) !== null && (await summaryOf("late")) !== null;
  let timedOut = false;
  await until("the two complete jobs to be summarized", settled).catch(() => {
    timedOut = true;
  });
  check("a job that finished before this process started is summarized", await summaryOf("buried") === "X Y Z", await summaryOf("buried"));
  check("and so is one whose last part arrived after a burst", await summaryOf("late") === "A B C", await summaryOf("late"));
  check("neither timed out", !timedOut);
  check("a replayed fan-out is NOT complete: two distinct indexes of three", await summaryOf("replayed") === null, await summaryOf("replayed"));

  // The third part lands: the same job must now finish, and finish ONCE.
  await result("replayed", 2, 3, "C");
  await until("the replayed job to complete", async () => (await summaryOf("replayed")) !== null).catch(() => {});
  check("and completes, in index order, with the duplicate dropped", await summaryOf("replayed") === "A B C", await summaryOf("replayed"));
  const summaries = await c.queryAll({ kind: "pipeline_summary", match: { jobId: "replayed" } });
  check("exactly one summary per job, whatever the pass count", summaries.length === 1, summaries.length);

  // ONLY NOW are the refusals meaningful. `reconcile` is single-flighted, so a pass that summarized
  // a job written after these two has necessarily already considered them and declined.
  check("a result claiming no arity decides nothing", await summaryOf("unsized") === null, await summaryOf("unsized"));
  check("and neither do two that disagree about it", await summaryOf("disagreeing") === null, await summaryOf("disagreeing"));

  ac.abort();
  await loop.catch(() => {});
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
} finally {
  try {
    space.kill();
    await space.status;
  } catch { /* already gone */ }
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}
if (failures > 0) Deno.exit(1);
