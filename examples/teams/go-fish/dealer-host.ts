// The dealer of examples/teams/go-fish as a WORKSPACE AGENT: a program a model wrote, run per
// claim in a jail under the dealer's own identity, with the broker as its only way to the space.
//
//   deno run -A examples/teams/go-fish/dealer-host.ts --url … --team go-fish
//        [--workspace go-fish-dealer] [--entrypoint dealer.js] [--author author] [--repair-wait 180]
//
// Started by `radia team up` as the `dealer` SERVICE member, with RADIA_DEFINITION_TOKEN in its
// environment. It is the go-fish counterpart of examples/analysis/host.ts without the two
// operator writes that host relies on: no `binding` record and no promotion pin. The team file is
// the deployment decision here, so the binding is held in memory and follows the NEWEST version of
// the author's workspace, re-read per claim; a fix the author saves is live on the next move.
// Everything else is the workspace-agent shape (agent_docs/architecture-workspace-agents.md): the
// claim is taken under a run minted from the dealer's definition token (identity rule D4), the
// tree is materialised into the jail, `brokeredInvoker` stamps the team label and the claimed
// record as a parent on every proposal, and the returned value is the fenced ack result.
//
// When the program throws, the failure goes back to the MODEL that wrote it, as a task: the author
// gets {phase: "fix", error, failed: <record>}, saves a new version, and the nacked move retries
// under the new digest. The model is in the loop for the code and never for a move.

import { RadiaClient } from "../../../sdk/ts/client.ts";
import { agentLoop } from "../../../sdk/ts/loop.ts";
import { brokeredInvoker, declareBrokerSandbox } from "../../../extensions/ts/broker.ts";
import { type Binding, treeCache } from "../../../extensions/ts/host.ts";
import { readWorkspace } from "../../../extensions/ts/workspace.ts";
import { selectJavascriptJail } from "../../../extensions/ts/exec-tool.ts";

const flag = (name: string) => {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
};

