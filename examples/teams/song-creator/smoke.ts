// The song pipeline end to end with NO model in it: a space, the producer, the rules checker, and
// scripted stand-ins for the arranger, the three players and the model critic.
//
//   deno task test:song
//
// What it proves is the deterministic spine: the fan-in notices when three parallel players have
// all answered, two blind reviewers claim their own review and neither can sign the other's name,
// a round of revision happens, and the approved draft renders to audio a browser can play.
//
// The assertion that matters is that the REVIEW IMPROVED THE PIECE, measured. Round one is written
// to contain exactly the faults parallel authoring creates, and the revision has to reduce the
// fault count. Without a number that has to move, "the agents reviewed it" is decoration and would
// quietly stop working.

import { RadiaClient } from "../../../sdk/ts/client.ts";
import { resolveToken } from "../../../src/credentials.ts";
import { readWorkspace, WORKSPACE_KIND } from "../../../extensions/ts/workspace.ts";
import { analyse, faults } from "./analysis.ts";
import { parseScore, type Score } from "./score.ts";
import { drumVoiceFor, render, voiceFor } from "./synth.ts";
import { judge } from "./checker.ts";
import { type Brief, runProducer } from "./producer.ts";
import { historyPage } from "./history.ts";
import { BRIEF, DRAFT, grantsFor, NOTE, PART, PHRASE, REVIEW, SONG_KINDS, VERDICT } from "./kinds.ts";

