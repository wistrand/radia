// The TEAM wiring, with no model in it:
//
//   deno task test:song-team
//
// `smoke.ts` proves the pipeline. This proves the thing a pipeline test cannot: that `team.json`
// describes a team that actually runs. It reads that file rather than restating it, declares its
// kinds the way `radia team up --init` does, mints every member with the grants the file lists, and
// starts the two services on their own command lines. Only the five model turns are scripted.
//
// WHAT IT IS REALLY GUARDING is the team label. A member's grants are patterned on `team`, so a
// record written without it is refused, and a kind that does not index it can hold no grant that
// compiles at all. That failure lands at the first claim, minutes into a paid run, and it looked
// exactly like a member with nothing to do.

import { RadiaClient } from "../../../sdk/ts/client.ts";
import { resolveToken } from "../../../src/credentials.ts";
import { addMember, declareKind, declareTeamKinds, liveKinds, TEAM_FIELD } from "../../../extensions/ts/team.ts";
import { readWorkspace } from "../../../extensions/ts/workspace.ts";
import type { KindDef } from "../../../sdk/ts/client.ts";
import { analyse, faults } from "./analysis.ts";
import { parseScore, type Score } from "./score.ts";
import { BRIEF, DRAFT, NOTE, PART, PHRASE, REVIEW, SONG_REQUEST, VERDICT } from "./kinds.ts";

const PORT = 7901;
const url = `http://127.0.0.1:${PORT}`;
const dir = new URL(".", import.meta.url).pathname;
const repo = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
let failures = 0;
const check = (what: string, ok: boolean, detail: unknown = "") => {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${what}${detail === "" ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};
const verbose = Deno.args.includes("--verbose");
const trace = (m: string) => {
  if (verbose) console.error(m);
};

interface TeamFile {
  team: string;
  kinds: KindDef[];
  members: { name: string; service?: boolean; command?: string[]; grants?: string[]; patterns?: { kind: string; match?: Record<string, unknown> }[] }[];
  seed: { kind: string; body: Record<string, unknown> }[];
}
const file: TeamFile = JSON.parse(await Deno.readTextFile(`${dir}team.json`));
const label = file.team;
const memberOf = (name: string) => file.members.find((m) => m.name === name)!;
/** The team label the MCP adapter fills in for a harness member, written by hand where a scripted
 *  stand-in holds a plain SDK client. */
const stamped = (body: Record<string, unknown>) => ({ ...body, [TEAM_FIELD]: label });
/** WHICH PLAYER PLAYS WHICH INSTRUMENT, read from the file's own claim patterns.
 *
 *  A player has a NAME and an instrument it is expert in, and the instrument is a standing property
 *  of the player, not something a record hands it. The claim pattern is where that expertise is
 *  declared, so nothing stops two players declaring the same one: they compete for the part and the
 *  lease decides. `understudy` below is exactly that, and it is why the names are not instruments. */
const players = file.members
  .flatMap((m) => (m.patterns ?? []).filter((p) => p.kind === PART).map((p) => [m.name, String(p.match?.instrument)] as const));
const UNDERSTUDY = "understudy";

// Round one is written to collide the way three independently written parts do; round two is what
// the reviewers' asks should lead to. Same fixture as `smoke.ts`, for the same reason: the run has
// to move a measured fault count, or "the agents reviewed it" is decoration.
const ROUND1: Record<string, string> = {
  lead: "C4/4 D4/4 E4/4 F4/4 | G4/4 A4/4 B4/4 C5/4",
  harmony: "G4/4 A4/4 B4/4 C5/4 | D5/4 E5/4 F#5/4 G5/4",
  bass: "C3/4 C#3/4 D3/4 D#3/4 | E3/4 F3/4 F#3/4 G3/4",
};
// Round two here is DELIBERATELY not perfect: it is written to the chords with a real rhythm, and
// leaves one parallel octave in bar two (harmony and bass both falling E to C). That is what makes
// this smoke cover the settlement path `smoke.ts` cannot: the counter withholds approval over a
// small fault, the ear approves, and the ear carries it.
const ROUND2: Record<string, string> = {
  lead: "D4/4. E4/8 D4/4 B3/4 | C4/2. r/4",
  harmony: "B3/2 D4/4 G4/4 | E4/2 C4/2",
  bass: "G2/2 B2/4 D3/4 | E3/2 C3/2",
};
const CHORDS = ["G", "C"];

const work = await Deno.makeTempDir({ prefix: "radia-song-team-" });
const env = { RADIA_CREDENTIALS: `${work}/credentials.json`, RADIA_DIR: `${work}/radia`, RADIA_TOKEN: "", RADIA_DEFINITION_TOKEN: "" };
// The ARTIFACT ORIGIN is on here, unlike the pipeline smoke: a share URL is served from it, and a
// space with it disabled hands back a path with no host, which is not a link anybody can open.
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", String(PORT + 1)],
  env,
  stdout: "null",
  stderr: "null",
}).spawn();
const stop = new AbortController();
const services: Deno.ChildProcess[] = [];

