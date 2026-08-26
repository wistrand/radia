// The world, headless: does a shared space actually behave like a room full of people?
//
//   deno run -A examples/mud/smoke.ts
//
// NO API KEY AND NO MODEL. Everything phase 1 claims is checkable without one, which is the reason
// the phases are ordered the way they are (agent_docs/plan-mud.md).
//
// Six properties, and the last two are the ones an example about coordination exists to show:
//
//   1. a first command places a newcomer and describes where they are
//   2. an NPC standing there answers, under its own principal
//   3. moving writes the departure and the arrival in the right rooms, and moves `presence`
//   4. a room's occupant list is a PROJECTION: somebody who left is not still standing there
//   5. a player cannot type as somebody else       (the runtime refuses the write)
//   6. an NPC cannot speak in a room it is not in  (the runtime refuses the write)
//   7. an NPC acts on its OWN clock, by acking each beat with the next one deferred

import { RadiaClient, RadiaClientError, type RadiaRecord } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerMudKinds, WORLD_ID } from "./kinds.ts";
import { seedAmbient, seedWorld } from "./world.ts";
import { bootstrap, npcAgent, playerGrants } from "./roles.ts";
import { narratorLoop } from "./narrator.ts";
import { livePresence } from "./presence.ts";
import { npcLoop } from "./npc.ts";
import type { EventBody } from "./feed.ts";

const PORT = 7905;
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

console.log("── mud ─────────────────────────────────────────────────────────");
console.log("   a shared world: one narrator, two NPCs, no model anywhere\n");

const admin = new RadiaClient(url, { token: operatorToken(url) });
await registerMudKinds(admin);
await seedWorld(admin);
const { narratorToken, npcTokens } = await bootstrap(admin);

const stop = new AbortController();
narratorLoop(new RadiaClient(url, { definitionToken: narratorToken }), { signal: stop.signal });
// One second between ambient beats, against thirty in a real world: the chain has to be observable
// inside a test, and the interval is a parameter for exactly that reason.
const AMBIENT = 1;
npcLoop(new RadiaClient(url, { definitionToken: npcTokens.gatekeeper }), "gatekeeper", "the gatekeeper", {
  signal: stop.signal,
  ambientSeconds: AMBIENT,
});
npcLoop(new RadiaClient(url, { definitionToken: npcTokens.barkeep }), "barkeep", "the barkeep", {
  signal: stop.signal,
  ambientSeconds: AMBIENT,
});

/** A player, exactly as `run.ts` mints one. */
async function mintPlayer(name: string): Promise<{ principal: string; client: RadiaClient }> {
  const principal = `agent:mud-${name}`;
  const { definitionToken } = await admin.createAgentDefinition(
    principal,
    playerGrants(principal).map((g) => ({
      principal,
      kind: g.kind,
      operations: g.operations,
      ...(g.pattern ? { pattern: g.pattern } : {}),
    })),
  );
  return { principal, client: new RadiaClient(url, { definitionToken }) };
}

const alice = await mintPlayer("alice");
const bob = await mintPlayer("bob");

const say = (who: { principal: string; client: RadiaClient }, text: string) =>
  who.client.put({ kind: "command", body: { worldId: WORLD_ID, actor: who.principal, text } });

/** Everything in a room, oldest first. Read as the operator: a test is allowed to see more than a
 *  player, and every assertion below is about what a player COULD see. */
const feed = async (roomId: string): Promise<EventBody[]> =>
  (await admin.queryOldest<EventBody>({ kind: "event", match: { worldId: WORLD_ID, roomId } }, 200))
    .map((r) => r.body);

const where = async (actor: string): Promise<string | null> => {
  const rows = await admin.queryNewest<{ roomId: string }>({ kind: "presence", match: { worldId: WORLD_ID, actor } }, 1);
  return rows.length ? rows[0].body.roomId : null;
};

/** Poll until a predicate holds. Everything here is a chain of records written by three independent
 *  workers, so there is no single call to await. */