const url = flag("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const team = flag("--team") ?? "go-fish";
const workspaceName = flag("--workspace") ?? "go-fish-dealer";
const entrypoint = flag("--entrypoint") ?? "dealer.js";
const author = flag("--author") ?? "author";
const definitionToken = Deno.env.get("RADIA_DEFINITION_TOKEN");
if (!definitionToken) {
  console.error("dealer-host: RADIA_DEFINITION_TOKEN is required (radia team up sets it for a service member)");
  Deno.exit(1);
}
const TEAM_FIELD = "team";

const client = new RadiaClient(url, { definitionToken });
const me = (await client.health()).agent ?? "agent:dealer";

// THE JAIL IS PROBED, NOT ASSERTED, the same way the lab's exec worker does it: confined under
// bubblewrap where that holds, the bare Deno jail otherwise, and refused when even that fails its
// own declaration. The sandbox RECORD this declares carries the broker's API, which is how the
// author learns the call shapes: `space_query {kind: "sandbox", match: {name: "<workspace>"}}`.
const jail = await selectJavascriptJail({ networkTarget: new URL(url).host, timeoutMs: 5000 });
if (jail.refusedBecause.length > 0) {
  console.error(`dealer-host: refusing to serve. The jail does not match its declaration: ${jail.refusedBecause.map((f) => `${f.claim} (${f.detail})`).join(", ")}`);
  Deno.exit(1);
}
await declareBrokerSandbox(client, {
  name: workspaceName,
  networkTarget: new URL(url).host,
  timeoutMs: 5000,
  ...(jail.confine ? { confine: jail.confine } : {}),
});
console.error(`dealer-host: ${me} runs ${workspaceName}/${entrypoint} ${jail.confine ? `CONFINED (${jail.confine})` : "in the bare Deno jail"}; sandbox record '${workspaceName}' declared`);

/** The binding, from the newest version of the author's workspace in this team. */
async function program(): Promise<Binding | null> {
  const ws = await readWorkspace(client, workspaceName, undefined, { [TEAM_FIELD]: team });
  if (!ws?.treeDigest) return null;
  return {
    agent: me,
    workspaceDigest: ws.treeDigest,
    entrypoint: ws.entrypoint ?? entrypoint,
    brokered: true,
    // Copied from the claimed record onto every brokered proposal, host-side: a move's outputs
    // land in the compartment the move came from, and the code cannot say otherwise.
    outputMeta: [TEAM_FIELD],
  };
}

// Nothing is claimed until there is a program to run it: a claim with no code behind it would
// only be nacked, and five of those dead-letter the opening move while the author is still typing.
let binding = await program();
if (!binding) console.error(`dealer-host: waiting for agent:${author} to save workspace '${workspaceName}'`);
while (!binding) {
  await new Promise((r) => setTimeout(r, 3000));
  binding = await program();
}
console.error(`dealer-host: program is ${binding.workspaceDigest.slice(0, 12)}, claiming task{tags: dealer}`);

const stop = new AbortController();
try {
  Deno.addSignalListener("SIGTERM", () => stop.abort());
  Deno.addSignalListener("SIGINT", () => stop.abort());
} catch { /* not on this platform */ }

const cache = treeCache(client);
const invoke = brokeredInvoker(client, { cache, ...(jail.confine ? { run: { confine: jail.confine } } : {}) });

/**
 * A program that REFUSES forever is invisible: it never throws, so the failure path above never
 * runs, and every refusal that hands the turn back is another paid harness launch. Measured, four
 * of them in a minute before a person noticed. So identical asks answered `ok: false` under one
 * program version are counted, and the third hands the author a fix naming the repetition.
 *
 * Knowing that `ok: false` is a refusal is this example's protocol, not the host's: a generic host
 * cannot tell a refusal from an answer. What generalises is the shape, a workspace agent making no
 * progress while reporting success.
 */
const STUCK_AT = 3;
const REPAIR_WAIT_MS = (Number(flag("--repair-wait") ?? Deno.env.get("GO_FISH_REPAIR_WAIT")) || 180) * 1000;
const refusals = new Map<string, number>();
async function watchForALoop(record: { id: string; body: unknown }, binding: Binding, answer: Record<string, unknown>): Promise<boolean> {
  const { title: _t, ...ask } = (record.body ?? {}) as Record<string, unknown>;
  // Keyed by the PLAYER, not by the exact ask: a player refused over and over costs a launch each
  // time whether or not it varies what it asks, and it varies (an illegal ask with a different rank
  // every time, where the refusal hands the turn back to the same player).
  const key = `${binding.workspaceDigest}:${typeof ask.player === "string" ? ask.player : JSON.stringify(ask)}`;
  if (answer.ok !== false) {
    refusals.delete(key);
    return false;
  }
  const seen = (refusals.get(key) ?? 0) + 1;
  refusals.set(key, seen);
  if (seen !== STUCK_AT) return false;
  console.error(`dealer-host: ${seen} identical refusals under ${binding.workspaceDigest.slice(0, 12)}; asking agent:${author} to fix the program`);
  await client.put({
    kind: "task",
    body: {
      [TEAM_FIELD]: team,
      tags: [author],
      phase: "fix",
      title: `${workspaceName}/${binding.entrypoint} refuses the same move over and over`,
      program: workspaceName,
      digest: binding.workspaceDigest,
      failed: record.id,
      error: `The program did not throw: it answered ${JSON.stringify(answer).slice(0, 400)} to ${seen} asks in a row from the same player (newest: ${JSON.stringify(ask).slice(0, 400)}). ` +
        `A refusal the program keeps repeating is its own bug, not the player's, and every one of them costs another launch. ` +
        `Check both halves: why the ask is refused at all, and whether the refusal leaves the same player on turn, which is what makes it repeat. ` +
        `Read the current table the way the task's kind_def describes, fix the cause, and save a new version.`,
    },
    parentIds: [record.id],
  }, `stuck:${key}`).catch((err) => console.error(`dealer-host: could not hand the loop to agent:${author}: ${err}`));
  return true;
}

/**
 * HOLD THE CLAIM until the author has saved a new version, rather than answering the refusal that
 * feeds the loop. Answering hands the turn back, which launches the player again, and the player
 * paid six of those during one 59-second repair. Holding stops the game where it is: the lease is
 * heartbeaten by `agentLoop`, and with concurrency 1 no other move runs meanwhile.
 */
async function waitForRepair(stale: string, signal: AbortSignal): Promise<Binding | null> {
  const until = Date.now() + REPAIR_WAIT_MS;
  while (Date.now() < until && !signal.aborted) {
    await new Promise((r) => setTimeout(r, 2000));
    const next = await program();
    if (next && next.workspaceDigest !== stale) return next;
  }
  return null;
}

await agentLoop(client, {
  name: "dealer",
  patterns: [{ kind: "task", match: { tags: { $any: "dealer" } } }],
  leaseSeconds: 60,
  signal: stop.signal,
  log: (m) => console.error(m),
  handle: async (record, _client, signal) => {
    // Per claim, so a fix the author saved since is what runs next.
    const current = (await program()) ?? binding!;
    if (current.workspaceDigest !== binding!.workspaceDigest) {
      console.error(`dealer-host: program is now ${current.workspaceDigest.slice(0, 12)}`);
      binding = current;
    }
    try {
      let running = current;
      let out = await invoke({ binding: running, record, client });
      let body = out.body && typeof out.body === "object" ? out.body as Record<string, unknown> : { value: out.body };
      if (await watchForALoop(record, running, body)) {
        const repaired = await waitForRepair(running.workspaceDigest, signal);
        if (repaired) {
          console.error(`dealer-host: repaired to ${repaired.workspaceDigest.slice(0, 12)}; re-running this move`);
          binding = running = repaired;
          out = await invoke({ binding: running, record, client });
          body = out.body && typeof out.body === "object" ? out.body as Record<string, unknown> : { value: out.body };
        } else {
          console.error(`dealer-host: no new program within ${REPAIR_WAIT_MS / 1000}s; answering the refusal as it stands`);
        }
      }
      return {
        kind: out.kind,
        body: { ...body, [TEAM_FIELD]: team },
        ...(out.parentIds?.length ? { parentIds: out.parentIds } : {}),
        ...(out.taint ? { taint: out.taint } : {}),
      };
    } catch (e) {
      const error = String(e).slice(0, 2000);
      console.error(`dealer-host: ${record.id} failed under ${current.workspaceDigest.slice(0, 12)}: ${error.split("\n")[0]}`);
      // One fix task per failing record and digest: a retry under the same code says nothing new.
      await client.put({
        kind: "task",
        body: {
          [TEAM_FIELD]: team,
          tags: [author],
          phase: "fix",
          title: `${workspaceName}/${current.entrypoint} threw on a move`,
          program: workspaceName,
          digest: current.workspaceDigest,
          failed: record.id,
          error,
        },
        parentIds: [record.id],
      }, `fix:${record.id}:${current.workspaceDigest}`).catch((err) => console.error(`dealer-host: could not hand the failure to agent:${author}: ${err}`));
      throw e; // nacked: the move did not happen, and it retries once the author has fixed the program
    }
  },
});