try {
  const probe = new RadiaClient(url);
  for (let i = 0; i < 600; i++) {
    try {
      await probe.health();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  Deno.env.set("RADIA_CREDENTIALS", env.RADIA_CREDENTIALS);
  const admin = new RadiaClient(url, { token: resolveToken(url)! });

  console.log(`song-creator: the team wiring, with no model in it (${label})\n`);

  // ---- setup, exactly as `radia team up --init` does it ----
  await declareTeamKinds(admin);
  const live = await liveKinds(admin);
  for (const k of file.kinds) await declareKind(admin, k, live);
  // `note` is a TEAM kind already, declared with team/topic/to/ok. The file adds `song`, and a merge
  // only ever ADDS paths. Asserted by matching rather than by reading the declaration back: what
  // matters is that both vocabularies still COMPILE, and an undeclared path is refused outright.
  await admin.put({ kind: NOTE, body: stamped({ topic: "probe", song: "probe-song", to: "all", message: "x" }) });
  const bySong = await admin.queryNewest({ kind: NOTE, match: { song: "probe-song" } }, 1).then((r) => r.length, (e: Error) => e.message);
  const byTo = await admin.queryNewest({ kind: NOTE, match: { to: "all" } }, 1).then((r) => r.length, (e: Error) => e.message);
  check("this app's `song` path merged into the team's own `note`", bySong === 1, bySong);
  check("and the team's own `to` still compiles beside it", byTo === 1, byTo);

  const parseGrant = (g: string) => {
    const [kind, ops] = g.split(":");
    return { kind, operations: ops.split(",").map((o) => o.trim()).filter(Boolean) };
  };
  const tokens = new Map<string, string>();
  for (const m of file.members) {
    const member = await addMember(admin, `agent:${m.name}`, { teams: [label], extra: (m.grants ?? []).map(parseGrant) });
    tokens.set(m.name, member.definitionToken);
  }
  check("every member in the file mints with the grants it names", tokens.size === file.members.length, [...tokens.keys()]);

  // A SECOND PLAYER ON AN INSTRUMENT SOMEBODY ALREADY PLAYS, minted here rather than in the file so
  // a live run does not pay for a fourth harness. It holds the same grants and listens on the same
  // pattern as the player it doubles, which is all "two players, one instrument" takes.
  const doubled = players[0][1];
  const understudy = await addMember(admin, `agent:${UNDERSTUDY}`, {
    teams: [label],
    extra: (memberOf(players[0][0]).grants ?? []).map(parseGrant),
  });
  tokens.set(UNDERSTUDY, understudy.definitionToken);

  // Enforcement, not what setup assigned: the producer's own permissions, read back from the space.
  const perms = await admin.permissions("agent:producer");
  const draftGrant = perms.kinds.find((k) => k.kind === DRAFT);
  check("a member's grant is PATTERNED on the team, which is the isolation", Boolean(draftGrant?.patterns?.some((p) => (p as Record<string, unknown>)[TEAM_FIELD] === label)), draftGrant?.patterns);

  // ---- the two services, on the command lines the file gives them ----
  const startService = (name: string) => {
    const m = memberOf(name);
    const argv = (m.command ?? []).map((s) => s.replace("{{repo}}", repo).replace("{{url}}", url));
    const p = new Deno.Command(argv[0], {
      args: argv.slice(1),
      env: { ...env, RADIA_DEFINITION_TOKEN: tokens.get(name)! },
      stdout: "null",
      stderr: verbose ? "inherit" : "null",
    }).spawn();
    services.push(p);
  };
  startService("producer");
  startService("checker");

  // ---- the five model turns, scripted. Each writes the team label the MCP adapter would fill in ----
  const clientFor = (name: string) => new RadiaClient(url, { definitionToken: tokens.get(name)! });
  const claimLoop = (name: string, pattern: Record<string, unknown>, handle: (body: Record<string, unknown>, client: RadiaClient) => Promise<{ kind: string; body: Record<string, unknown> }>) =>
    (async () => {
      const client = clientFor(name);
      while (!stop.signal.aborted) {
        const claim = await client.take({ pattern: pattern as never }, { leaseSeconds: 30 }).catch((e: Error) => {
          trace(`[${name}] take failed: ${e.message}`);
          return null;
        });
        if (!claim) {
          await new Promise((r) => setTimeout(r, 80));
          continue;
        }
        const result = await handle(claim.record.body as Record<string, unknown>, client);
        await client.ack(claim.lease, { kind: result.kind, body: stamped(result.body) });
      }
    })().catch((e) => trace(`[${name}] died: ${e.message}`));

  const song = { id: "" };
  claimLoop("arranger", { kind: SONG_REQUEST }, async (body, client) => {
    // The arranger's own record id is the song id, which is what the prompt tells the model too.
    const rows = await client.queryNewest<Record<string, unknown>>({ kind: SONG_REQUEST, match: { [TEAM_FIELD]: label } }, 1);
    song.id = rows[0].id;
    for (const instrument of ["lead", "harmony", "bass"]) {
      await client.put({ kind: PART, body: stamped({ song: song.id, instrument, round: 1, guidance: "first pass" }), parentIds: [rows[0].id] });
    }
    return {
      kind: BRIEF,
      body: {
        song: song.id,
        title: "Three Parts, One Round",
        description: String(body.description ?? ""),
        key: "C major",
        bpm: 112,
        meter: { beats: 4, unit: 4 },
        chords: CHORDS,
        bars: 2,
        parts: ["lead", "harmony", "bass"],
        maxRounds: 2,
      },
    };
  });

  // Each player answers for the instrument it plays, which is fixed per player. The understudy plays
  // the same one as the first player and listens on the same pattern; only one of them can win any
  // given part, because a claim is a lease.
  const took = new Map<string, string>();
  const play = (name: string, instrument: string) =>
    claimLoop(name, { kind: PART, match: { instrument } }, (body) => {
      const round = Number(body.round);
      took.set(`${instrument}:${round}`, name);
      return Promise.resolve({
        kind: PHRASE,
        body: { song: body.song, instrument, round, phrase: (round === 1 ? ROUND1 : ROUND2)[instrument] },
      });
    });
  for (const [name, instrument] of players) play(name, instrument);
  play(UNDERSTUDY, doubled);

  claimLoop("critic", { kind: REVIEW, match: { by: "ear" } }, (body) => {
    const round = Number(body.round);
    const approve = round > 1;
    return Promise.resolve({
      kind: VERDICT,
      body: {
        song: body.song,
        round,
        by: "ear",
        approve,
        summary: approve ? "it sings now" : "the middle wanders and never comes home",
        asks: approve ? [] : [{ instrument: "lead", note: "end on the tonic" }],
      },
    });
  });

  // ---- seed, the way `--seed` does: the team label on the record ----
  for (const s of file.seed) await admin.put({ kind: s.kind, body: stamped(s.body) });

  const finalOf = async () => (await admin.queryNewest<Record<string, unknown>>({ kind: NOTE, match: { [TEAM_FIELD]: label, topic: "final" } }, 1))[0];
  const t0 = Date.now();
  while (!await finalOf()) {
    if (Date.now() - t0 > 60_000) throw new Error("the team never reached a final note");
    await new Promise((r) => setTimeout(r, 200));
  }
  const final = await finalOf();
  console.log();

  // ---- what the run proves ----
  check("the team reached its `done` record", Boolean(final), `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const drafts = await admin.queryAll<{ round: number; score: Score }>({ kind: DRAFT, match: { [TEAM_FIELD]: label } });
  check("two rounds happened under the team label", drafts.length === 2, drafts.map((d) => d.body.round));
  const faultsOf = (round: number) => {
    const s = drafts.find((d) => d.body.round === round)!.body.score;
    return faults(analyse(parseScore(s).parts, s, "C major"));
  };
  check("the review improved the piece, measurably", faultsOf(2) < faultsOf(1), `${faultsOf(1)} faults -> ${faultsOf(2)}`);
  // THE EAR CARRIES A PIECE THE COUNTER WOULD HOLD. Requiring both reviewers made the count a veto,
  // so a live run ended on the round limit with the critic's approval ignored.
  check("the ear settles a piece the counter still has a note about", String(final.body.settledBy).startsWith("the ear approved"), final.body.settledBy);
  const verdicts = await admin.queryAll<{ by: string; round: number; approve: boolean; faults?: number }>({ kind: VERDICT, match: { [TEAM_FIELD]: label } });
  const ruled = verdicts.find((v) => v.body.by === "rules" && v.body.round === 2);
  check("and the counter's own verdict is recorded as unapproved, honestly", ruled?.body.approve === false, `faults ${ruled?.body.faults}`);

  // Everything a service wrote carries the label, or no member could have read it.
  for (const kind of [DRAFT, REVIEW, PART, VERDICT, NOTE]) {
    const rows = await admin.queryAll<Record<string, unknown>>({ kind });
    check(`every ${kind} a service wrote carries the team`, rows.length > 0 && rows.every((r) => r.body[TEAM_FIELD] === label), `${rows.length} records`);
  }

  // A SERVICE RETIRES ITS OWN RUN when it stops, so its interests stop showing as live. Without it a
  // service that exited cleanly still looked like a listener for as long as its run lasted, and the
  // next start warned that another `team up` might be running on the evidence of two dead processes.
  // Asserted through the real services, which this smoke starts and stops.
  const listening = async () => {
    const seen = new Set<string>();
    for (const kind of [REVIEW, PHRASE, VERDICT]) {
      for (const i of (await admin.dryRun(kind)).interests) if (i.agent === "agent:producer" || i.agent === "agent:checker") seen.add(i.agent);
    }
    return seen;
  };
  check("both services show as listening while they run", (await listening()).size === 2, [...await listening()]);
  for (const p of services) {
    try {
      p.kill("SIGTERM");
      await p.status;
    } catch { /* already gone */ }
  }
  services.length = 0;
  check("and neither does once they stop, because each retires its run", (await listening()).size === 0, [...await listening()]);

  // THE FOURTH PLAYER IS OPTIONAL, and the ARRANGER decides by what it puts in `brief.parts`. This
  // smoke's arranger asks for three, so the drummer is a member of the team that was never asked:
  // it holds a definition and a claim pattern, and costs nothing, because a harness is launched
  // only when a record is claimed for it.
  const drummer = file.members.find((m) => (m.patterns ?? []).some((p) => p.match?.instrument === "drums"));
  check("the team ships a drummer", Boolean(drummer), drummer?.name);
  check("who is minted like any other member", tokens.has(drummer?.name ?? ""), drummer?.name);
  const drumParts = await admin.queryAll<Record<string, unknown>>({ kind: PART, match: { [TEAM_FIELD]: label, instrument: "drums" } });
  check("and is asked for nothing when the brief leaves drums out", drumParts.length === 0, `${drumParts.length} drum parts`);

  // TWO PLAYERS, ONE INSTRUMENT. Both listened on every `lead` part; the lease means exactly one
  // answered each, and the piece has one lead line rather than two.
  const phrases = await admin.queryAll<{ instrument: string; round: number }>({ kind: PHRASE, match: { [TEAM_FIELD]: label } });
  const perPartRound = new Map<string, number>();
  for (const p of phrases) perPartRound.set(`${p.body.instrument}:${p.body.round}`, (perPartRound.get(`${p.body.instrument}:${p.body.round}`) ?? 0) + 1);
  check("two players on one instrument still yield ONE part each round", [...perPartRound.values()].every((n) => n === 1), [...perPartRound.entries()].map(([k, n]) => `${k}=${n}`));
  const claimants = new Set([...took.entries()].filter(([k]) => k.startsWith(`${doubled}:`)).map(([, who]) => who));
  check(`the ${doubled} parts were claimed by a player, and only one per round`, claimants.size >= 1, [...claimants]);

  // ONE final note, whichever verdict lands last. Both reviewers' verdicts are claimed by the same
  // producer loop, so two of them can see a complete round at once, exactly as the three phrases can.
  const finals = await admin.queryAll<Record<string, unknown>>({ kind: NOTE, match: { [TEAM_FIELD]: label, topic: "final" } });
  check("the song is finished ONCE, not once per reviewer", finals.length === 1, `${finals.length} final notes`);

  // The workspace and its artifacts are labelled too, which is the failure `scope` exists to stop.
  const ws = await readWorkspace(admin, String(final.body.workspace), undefined, { [TEAM_FIELD]: label });
  check("the song's workspace is readable IN THE TEAM's compartment", Boolean(ws), final.body.workspace);
  const files = (ws?.files ?? []).map((f) => f.path).sort();
  check("with a page, the song, and the rejected round beside it", files.join(",") === "index.html,round-1.wav,song.wav", files);
  const art = await admin.queryAll<Record<string, unknown>>({ kind: "artifact", match: { [TEAM_FIELD]: label } });
  check("and every artifact under it is labelled, not just the manifest", art.length >= 2, `${art.length} artifacts`);

  // ---- the link a person opens ----
  // The producer mints it, so the note carries a URL that needs no credential. Fetched here without
  // one, because a share link that only works for the minter is not a share link.
  const shareUrl = String(final.body.url ?? "");
  check("the final note carries a URL, and says when it dies", shareUrl.startsWith("http") && Boolean(final.body.urlExpiresAt), final.body.urlExpiresAt);
  const pageRes = await fetch(shareUrl);
  const served = await pageRes.text();
  check("a bare directory serves the page, with no credential", pageRes.ok && served.includes('src="song.wav"'), pageRes.status);
  const wavRes = await fetch(`${shareUrl}song.wav`);
  // The TYPE, not just the bytes. Every artifact response carries `nosniff`, so a wav served as
  // `text/plain` is one no browser will play, and the page fails silently with a dead player.
  const wavType = wavRes.headers.get("content-type");
  const bytes = new Uint8Array(await wavRes.arrayBuffer());
  check("and the audio beside it plays from the same link", wavRes.ok && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF", `${(bytes.length / 1024).toFixed(0)} KiB`);
  check("served as audio, which is what lets a browser play it at all", wavType === "audio/wav", wavType);
  // A path the capability does not index. `../secret` is NOT the test to write: fetch normalises it
  // away before the request leaves, so that asserts nothing about the server.
  const missing = await fetch(`${shareUrl}secret.txt`);
  await missing.body?.cancel();
  check("and a path the tree does not list serves nothing", !missing.ok, missing.status);
  const escaped = await fetch(`${shareUrl}%2e%2e%2fsecret`);
  await escaped.body?.cancel();
  check("nor does an encoded traversal that survives the client", !escaped.ok, escaped.status);

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
} finally {
  stop.abort();
  for (const p of services) {
    try {
      p.kill("SIGTERM");
      await p.status;
    } catch { /* already gone */ }
  }
  try {
    space.kill();
    await space.status;
  } catch { /* already gone */ }
  await Deno.remove(work, { recursive: true }).catch(() => {});
}
if (failures > 0) Deno.exit(1);