async function until(what: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await what()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// ---- 1. a first command places a newcomer ----
await say(alice, "look");
const placed = await until(async () => (await where(alice.principal)) === "gate");
check("a first command places a newcomer at the start room", placed, `presence=${await where(alice.principal)}`);
{
  const lines = await feed("gate");
  const look = lines.find((l) => l.audience === alice.principal && l.verb === "look");
  check("…and describes it to them alone", !!look && look.text.includes("The outer gate"));
  check("…while the room sees them arrive",
    lines.some((l) => l.audience === "room" && l.verb === "arrive" && l.actor === alice.principal));
}

// ---- 2. the NPC standing there answers, as itself ----
{
  const answered = await until(async () =>
    (await feed("gate")).some((l) => l.actor === npcAgent("gatekeeper") && l.text.includes("Name and business")));
  check("the gatekeeper reacts to the arrival", answered);
  const line = (await feed("gate")).find((l) => l.actor === npcAgent("gatekeeper"));
  check("…under its own principal, not the narrator's", line?.actor === npcAgent("gatekeeper"), line?.actor ?? "(none)");
}
await say(alice, "say is the gate ever shut?");
check("…and answers what a player says to it",
  await until(async () => (await feed("gate")).some((l) => l.text.includes("I only write down who goes through"))));

// ---- 3. moving writes both halves and moves presence ----
await say(alice, "north");
const moved = await until(async () => (await where(alice.principal)) === "courtyard");
check("going north moves presence", moved, `presence=${await where(alice.principal)}`);
check("…with the departure in the room left behind",
  (await feed("gate")).some((l) => l.verb === "leave" && l.actor === alice.principal));
check("…and the arrival in the room entered",
  (await feed("courtyard")).some((l) => l.verb === "arrive" && l.actor === alice.principal));

// ---- 4. the occupant list is a projection, not a query ----
//
// The trap this catches: `presence` is append-only, so alice's `gate` record still exists. A room
// view built from a plain query would still have her standing at the gate, an hour after she left.
{
  await say(bob, "look");
  await until(async () => (await where(bob.principal)) === "gate");
  const view = await livePresence(admin, WORLD_ID);
  const at = (room: string) =>
    [...view.entries].map((r) => r.body)
      .filter((p) => p.roomId === room).map((p) => p.actor).sort();
  check("somebody who left is not still standing there",
    !at("gate").includes(alice.principal) && at("courtyard").includes(alice.principal),
    `gate=[${at("gate").join(" ")}] courtyard=[${at("courtyard").join(" ")}]`);
  check("…and the raw query would have said otherwise (the trap)",
    (await admin.queryOldest<{ actor: string }>({ kind: "presence", match: { worldId: WORLD_ID, roomId: "gate" } }, 50))
      .some((r) => r.body.actor === alice.principal));
  check("…read to exhaustion, so the answer is a population", view.complete);
}

// ---- 5. a player cannot type as somebody else ----
{
  const refused = await say(alice, "look").then(() => "written").catch((e) => e);
  check("a player may write their own commands", refused === "written");
  const impersonation = await alice.client
    .put({ kind: "command", body: { worldId: WORLD_ID, actor: bob.principal, text: "jump in the well" } })
    .then(() => null)
    .catch((e) => e);
  check("a player cannot type as somebody else",
    impersonation instanceof RadiaClientError && impersonation.status === 403,
    impersonation instanceof RadiaClientError ? impersonation.code : "the write succeeded");
  const narrating = await alice.client
    .put({ kind: "event", body: { worldId: WORLD_ID, roomId: "gate", actor: alice.principal, actorName: "alice", verb: "say", text: "a voice from nowhere", audience: "room", causedBy: "x" } })
    .then(() => null)
    .catch((e) => e);
  check("…and cannot narrate at all",
    narrating instanceof RadiaClientError && narrating.status === 403,
    narrating instanceof RadiaClientError ? narrating.code : "the write succeeded");
}

// ---- 6. an NPC cannot speak in a room it is not in ----
//
// The grant, not a check anywhere in this example: `event: put` is pinned to `{roomId, actor}`, so
// `bodyMatchesGrant` refuses at the write.
{
  const gatekeeper = new RadiaClient(url, { definitionToken: npcTokens.gatekeeper });
  const line = (roomId: string, actor: string) => ({
    kind: "event",
    body: {
      worldId: WORLD_ID, roomId, actor, actorName: "the gatekeeper",
      verb: "say", text: "I am somewhere I should not be.", audience: "room", causedBy: "x",
    },
  });
  const own = await gatekeeper.put(line("gate", npcAgent("gatekeeper"))).then(() => "written").catch((e) => e);
  check("an NPC may speak where it stands", own === "written", own instanceof RadiaClientError ? own.code : "");
  const elsewhere = await gatekeeper.put(line("tavern", npcAgent("gatekeeper"))).then(() => null).catch((e) => e);
  check("an NPC cannot speak in another room",
    elsewhere instanceof RadiaClientError && elsewhere.status === 403,
    elsewhere instanceof RadiaClientError ? elsewhere.code : "the write succeeded");
  const asAlice = await gatekeeper.put(line("gate", alice.principal)).then(() => null).catch((e) => e);
  check("…and cannot put words in a player's mouth",
    asAlice instanceof RadiaClientError && asAlice.status === 403,
    asAlice instanceof RadiaClientError ? asAlice.code : "the write succeeded");
}

// ---- 7. an NPC acts on its own clock ----
//
// The whole point of `PutRequest.availableAt` (agent_docs/plan-milestones.md, "delayed
// visibility"): no process holds an interval, and a phase-6 workspace NPC could not hold one.
{
  const started = await seedAmbient(admin, 0);
  check("seeding starts one ambient chain per NPC", started.length === 2, started.join(" "));
  check("…and seeding again starts none, so a restart cannot leave an NPC with two clocks",
    (await seedAmbient(admin, 0)).length === 0);

  // A beat the world can see. Which tick that lands on is the chain's business, so this waits for
  // ANY ambient line rather than asserting on a particular one.
  const ambientLine = await until(async () =>
    (await feed("gate")).some((l) => l.actor === npcAgent("gatekeeper") && l.verb === "emote"), 15_000);
  check("the gatekeeper acts with nobody in the room", ambientLine);

  // The chain, read back: the cue that produced that line was consumed and its successor exists,
  // deferred. Atomic consume-and-emit is why there can never be one without the other.
  const cues = (await admin.queryOldest<{ tick: number }>({ kind: "npc_turn", match: { worldId: WORLD_ID, npc: "gatekeeper", trigger: "ambient" } }, 50))
    .map((r) => r.body);
  const ticks = cues.map((c) => c.tick).sort((a, b) => a - b);
  check("…and each beat acked the next one, so the chain carries itself", ticks.length >= 2, `ticks ${ticks.join(",")}`);
  check("…with no beat repeated, so one NPC ran one clock", new Set(ticks).size === ticks.length, `ticks ${ticks.join(",")}`);

  // FILTERED CLIENT-SIDE ON PURPOSE, and not for want of trying: `GET /v0/ops/records` takes
  // `state`, `expired`, `stale` and `limit`, and no kind (`handleEnvelopeQuery`). Passing `kind`
  // there is silently ignored, which is worse than being refused: the answer looks filtered.
  // Filtering on `record.kind` here is also why the `npc` DEFINITION records do not land in this
  // count, since those sit `available` forever and carry an `npc` field of their own.
  //
  // The 200 is a bounded read used as a population, which is normally the trap. It is safe here in
  // one direction only: a beat that fell off the page makes this FAIL, never pass.
  const pending = await admin.queryEnvelopes({ state: "available", limit: 200 });
  const waiting = pending.filter((p) =>
    p.record?.kind === "npc_turn" && (p.record.body as { npc?: string }).npc === "gatekeeper"
  );
  check("…and exactly one beat is waiting its turn", waiting.length === 1, `${waiting.length} pending`);
}

// ---- 8. an NPC cannot wind another NPC's clock ----
{
  const gatekeeper = new RadiaClient(url, { definitionToken: npcTokens.gatekeeper });
  const beat = (npc: string) => ({
    kind: "npc_turn",
    body: { worldId: WORLD_ID, npc, roomId: "gate", trigger: "ambient", tick: 99 },
    availableAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const own = await gatekeeper.put(beat("gatekeeper")).then(() => "written").catch((e) => e);
  check("an NPC may schedule itself", own === "written", own instanceof RadiaClientError ? own.code : "");
  const other = await gatekeeper.put(beat("barkeep")).then(() => null).catch((e) => e);
  check("an NPC cannot schedule another NPC",
    other instanceof RadiaClientError && other.status === 403,
    other instanceof RadiaClientError ? other.code : "the write succeeded");
}

// ---- 9. two NPCs in two rooms do not answer each other ----
//
// The cue rule: only a PLAYER-caused event produces an `npc_turn`. Without it two NPCs sharing a
// room would trade lines until somebody stopped one of them, so the guard is checked here rather
// than trusted.
{
  const cues = await admin.queryOldest<{ cause?: { actor?: string } }>({ kind: "npc_turn", match: { worldId: WORLD_ID } }, 200);
  const fromNpc = cues.filter((c) => (c.body.cause?.actor ?? "").startsWith("agent:mud-npc-"));
  check("no NPC was ever cued by another NPC's line", fromNpc.length === 0, `${cues.length} cues, ${fromNpc.length} from NPCs`);
}

stop.abort();
await new Promise((r) => setTimeout(r, 300));
try {
  space.kill();
} catch { /* already gone */ }
await space.status;

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}\n`);
Deno.exit(failures === 0 ? 0 : 1);
