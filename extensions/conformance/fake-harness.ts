// A harness with no model in it, for the harness-worker contract: reads the prompt on stdin the
// way Claude Code and Codex do, echoes what it was told, and then does what `FAKE_MODE` says:
//   settle  : settles the claim named in the prompt itself, through the SDK under the session's
//             run (`FAKE_TOKEN`), with a `note` result, the way a member on MCP answers
//   exit0   : exits 0 without settling, so the loop acks for it
//   fail    : exits 3
//   hang    : sleeps, for the timeout and the fence
import { RadiaClient } from "../../sdk/ts/client.ts";

// Like Codex, announce a session id on the first line when asked to (`FAKE_THREAD`), and say
// which argv shape this launch got, so a test can tell a first launch from a resume.
if (Deno.env.get("FAKE_THREAD")) console.log(JSON.stringify({ type: "thread.started", thread_id: Deno.env.get("FAKE_THREAD") }));
console.log(`fake harness argv: ${Deno.args.join(" ")}`);
const prompt = await new Response(Deno.stdin.readable).text();
console.log(`fake harness got ${prompt.length} chars; record ${Deno.env.get("RADIA_RECORD_ID")}; claim ${Deno.env.get("RADIA_CLAIM_ID")}; cwd ${Deno.cwd()}`);
// The mode: from `FAKE_MODE_FILE` when set (a test rewrites it between launches of one worker,
// whose env is fixed), else `FAKE_MODE`.
const modeFile = Deno.env.get("FAKE_MODE_FILE");
const mode = (modeFile ? (await Deno.readTextFile(modeFile).catch(() => "")).trim() : "") || Deno.env.get("FAKE_MODE") || "exit0";
//   settle-linger : settles, then keeps running past a heartbeat before exiting, the way a real
//             harness prints its summary after its last tool call
if (mode === "settle" || mode === "settle-linger") {
  const m = /claim-([0-9A-Za-z]+)-(\d+)/.exec(prompt);
  if (!m) {
    console.error("no claim id in the prompt");
    Deno.exit(2);
  }
  // The run to settle under: handed in directly, or the session `radia team up` stored for this
  // member (`FAKE_SESSION`), read the way the adapter reads it, from the credentials file.
  let token = Deno.env.get("FAKE_TOKEN");
  if (!token) {
    const file = JSON.parse(await Deno.readTextFile(Deno.env.get("RADIA_CREDENTIALS")!)) as Record<string, { token?: string }>;
    token = file[`${Deno.env.get("RADIA_URL")}#session:${Deno.env.get("FAKE_SESSION")}`]?.token;
  }
  const client = new RadiaClient(Deno.env.get("RADIA_URL")!, { token: token! });
  const env = (await client.getEnvelope(m[1]))!;
  const res = await client.ack(
    { recordId: m[1], leaseId: env.leaseId!, epoch: env.leaseEpoch!, ownerRun: env.leaseOwner ?? "", expiresAt: env.leasedUntil ?? "" },
    { kind: "note", body: { team: Deno.env.get("FAKE_TEAM"), text: "answered by the fake harness", answer: 42, ...(Deno.env.get("FAKE_TOPIC") ? { topic: Deno.env.get("FAKE_TOPIC") } : {}) } },
  );
  console.log(`settled: ${res.status}`);
  if (mode === "settle-linger") await new Promise((r) => setTimeout(r, 4000));
  Deno.exit(res.status === "ok" ? 0 : 4);
}
if (mode === "fail") Deno.exit(3);
if (mode === "nack") {
  // Hand the claim back through the SDK, the way a harness that cannot do the work does.
  const m = /claim-([0-9A-Za-z]+)-(\d+)/.exec(prompt)!;
  const client = new RadiaClient(Deno.env.get("RADIA_URL")!, { token: Deno.env.get("FAKE_TOKEN")! });
  const env = (await client.getEnvelope(m[1]))!;
  // With a backoff, so the record does not bounce straight back to this same worker.
  const res = await client.nack({ recordId: m[1], leaseId: env.leaseId!, epoch: env.leaseEpoch!, ownerRun: env.leaseOwner ?? "", expiresAt: env.leasedUntil ?? "" }, { backoffSeconds: 120 });
  console.log(`nacked: ${res.status}`);
  Deno.exit(0);
}
if (mode === "ignore-term") {
  // A harness that shrugs off SIGTERM: the worker must escalate to SIGKILL.
  Deno.addSignalListener("SIGTERM", () => console.log("ignoring SIGTERM"));
  await new Promise((r) => setTimeout(r, 60_000));
}
if (mode === "hang") await new Promise((r) => setTimeout(r, 60_000));
Deno.exit(0);
