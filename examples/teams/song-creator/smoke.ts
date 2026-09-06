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
import { render } from "./synth.ts";
import { judge } from "./checker.ts";
import { type Brief, runProducer } from "./producer.ts";
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
  for (const k of SONG_KINDS) await operator.registerKind(k);
  await operator.registerKind({ kind: NOTE, indexedPaths: [{ path: "song", type: "keyword" }, { path: "topic", type: "keyword" }], claimable: false });
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
  const checkerLoop = (async () => {
    while (!stop.signal.aborted) {
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
    while (!stop.signal.aborted) {
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
      while (!stop.signal.aborted) {
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
  check("with the audio and a page beside it", names.join(",") === "index.html,song.wav", names);
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
