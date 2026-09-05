// The go-fish dealer host, end to end and model-free: a space, `radia team up` running the
// `dealer` service member, the reference program (smoke/dealer.js) saved as the author would save
// it, and this process playing all four players. Asserts the shape of the game the prompts
// promise the players: private hands, public books, one reply per ask, a final count, and every
// record the program wrote stamped with the team by the host rather than by the code.
//
//   deno task test:teams

import { RadiaClient } from "../../../sdk/ts/client.ts";
import { writeWorkspace } from "../../../extensions/ts/workspace.ts";
import { resolveToken } from "../../../src/credentials.ts";

const PORT = 7893;
const url = `http://127.0.0.1:${PORT}`;
const TEAM = "go-fish";
const PLAYERS = ["ada", "ben", "cy", "dee"];
const RANKS = 4;
const here = new URL(".", import.meta.url).pathname;
const main = new URL("../../../src/main.ts", import.meta.url).pathname;

const fail = (m: string): never => {
  throw new Error(m);
};
const assert = (c: unknown, m: string) => {
  if (!c) fail(m);
};

const dir = await Deno.makeTempDir({ prefix: "radia-gofish-" });
const env = { RADIA_CREDENTIALS: `${dir}/credentials.json`, RADIA_DIR: `${dir}/radia`, RADIA_TOKEN: "", RADIA_DEFINITION_TOKEN: "" };
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", main, "dev", "--port", String(PORT), "--artifact-port", "0"],
  env,
  stdout: "null",
  stderr: "null",
}).spawn();
let team: Deno.ChildProcess | undefined;
const started = Date.now();
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
  const admin = new RadiaClient(url, { token: resolveToken(url)! });

  // The dealer alone: `--init` mints it with the file's grants and declares the team's kinds, then
  // its service is spawned, which declares the sandbox record and waits for the program.
  team = new Deno.Command(Deno.execPath(), {
    // The file's `done` (a final note) would stop the run after the FIRST game; the smoke plays two.
    args: ["run", "-A", main, "team", "up", here, "--init", "--member", "dealer", "--done", JSON.stringify({ kind: "note", match: { topic: "smoke-never" } }), "--url", url],
    // No author member runs here, so the repair hold has nothing to wait for: seconds, not minutes.
    env: { ...env, GO_FISH_REPAIR_WAIT: "3" },
    stdout: "null",
    stderr: "piped",
  }).spawn();
  const log: string[] = [];
  (async () => {
    for await (const chunk of team!.stderr.pipeThrough(new TextDecoderStream())) {
      for (const line of chunk.split("\n")) if (line.trim()) log.push(line);
    }
  })();
  const until = async (what: string, ok: () => Promise<boolean>, ms = 60_000) => {
    const t0 = Date.now();
    while (!(await ok())) {
      if (Date.now() - t0 > ms) fail(`timed out waiting for ${what}\n${log.slice(-15).join("\n")}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  // The kind itself is declared by the host, so a query before that is `unknown_kind`, not empty.
  await until("the dealer's sandbox record", () => admin.queryNewest({ kind: "sandbox", match: { name: "go-fish-dealer" } }, 1).then((r) => r.length > 0, () => false));

  // The program, saved the way the author member saves it: into the team's compartment.
  const ws = await writeWorkspace(admin, {
    name: "go-fish-dealer",
    owner: "agent:author",
    files: { "dealer.js": await Deno.readTextFile(`${here}smoke/dealer.js`) },
    entrypoint: "dealer.js",
    meta: { team: TEAM },
    scope: { team: TEAM },
  });
  console.error(`smoke: program ${ws.treeDigest.slice(0, 12)} saved`);
  await until("the host to pick the program up", () => Promise.resolve(log.some((l) => l.includes("claiming task{tags: dealer}"))));

  // TWO games back to back, because the second is where "the current table" goes wrong: the first
  // game's table versions outnumber the new game's, so "highest seq" reads the old game.
  for (let round = 1; round <= 2; round++) {
  const setup = await admin.put({ kind: "task", body: { team: TEAM, tags: ["dealer"], phase: "setup", players: PLAYERS, ranks: RANKS, title: "deal" } });
  const game = setup.id;

  // The four players, scripted: on a turn, ask the next player for the first rank in hand.
  const asks: string[] = [];
  const finalNote = async () => (await admin.queryNewest<{ books: Record<string, number>; winner: unknown; game: string }>({ kind: "note", match: { topic: "final", team: TEAM } }, 1)).filter((n) => n.body.game === game);
  const t0 = Date.now();
  let moves = 0;
  while ((await finalNote()).length === 0) {
    if (Date.now() - t0 > 180_000 || moves > 400) {
      const [t] = await admin.queryNewest<{ seq: number; state: unknown }>({ kind: "table", match: { game, team: TEAM } }, 1);
      const [last] = await admin.queryNewest<unknown>({ kind: "note", match: { topic: "reply", team: TEAM } }, 1);
      fail(`no final note after ${moves} moves; newest table ${JSON.stringify(t?.body).slice(0, 600)}; last reply ${JSON.stringify(last?.body)}\n${log.slice(-5).join("\n")}`);
    }
    let played = false;
    for (const p of PLAYERS) {
      const turn = await admin.take({ pattern: { kind: "task", match: { tags: { $any: p } } } }, { leaseSeconds: 30 });
      if (!turn) continue;
      played = true;
      const body = turn.record.body as { game: string; players: string[]; ranks: number };
      assert(body.game === game, `a turn task names the game (${JSON.stringify(body)})`);
      const [hand] = await admin.queryNewest<{ cards: string[]; to: string }>({ kind: "note", match: { to: p, topic: "hand", team: TEAM } }, 1);
      assert(hand, `${p} has a hand note before the first turn`);
      // Rotate target and rank per move: a fixed choice cycles forever once the pile is empty.
      const cards = hand.body.cards;
      const others = PLAYERS.filter((q) => q !== p);
      const target = others[moves % others.length];
      const rank = cards.length ? cards[moves % cards.length].slice(0, -1) : "1";
      const ask = await admin.put({
        kind: "task",
        body: { team: TEAM, tags: ["dealer"], phase: "move", game, player: p, target, rank, players: body.players, ranks: body.ranks, title: `${p} asks ${target} for ${rank}` },
        parentIds: [turn.record.id],
      });
      asks.push(ask.id);
      await admin.ack(turn.lease, { kind: "note", body: { team: TEAM, to: "all", topic: "move", game, text: `${p} asked ${target} for ${rank}` } });
      moves++;
    }
    if (!played) await new Promise((r) => setTimeout(r, 150));
  }
  const [fin] = await finalNote();
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`smoke: game over after ${moves} moves in ${seconds}s: ${JSON.stringify(fin.body.books)}, winner ${JSON.stringify(fin.body.winner)}`);
  assert(fin.body.game === game, "the final note names the game");
  const down = Object.values(fin.body.books).reduce((n, b) => n + b, 0);
  assert(down === RANKS, `every rank ends as a book (${down} of ${RANKS})`);
  assert((fin.body as Record<string, unknown>).team === TEAM, "the result the program RETURNED is stamped with the team by the host");

  // Every ask was answered on itself, and every hand went to one player.
  for (const id of asks) {
    const kids = await admin.getChildren(id);
    assert(kids.some((r) => r.kind === "note" && ["reply", "final"].includes((r.body as { topic?: string }).topic ?? "")), `ask ${id} got a reply (or the final count) as its child`);
  }
  const hands = await admin.queryAll<{ to: string; team?: string }>({ kind: "note", match: { topic: "hand", team: TEAM } });
  assert(hands.length >= PLAYERS.length, "one hand note per player at least");
  for (const h of hands) {
    assert(PLAYERS.includes(h.body.to), `a hand note is addressed to one player, never ${JSON.stringify(h.body.to)}`);
    assert(h.body.team === TEAM, "a brokered put is stamped with the team by the host");
  }
  const tables = await admin.queryAll<{ seq: number }>({ kind: "table", match: { game, team: TEAM } });
  assert(tables.length === moves + 1, `one table version per move plus the deal (${tables.length} for ${moves} moves)`);
  }

  // A MALFORMED ask still moves the game on. A player holding nothing once invented a field of its
  // own, was answered `unknown-target`, and the game died with no turn task anywhere. On a fresh
  // deal, because a finished game is the one place where handing no turn on is right.
  const dealt = await admin.put({ kind: "task", body: { team: TEAM, tags: ["dealer"], phase: "setup", players: PLAYERS, ranks: RANKS, title: "deal for the malformed-ask check" } });
  await until("a fresh deal", async () => (await admin.queryNewest<{ state: { game: string } }>({ kind: "table", match: { team: TEAM } }, 1))[0]?.body.state.game === dealt.id, 30_000);
  const [live] = await admin.queryNewest<{ state: { turn: string; players: string[] } }>({ kind: "table", match: { team: TEAM } }, 1);
  const onTurn = live.body.state.turn;
  await admin.put({ kind: "task", body: { team: TEAM, tags: ["dealer"], phase: "move", player: onTurn, action: "draw", title: "a shape the program does not know" } });
  await until("the turn to move on after a malformed ask", async () => {
    const open = await admin.queryEnvelopes({ state: "available", kind: "task", limit: 50 });
    return open.some((r) => {
      const b = r.record?.body as { tags?: string[]; phase?: string } | undefined;
      return b?.phase === "turn" && b.tags?.[0] !== onTurn;
    });
  }, 30_000);

  // A program that REFUSES forever never throws, so the failure path never runs. The host counts
  // identical asks answered `ok: false` and hands the author a fix at the third, which is what
  // turns a paid retry loop (four launches in a minute, in a real run) into one repair task.
  await writeWorkspace(admin, {
    name: "go-fish-dealer",
    owner: "agent:author",
    files: { "dealer.js": `export default async function () { return { kind: "note", body: { to: "ada", topic: "reply", ok: false, event: "always-no" } }; }` },
    entrypoint: "dealer.js",
    meta: { team: TEAM },
    scope: { team: TEAM },
  });
  const fixes = () => admin.queryNewest<{ phase: string; digest: string }>({ kind: "task", match: { team: TEAM, tags: { $any: "author" } } }, 5);
  const before = (await fixes()).length;
  for (let i = 0; i < 4 && (await fixes()).length === before; i++) {
    await admin.put({ kind: "task", body: { team: TEAM, tags: ["dealer"], phase: "move", player: "ada", target: "ben", rank: "1", title: "the same ask again" } });
    await until("the dealer to answer", async () => (await admin.queryEnvelopes({ state: "available", kind: "task", limit: 50 })).every((r) => (r.record?.body as { tags?: string[] })?.tags?.[0] !== "dealer"), 30_000);
  }
  const after = await fixes();
  assert(after.length === before + 1, `the loop is reported once, not per move (${after.length - before} fix tasks)`);
  assert(after[0].body.phase === "fix", `and it is a fix task (${after[0].body.phase})`);
  // And the move that raised it HELD its claim rather than answering, which is what stops the
  // player being launched again while the author works. Here nothing repairs it, so it gives up.
  await until("the held move to give up on the repair", () => Promise.resolve(log.some((l) => l.includes("no new program within"))), 30_000);

  const perms = await admin.permissions("agent:ada");
  assert(!perms.kinds.some((k) => k.kind === "table"), "a player holds no grant on the table");
  console.error(`smoke: ok (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} finally {
  try {
    team?.kill("SIGTERM");
    await team?.status;
  } catch { /* already gone */ }
  try {
    space.kill();
    await space.status;
  } catch { /* already gone */ }
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}