const PORT = 7899;
const url = `http://127.0.0.1:${PORT}`;
let failures = 0;
const check = (what: string, ok: boolean, detail: unknown = "") => {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${what}${detail === "" ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};
/** `--verbose` (or SONG_DEBUG) turns on every member's log. Off by default so the run reads as a
 *  list of checks rather than a trace. */
const verbose = Deno.args.includes("--verbose") || Deno.env.get("SONG_DEBUG") === "1";
const trace = (m: string) => {
  if (verbose) console.error(m);
};
const until = async (what: string, ok: () => Promise<boolean>, ms = 20_000) => {
  const t0 = Date.now();
  while (!(await ok())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

/** Round one: three parts written independently, each defensible alone and wrong together. This is
 *  what parallel authoring actually produces, so it is what the reviewers must catch. */
const ROUND1: Record<string, string> = {
  lead: "C4/4 D4/4 E4/4 F4/4 | G4/4 A4/4 B4/4 C5/4",
  harmony: "G4/4 A4/4 B4/4 C5/4 | D5/4 E5/4 F#5/4 G5/4", // parallel fifths with the lead, and out of key
  bass: "C3/4 C#3/4 D3/4 D#3/4 | E3/4 F3/4 F#3/4 G3/4", // chromatic: clashes and out of key
};
/** Round two: what a reviewer's asks should lead to. Written to the chords below, with more than one
 *  note length in every part, because the count now treats a part that is all quarter notes as a
 *  fault. An earlier version of this fixture was all quarter notes and scored 8 rather than 0. */
const ROUND2: Record<string, string> = {
  lead: "D4/4. E4/8 D4/4 B3/4 | C4/2. r/4",
  // Bar two rises while the bass falls. Written the obvious way (E4 then C4, over the bass's E3 then
  // C3) it is a parallel octave, which is the fault this whole review stage exists to catch.
  harmony: "B3/2 D4/4 G4/4 | G3/2 E4/2",
  bass: "G2/2 B2/4 D3/4 | E3/2 C3/2",
};
/** One chord per bar, which is what the parts are written against and the reviewers judge them by. */
const CHORDS = ["G", "C"];

/** Claim one record or wait. A poll rather than a watch because the scripted members exist to feed
 *  the real ones, and `--verbose` has to show WHY a take failed: a swallowed grant error here reads
 *  as a stalled pipeline, which is the one failure this smoke must never misreport. */
const claimOne = async (who: string, client: RadiaClient, pattern: Record<string, unknown>) => {
  try {
    const claim = await client.take({ pattern: pattern as never }, { leaseSeconds: 30 });
    if (!claim) await new Promise((r) => setTimeout(r, 80));
    return claim;
  } catch (e) {
    trace(`[${who}] take failed: ${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, 200));
    return null;
  }
};

const dir = await Deno.makeTempDir({ prefix: "radia-song-" });
const env = { RADIA_CREDENTIALS: `${dir}/credentials.json`, RADIA_DIR: `${dir}/radia`, RADIA_TOKEN: "", RADIA_DEFINITION_TOKEN: "" };
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
  env,
  stdout: "null",
  stderr: "null",
}).spawn();
const stop = new AbortController();

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
  const operator = new RadiaClient(url, { token: resolveToken(url)! });
  // `note` is in SONG_KINDS now, since the vocabulary is read from `team.json`. Registering a second
  // `note` here would DROP its `team` path, and a redeclaration that loses a path is refused.
  for (const k of SONG_KINDS) await operator.registerKind(k);
  // The workspace convention's own kind, taken from the extension rather than restated here so a
  // space and the convention cannot disagree about which paths are indexed.
  await operator.registerKind(WORKSPACE_KIND);

  const mint = async (name: string, role: Parameters<typeof grantsFor>[0], instrument?: string) => {
    const agent = `agent:${name}`;
    const d = await operator.createAgentDefinition(agent, grantsFor(role, agent, instrument) as { principal: string; kind: string; operations: string[] }[]);
    return { agent, client: new RadiaClient(url, { definitionToken: d.definitionToken }) };
  };
  const producer = await mint("producer", "producer");
  const checker = await mint("checker", "checker");
  const critic = await mint("critic", "critic");
  const players = Object.fromEntries(
    await Promise.all(["lead", "harmony", "bass"].map(async (i) => [i, await mint(`player-${i}`, "player", i)] as const)),
  ) as Record<string, { agent: string; client: RadiaClient }>;

  console.log("song-creator: the spine, with no model in it\n");

  // A reviewer cannot sign the other's name. The grant pattern on `by` refuses the body itself.
  const forged = await critic.client.put({ kind: VERDICT, body: { song: "x", round: 1, by: "rules", approve: true } })
    .then(() => null, (e: Error) => e.message);
  check("the model critic cannot write a RULES verdict", forged !== null && /pattern scope|forbidden/i.test(forged), forged?.slice(0, 60));

  // ---- the arranger's job, scripted ----
  const song = (await operator.put({ kind: "song_request", body: { description: "a bright folk round in three parts" } })).id;
  const brief: Brief = {
    song,
    title: "Three Parts, One Round",
    description: "a bright folk round in three parts",
    key: "C major",
    bpm: 112,
    meter: { beats: 4, unit: 4 },
    chords: CHORDS,
    parts: ["lead", "harmony", "bass"],
    maxRounds: 2,
  };
  await operator.put({ kind: BRIEF, body: brief as unknown as Record<string, unknown> });

  runProducer(producer.client, { rounds: 2, signal: stop.signal, log: trace }).catch((e) => trace(`[producer] died: ${e.message}`));

  // ---- the rules checker, for real ----
  // The pipeline's own reviewers and players, stopped before the broken-song cases below: a claim is
  // by KIND, so a critic left running answers every song on the space, not only this one.
  const pipeline = new AbortController();
  stop.signal.addEventListener("abort", () => pipeline.abort(), { once: true });
  const checkerLoop = (async () => {
    while (!pipeline.signal.aborted) {
      const claim = await claimOne("checker", checker.client, { kind: REVIEW, match: { by: "rules" } });
      if (!claim) continue;
      const b = claim.record.body as { song: string; round: number };
      const draft = await checker.client.readOne<{ score: Score; key: string }>({ kind: DRAFT, match: { song: b.song, round: b.round } });
      const v = judge(draft!.body.score, draft!.body.key);
      trace(`[checker] r${b.round}: ${v.summary}`);
      await checker.client.ack(claim.lease, { kind: VERDICT, body: { song: b.song, round: b.round, by: "rules", ...v } });
    }
  })().catch((e) => trace(`[checker] died: ${e.message}`));

  // ---- the model critic, scripted: approves round two, asks for warmth in round one ----
  const criticLoop = (async () => {
    while (!pipeline.signal.aborted) {
      const claim = await claimOne("critic", critic.client, { kind: REVIEW, match: { by: "ear" } });
      if (!claim) continue;
      const b = claim.record.body as { song: string; round: number };
      const approve = b.round > 1;
      trace(`[critic] r${b.round}: ${approve ? "approve" : "asks for a resolution"}`);
      await critic.client.ack(claim.lease, {
        kind: VERDICT,
        body: {
          song: b.song,
          round: b.round,
          by: "ear",
          approve,
          summary: approve ? "it sings now" : "the middle wanders and never comes home",
          asks: approve ? [] : [{ instrument: "lead", note: "end on the tonic" }],
        },
      });
    }
  })().catch((e) => trace(`[critic] died: ${e.message}`));

  // ---- the three players, scripted, answering in parallel ----
  const playerLoops = Object.entries(players).map(([instrument, p]) =>
    (async () => {
      while (!pipeline.signal.aborted) {
        const claim = await claimOne(instrument, p.client, { kind: PART, match: { instrument } });
        if (!claim) continue;
        const b = claim.record.body as { song: string; round: number };
        const phrase = (b.round === 1 ? ROUND1 : ROUND2)[instrument];
        trace(`[${instrument}] r${b.round}: ${phrase}`);
        await p.client.ack(claim.lease, { kind: PHRASE, body: { song: b.song, instrument, round: b.round, phrase } });
      }
    })().catch((e) => trace(`[${instrument}] died: ${e.message}`))
  );

  // Kick round one off, the way the arranger would.
  for (const instrument of brief.parts) {
    await operator.put({ kind: PART, body: { song, instrument, round: 1, guidance: "first pass" } });
  }

  const finalOf = async () => (await operator.queryNewest<Record<string, unknown>>({ kind: NOTE, match: { song, topic: "final" } }, 1))[0];
  await until("the song to finish", async () => Boolean(await finalOf()), 30_000);
  const final = await finalOf();
  console.log();

  // ---- what the run proves ----
  const drafts = await operator.queryAll<{ round: number; score: Score }>({ kind: DRAFT, match: { song } });
  check("two rounds happened", drafts.length === 2, drafts.map((d) => d.body.round));
  // The fan-in claim: three players finish in parallel and every one of them asks whether the round
  // is done, so more than one can see a full set. One draft per round is what says the idempotency
  // key held rather than that the race never happened.
  check("one draft per round, whoever finished last", new Set(drafts.map((d) => d.body.round)).size === drafts.length);
  const reviews = await operator.queryAll<{ round: number; by: string }>({ kind: REVIEW, match: { song } });
  check("two blind reviews per round, no more", reviews.length === 4, reviews.map((r) => `r${r.body.round}:${r.body.by}`).sort());
  const scoreOf = (round: number) => drafts.find((d) => d.body.round === round)!.body.score;
  const faultsOf = (round: number) => {
    const p = parseScore(scoreOf(round));
    return faults(analyse(p.parts, scoreOf(round), "C major"));
  };
  const before = faultsOf(1), after = faultsOf(2);
  check("the review IMPROVED the piece, measurably", after < before, `${before} faults -> ${after}`);
  check("round one really had the faults parallel authoring makes", before >= 8, before);

  const verdicts = await operator.queryAll<{ by: string; round: number; approve: boolean }>({ kind: VERDICT, match: { song } });
  check("both reviewers answered every round", verdicts.length === 4, verdicts.length);
  check("the rules reviewer refused round one", verdicts.some((v) => v.body.by === "rules" && v.body.round === 1 && !v.body.approve));
  check("and approved round two", verdicts.some((v) => v.body.by === "rules" && v.body.round === 2 && v.body.approve));

  const notes = await operator.queryAll<{ agreed: boolean; round: number }>({ kind: NOTE, match: { song, topic: "review" } });
  check("what each reviewer caught is recorded per round", notes.length === 2, notes.length);
  // Both verdicts can be written before either is claimed, so both handlers see a complete round.
  // Without a key on the settlement that finished the song twice, rendering it twice.
  const finals = await operator.queryAll<Record<string, unknown>>({ kind: NOTE, match: { song, topic: "final" } });
  check("the song is finished ONCE, not once per reviewer", finals.length === 1, `${finals.length} final notes`);
  check("the round ended on agreement, not on the round limit", final.body.settledBy === "both reviewers approved", final.body.settledBy);

  // ---- the artifact a person can actually play ----
  const ws = await readWorkspace(operator, String(final.body.workspace));
  check("a workspace holds the song", Boolean(ws), final.body.workspace);
  const names = (ws?.files ?? []).map((f) => f.path).sort();
  // The page, the finished song, and a take per round that did not ship. Two rounds ran here, so
  // round one is kept as audio beside the one that was approved.
  check("with a page, the song, and every earlier round beside it", names.join(",") === "index.html,round-1.wav,song.wav", names);
  const wavFile = ws!.files.find((f) => f.path === "song.wav")!;
  const wav = await operator.getArtifact(wavFile.artifactId);
  const dv = new DataView(wav.buffer, wav.byteOffset);
  const td = new TextDecoder();
  check("the audio is a real WAV", td.decode(wav.slice(0, 4)) === "RIFF" && td.decode(wav.slice(8, 12)) === "WAVE");
  check("stereo, 44.1kHz, 16-bit", dv.getUint16(22, true) === 2 && dv.getUint32(24, true) === 44100 && dv.getUint16(34, true) === 16);
  const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2);
  let loud = 0;
  for (let i = 0; i < pcm.length; i++) if (Math.abs(pcm[i]) > 300) loud++;
  check("and it is not silence", loud / pcm.length > 0.3, `${(loud / pcm.length * 100).toFixed(0)}% audible`);
  // Re-render the approved score here and demand the same bytes. That is two claims at once: the
  // synth is deterministic (so the audio is content-addressable and two renders dedupe), and the
  // file in the workspace really is this score rather than something else that happens to be audio.
  const again = render(parseScore(scoreOf(2)).parts, scoreOf(2)).wav;
  const sha = async (b: Uint8Array) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((n) => n.toString(16).padStart(2, "0")).join("");
  const digest = await sha(wav);
  check("the same score renders to the same bytes", digest === await sha(again), digest.slice(0, 16));
  check("and those are the bytes the workspace addresses", wavFile.digest.endsWith(digest), wavFile.digest.slice(0, 24));
  const html = td.decode(await operator.getArtifact(ws!.files.find((f) => f.path === "index.html")!.artifactId));
  check("the page plays the file beside it", html.includes('src="song.wav"'));
  check("and reaches nothing else", !/https?:\/\//.test(html), "no external reference");
  // THE HISTORY, which is the claim this example makes rendered as a page: every round, its audio,
  // what each reviewer said about it, and which parts changed on the way to the next one.
  check("the page plays the REJECTED round too", html.includes('src="round-1.wav"'));
  check("and shows both reviewers per round, side by side", (html.match(/class="verdict/g) ?? []).length >= 4, (html.match(/class="verdict/g) ?? []).length);
  check("naming what the count caught and what the ear said", html.includes("the count") && html.includes("the ear"));
  check("and marking which parts changed between rounds", html.includes("changed"));
  check("with the fault count on every round's summary line", (html.match(/\d+ faults<\/span>/g) ?? []).length >= 2, (html.match(/\d+ faults<\/span>/g) ?? []).length);
  // The finished song leads: its player is above the fold, before anything about how it got there.
  check("and the finished song comes first, before the history", html.indexOf('src="song.wav"') < html.indexOf("How it got there"));
  check("the earlier rounds are folded away", (html.match(/<details/g) ?? []).length >= 2 && html.includes("<details open>"));

  // THE LANE VIEW, after `radia activity`: a row per AGENT, marks placed by time, and the asks
  // listed under it as that view lists handoffs. Driven from a made-up history so the timing is
  // known: a part that took ten times as long has to sit ten times further along, and that is the
  // property spacing by round could not express.
  const T = Date.parse("2026-01-01T00:00:00Z");
  const at = (s: number) => T + s * 1000;
  const synthetic = {
    title: "T",
    description: "d",
    key: "C major",
    bpm: 120,
    chords: CHORDS,
    settledBy: "both reviewers approved",
    events: [
      { lane: "arranger", at: at(0), what: "wrote" as const, round: 1, detail: "wrote the brief" },
      { lane: "lead", at: at(10), what: "wrote" as const, round: 1, detail: "lead answered" },
      { lane: "bass", at: at(100), what: "wrote" as const, round: 1, detail: "bass answered" },
      { lane: "producer", at: at(120), what: "wrote" as const, round: 1, detail: "assembled round 1" },
      { lane: "the count", at: at(130), what: "refused" as const, round: 1, detail: "sent it back" },
      { lane: "the ear", at: at(135), what: "refused" as const, round: 1, detail: "sent it back" },
      { lane: "lead", at: at(200), what: "rewrote" as const, round: 2, detail: "lead answered" },
      { lane: "bass", at: at(205), what: "rewrote" as const, round: 2, detail: "bass answered" },
      { lane: "producer", at: at(230), what: "wrote" as const, round: 2, detail: "assembled round 2" },
      { lane: "the count", at: at(240), what: "approved" as const, round: 2, detail: "approved" },
      { lane: "the ear", at: at(250), what: "approved" as const, round: 2, detail: "approved" },
      { lane: "producer", at: at(260), what: "wrote" as const, round: 2, detail: "rendered the song" },
    ],
    marks: [{ round: 1, at: at(120) }, { round: 2, at: at(230) }],
    rounds: [
      { round: 1, score: { bpm: 120, meter: { beats: 4, unit: 4 }, parts: [{ instrument: "lead", phrase: "C4/1" }, { instrument: "bass", phrase: "C3/1" }] }, verdicts: [{ by: "rules", approve: false, asks: [{ instrument: "lead", note: "raise it" }] }, { by: "ear", approve: false, asks: [] }] },
      // The lead took the ask; the bass was asked nothing and sent its part back as it was.
      { round: 2, score: { bpm: 120, meter: { beats: 4, unit: 4 }, parts: [{ instrument: "lead", phrase: "E4/1" }, { instrument: "bass", phrase: "C3/1" }] }, verdicts: [{ by: "rules", approve: true, asks: [] }, { by: "ear", approve: true, asks: [] }] },
    ],
  };
  const lanes = historyPage(synthetic);
  const leftOf = (detail: string) => Number((lanes.match(new RegExp(`left:([\\d.]+)%[^>]*${detail}`)) ?? ["", "-1"])[1]);
  check("every agent gets a lane, not only the players", ["arranger", "lead", "bass", "the count", "the ear", "producer"].every((l) => lanes.includes(`<span class="lab">${l}</span>`)));
  check("marks are placed by TIME, so a slow part sits further right", leftOf("bass answered") > leftOf("lead answered"), `lead at ${leftOf("lead answered")}%, bass at ${leftOf("bass answered")}%`);
  check("and the spacing is proportional, not merely ordered", Math.abs(leftOf("bass answered") - (2 + 96 * 100 / 260)) < 0.5, `${leftOf("bass answered")}% for 100s of 260s`);
  check("approving reads differently from refusing and from writing", ["approved", "refused", "wrote"].every((c) => lanes.includes(`class="m ${c}"`)));
  check("the rounds are drawn ON the axis rather than being it", (lanes.match(/class="rule"/g) ?? []).length === 2 && lanes.includes(">r1</span>"));
  check("with an elapsed-time axis beneath", (lanes.match(/class="tick"/g) ?? []).length === 5);
  check("and the asks are listed under it, reviewer to part", lanes.includes("the count") && /<ul class="handoffs">/.test(lanes));
  check("no times means no timeline, rather than one invented from round numbers", !historyPage({ ...synthetic, events: undefined, marks: undefined }).includes('class="lanes"'));

  // Everything above is settled, so the pipeline's reviewers and players stop here. The cases below
  // put their own songs on this space and must not be answered by them.
  pipeline.abort();

  // ---- a run that cannot write a readable score still ends ----
  // The round limit forces a settlement whatever the last draft looks like. Rendering it blindly
  // threw on a score that did not parse, the claim retried until it dead-lettered, and the run hung
  // with no final note: measured, a team spent two of three rounds on one player's bar arithmetic.
  // Driven through the real producer on this space, with a player that writes short bars on demand.
  // Each case runs its OWN reviewers and player and stops them when it ends. Left running, the first
  // case's player answers the second case's song, and since it writes a readable bar for round one
  // the "nothing parses" case quietly parsed: a flake that passed on the first run and failed on the
  // next. A claim is by kind, so any loop on this space answers any song.
  const brokenSong = async (parses: (round: number) => boolean, tag: string) => {
    const own = new AbortController();
    stop.signal.addEventListener("abort", () => own.abort(), { once: true });
    const id = (await operator.put({ kind: "song_request", body: { description: tag } })).id;
    await operator.put({
      kind: BRIEF,
      body: { song: id, title: tag, description: tag, key: "C major", bpm: 120, meter: { beats: 4, unit: 4 }, parts: ["lead"], maxRounds: 2 } as unknown as Record<string, unknown>,
    });
    const p = await mint(`solo-${tag}`, "player", "lead");
    const rules = await mint(`rules-${tag}`, "checker"), earOnly = await mint(`ear-${tag}`, "critic");
    const drive = (c: RadiaClient, pattern: Record<string, unknown>, make: (b: Record<string, unknown>) => { kind: string; body: Record<string, unknown> }) =>
      (async () => {
        while (!own.signal.aborted) {
          const claim = await c.take({ pattern: pattern as never }, { leaseSeconds: 20 }).catch(() => null);
          if (!claim) {
            await new Promise((r) => setTimeout(r, 60));
            continue;
          }
          await c.ack(claim.lease, make(claim.record.body as Record<string, unknown>)).catch(() => {});
        }
      })().catch(() => {});
    drive(p.client, { kind: PART, match: { instrument: "lead" } }, (b) => ({
      kind: PHRASE,
      body: { song: b.song, instrument: "lead", round: b.round, phrase: parses(Number(b.round)) ? "C4/4 D4/4 E4/4 F4/4" : "C4/4 D4/4 E4/4" },
    }));
    drive(rules.client, { kind: REVIEW, match: { by: "rules" } }, (b) => ({
      kind: VERDICT,
      body: { song: b.song, round: b.round, by: "rules", approve: false, summary: "no", faults: 5, asks: [{ instrument: "lead", note: "again" }] },
    }));
    drive(earOnly.client, { kind: REVIEW, match: { by: "ear" } }, (b) => ({ kind: VERDICT, body: { song: b.song, round: b.round, by: "ear", approve: false, summary: "no", asks: [] } }));
    await operator.put({ kind: PART, body: { song: id, instrument: "lead", round: 1, guidance: "go" } });
    try {
      for (let i = 0; i < 250; i++) {
        const done = (await operator.queryNewest<Record<string, unknown>>({ kind: NOTE, match: { song: id, topic: "final" } }, 1))[0];
        if (done) return done.body;
        await new Promise((r) => setTimeout(r, 200));
      }
      return undefined;
    } finally {
      own.abort();
    }
  };
  const fellBack = await brokenSong((r) => r === 1, "fallback");
  check("a run whose last round does not parse still finishes", Boolean(fellBack), fellBack?.settledBy);
  check("by rendering the newest round anyone can read", Boolean(fellBack?.workspace), fellBack?.workspace);
  check("and a round lost to notation does not spend the budget", /only 1 produced a score/.test(String(fellBack?.settledBy)), fellBack?.settledBy);
  const noneAtAll = await brokenSong(() => false, "nothing");
  check("a run where NO round parses ends too, saying so", noneAtAll?.ok === false, noneAtAll?.settledBy);
  check("with no workspace, because there is nothing to play", noneAtAll?.workspace === undefined);

  // ---- percussion is rhythm, not harmony ----
  // A drum's notes pick a drum, so measuring them for clashes, key or chord tones counts nonsense.
  // The kit below is deliberately hostile as PITCHES: a tritone, notes outside the key, and sitting
  // below the bass where the resolution test reads. Measured against the unfixed code it turned a
  // clean piece into 19 faults and reported that it does not resolve.
  const clean = { bpm: 112, meter: { beats: 4, unit: 4 }, chords: CHORDS, parts: brief.parts.map((i) => ({ instrument: i, phrase: ROUND2[i] })) };
  const kit = { instrument: "drums", phrase: "C2/4 F#2/8 F#2/8 D2/4 F#2/4 | C2/4 F#2/8 F#2/8 D2/4 F#2/4" };
  const withKit = { ...clean, parts: [...clean.parts, kit] };
  const scoreOf2 = (s: typeof clean) => faults(analyse(parseScore(s).parts, s, "C major"));
  check("a drum part adds no harmonic faults, however it is pitched", scoreOf2(withKit) === scoreOf2(clean), `${scoreOf2(clean)} -> ${scoreOf2(withKit)}`);
  const keeps = analyse(parseScore(withKit).parts, withKit, "C major");
  check("and it does not hijack the resolution, which reads the lowest PITCHED part", keeps.endsOnTonic === true);
  // Dullness still counts on a drum: rhythm is the thing a percussion part can be dull at.
  const flat = { ...clean, parts: [...clean.parts, { instrument: "drums", phrase: "C2/4 C2/4 C2/4 C2/4 | C2/4 C2/4 C2/4 C2/4" }] };
  check("but a drum playing one note length is still called dull", scoreOf2(flat) > scoreOf2(clean), `${scoreOf2(clean)} -> ${scoreOf2(flat)}`);
  // A four-part score renders, and the kit sounds as three drums rather than one: the pitch picks
  // the drum, so a kick carries far more energy than a hat struck at the same moment would.
  const kitAudio = render(parseScore(withKit).parts, withKit);
  const kpcm = new Int16Array(kitAudio.wav.buffer, kitAudio.wav.byteOffset + 44, (kitAudio.wav.length - 44) / 2);
  let kloud = 0;
  for (let i = 0; i < kpcm.length; i++) if (Math.abs(kpcm[i]) > 300) kloud++;
  check("a song with drums renders to audio", kitAudio.wav.length > 44 && kloud / kpcm.length > 0.3, `${(kloud / kpcm.length * 100).toFixed(0)}% audible`);
  const kick = voiceFor("drums") && drumVoiceFor(36), hat = drumVoiceFor(72);
  check("and the kit is three sounds, not one repeated", kick.wave !== hat.wave || kick.tone !== hat.tone, `${kick.wave}/${kick.tone} vs ${hat.wave}/${hat.tone}`);

  // ---- the instruments are more than one oscillator each ----
  const leadV = voiceFor("lead"), bassV = voiceFor("bass");
  check("the lead is a stack of detuned oscillators", (leadV.unison ?? 1) >= 2 && (leadV.detune ?? 0) > 0, `${leadV.unison} x ${leadV.detune}c`);
  check("under a filter that closes as the note sounds", leadV.toneEnd !== undefined && leadV.toneEnd < leadV.tone, `${leadV.tone} -> ${leadV.toneEnd}`);
  check("and the bass carries a sub an octave down", (bassV.sub ?? 0) > 0, bassV.sub);
  // The stack has to be AUDIBLE, not just configured: detuned copies beat, so a held note's
  // amplitude wavers where a single oscillator through a settled filter would hold steady.
  const held = { bpm: 60, meter: { beats: 4, unit: 4 }, parts: [{ instrument: "lead", phrase: "A4/1" }] };
  const heldPcm = (() => {
    const w = render(parseScore(held).parts, held).wav;
    return new Int16Array(w.buffer, w.byteOffset + 44, (w.length - 44) / 2);
  })();
  const peaks: number[] = [];
  for (let s = Math.floor(0.4 * 44100) * 2; s < Math.floor(3.2 * 44100) * 2; s += Math.floor(0.05 * 44100) * 2) {
    let m = 0;
    for (let i = s; i < s + Math.floor(0.05 * 44100) * 2 && i < heldPcm.length; i += 2) m = Math.max(m, Math.abs(heldPcm[i]));
    peaks.push(m);
  }
  const avg = peaks.reduce((a, b) => a + b, 0) / peaks.length;
  const waver = Math.sqrt(peaks.reduce((a, b) => a + (b - avg) ** 2, 0) / peaks.length) / avg;
  check("so a held note breathes instead of sitting still", waver > 0.1, `${(waver * 100).toFixed(0)}% amplitude movement`);

  // ---- a groove is steady on purpose ----
  // The one place the brief overrules a measurement, added because the two were caught fighting: an
  // arranger asked a bass for "steady eighth notes throughout" and a kit for four-on-the-floor, and
  // the count then called both of them dull. It relaxes ONE rule for the rhythm section, so a lead
  // that never varies is still a lead that never varies.
  const pulse = {
    bpm: 124,
    meter: { beats: 4, unit: 4 },
    chords: ["Am", "F"],
    parts: [
      { instrument: "lead", phrase: "A4/4 C5/8 E5/8 C5/4 A4/4 | A4/2 C5/4 E5/4" },
      { instrument: "harmony", phrase: "C4/2 E4/4 A3/4 | C4/2 A3/2" },
      // Unbroken eighths, which is what a groove asks for, but it still MOVES: a bass alternating
      // two notes has nowhere to go, and that stays a fault whatever the brief says.
      { instrument: "bass", phrase: "A2/8 A2/8 E3/8 A2/8 A2/8 E3/8 A2/8 C3/8 | F2/8 F2/8 C3/8 F2/8 F2/8 C3/8 F2/8 A2/8" },
      { instrument: "drums", phrase: "C2/4 C4/4 D3/4 C4/4 | C2/4 C4/4 D3/4 C4/8 C4/8" },
    ],
  };
  const asWritten = analyse(parseScore(pulse).parts, pulse, "A minor");
  const asGroove = analyse(parseScore({ ...pulse, groove: true }).parts, { ...pulse, groove: true }, "A minor");
  check("a steady bass and kit are called dull when nothing says otherwise", asWritten.bland > 0, `bland=${asWritten.bland}`);
  check("and are not, once the brief says the piece is a groove", asGroove.bland === 0, `bland=${asGroove.bland}`);
  // The exemption is narrow in both directions: one rule, and only for the rhythm section.
  const dullLead = { ...pulse, groove: true, parts: [{ ...pulse.parts[0], phrase: "A4/4 A4/4 A4/4 A4/4 | A4/4 A4/4 A4/4 A4/4" }, ...pulse.parts.slice(1)] };
  check("a groove never excuses the LEAD from having a rhythm", analyse(parseScore(dullLead).parts, dullLead, "A minor").bland > 0);
  const noFill = { ...pulse, groove: true, parts: [...pulse.parts.slice(0, 3), { instrument: "drums", phrase: Array(6).fill("C2/4 C4/4 D3/4 C4/4").join(" | ") }] };
  const never = analyse(parseScore(noFill).parts, noFill, "A minor");
  check("nor a kit that never varies at all, which still wants a fill", never.findings.some((f) => /never varies/.test(f.detail)), `bland=${never.bland}`);

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
} finally {
  stop.abort();
  try {
    space.kill();
    await space.status;
  } catch { /* already gone */ }
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}
if (failures > 0) Deno.exit(1);
