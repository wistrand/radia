// The producer: the mechanical spine of the pipeline, and deliberately not a model.
//
//   deno run -A examples/teams/song-creator/producer.ts --url … [--rounds 2]
//
// Everything here is bookkeeping a prompt should never carry: noticing when every player has
// answered, assembling their phrases, dispatching two reviews, counting rounds, and rendering. The
// models decide what the music should be; this decides nothing.
//
// THE FAN-IN IS THE ONLY SUBTLE PART. Three players work in parallel, so something must notice when
// the last one lands. It does NOT poll: a claim that nacks while it waits burns the record's bounded
// attempts on waiting, which is how a slow player becomes a dead-lettered song. Instead every
// claimed `phrase` asks whether the round is now complete, and the completing claim writes the
// draft under an idempotency key derived from the song and round. Two players finishing at the same
// instant both see a full set and both write; the second is a replay rather than a second draft.

import { RadiaClient, type RadiaRecord } from "../../../sdk/ts/client.ts";
import { agentLoop } from "../../../sdk/ts/loop.ts";
import { TEAM_FIELD } from "../../../extensions/ts/team.ts";
import { writeWorkspace } from "../../../extensions/ts/workspace.ts";
import { parseScore, type Score } from "./score.ts";
import { durationSeconds } from "./score.ts";
import { page, render } from "./synth.ts";
import { BRIEF, DRAFT, NOTE, PART, PHRASE, REVIEW, VERDICT } from "./kinds.ts";

const flag = (n: string) => {
  const i = Deno.args.indexOf(n);
  return i >= 0 ? Deno.args[i + 1] : undefined;
};

/** How many counted faults the ear may settle over. Set against a measured score rather than a
 *  feeling: a piece written to its chords with a rhythm scores about 6, and one in two keys at once
 *  with a metronome bass scores 56. Anything a clash or a parallel appears in exceeds this. */
const EAR_SLACK = 8;

export interface Brief {
  song: string;
  title: string;
  description: string;
  key: string;
  bpm: number;
  meter: { beats: number; unit: number };
  /** One chord per bar, which is what lets three players written apart agree about the harmony. */
  chords?: string[];
  bars?: number;
  parts: string[];
  maxRounds?: number;
}

/** Assemble one round's phrases into a score, in the brief's part order so the render is stable. */
export function assemble(brief: Brief, phrases: RadiaRecord<{ instrument: string; phrase: string }>[]): Score {
  const byInstrument = new Map(phrases.map((p) => [p.body.instrument, p.body.phrase]));
  return {
    bpm: brief.bpm,
    meter: brief.meter,
    // CARRIED ONTO THE SCORE, so the reviewers judge against the same harmony the players were
    // given. A progression that lives only on the brief is one nothing checks.
    ...(brief.chords?.length ? { chords: brief.chords } : {}),
    parts: brief.parts.filter((i) => byInstrument.has(i)).map((i) => ({ instrument: i, phrase: byInstrument.get(i)! })),
  };
}

/** Merge two blind verdicts into the next round's instructions. A player is only asked once per
 *  round, with everything both reviewers said about its part, so it can weigh them together. */
export function mergeAsks(verdicts: { by: string; asks?: { instrument: string; note: string }[] }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const v of verdicts) {
    for (const a of v.asks ?? []) {
      const list = out.get(a.instrument) ?? [];
      list.push(`(${v.by}) ${a.note}`);
      out.set(a.instrument, list);
    }
  }
  return out;
}

export async function runProducer(
  client: RadiaClient,
  o: { rounds: number; signal: AbortSignal; log: (s: string) => void; team?: string },
): Promise<void> {
  const say = o.log;
  // A TEAM LABEL ON EVERY WRITE. A member's grants are patterned on `team`, so a record without it
  // is one no member can read and this service cannot write. The MCP adapter fills the field for a
  // harness member after the space refuses one write; a service holds a plain SDK client and no
  // such machinery, so it stamps its own. Absent outside a team, which is how the smoke runs.
  const stamp = <T extends Record<string, unknown>>(body: T): T =>
    (o.team ? { ...body, [TEAM_FIELD]: o.team } : body);

  const briefOf = async (song: string): Promise<Brief | null> =>
    (await client.readOne<Brief>({ kind: BRIEF, match: { song } }))?.body ?? null;

  await agentLoop(client, {
    name: "producer",
    // Three patterns, one loop: this member is the only thing that has to see every stage.
    patterns: [{ kind: PHRASE }, { kind: VERDICT }],
    signal: o.signal,
    log: say,
    handle: async (record) => {
      const b = record.body as { song: string; round: number; instrument?: string; by?: string };
      const brief = await briefOf(b.song);
      if (!brief) throw new Error(`no brief for song ${b.song}`);

      // ---- a player finished: is the round complete? ----
      if (record.kind === PHRASE) {
        const phrases = await client.queryAll<{ instrument: string; phrase: string }>({
          kind: PHRASE,
          match: { song: b.song, round: b.round },
        });
        const have = new Set(phrases.map((p) => p.body.instrument));
        if (!brief.parts.every((i) => have.has(i))) {
          say(`[producer] ${b.song} r${b.round}: ${have.size}/${brief.parts.length} parts in`);
          return; // ack with no result: this phrase is recorded, the round is not ready
        }
        const score = assemble(brief, [...phrases]);
        // KEYED ON THE ROUND, so two players completing at once write one draft between them.
        const draft = await client.put(
          { kind: DRAFT, body: stamp({ song: b.song, round: b.round, key: brief.key, title: brief.title, score }) },
          `draft:${b.song}:${b.round}`,
        );
        for (const by of ["rules", "ear"] as const) {
          await client.put(
            { kind: REVIEW, body: stamp({ song: b.song, round: b.round, by, draft: draft.id, key: brief.key }), parentIds: [draft.id] },
            `review:${b.song}:${b.round}:${by}`,
          );
        }
        say(`[producer] ${b.song} r${b.round}: draft ${draft.id.slice(-6)}, two reviews out`);
        return;
      }

      // ---- a reviewer answered: wait for both, then decide ----
      const verdicts = await client.queryAll<{ by: string; approve: boolean; summary?: string; faults?: number; asks?: { instrument: string; note: string }[] }>({
        kind: VERDICT,
        match: { song: b.song, round: b.round },
      });
      const by = new Set(verdicts.map((v) => v.body.by));
      if (!by.has("rules") || !by.has("ear")) {
        say(`[producer] ${b.song} r${b.round}: ${[...by].join("+") || "no"} verdict in, waiting for the other`);
        return;
      }

      // What each reviewer caught, recorded because it is the question this example exists to ask
      // and because neither reviewer can see the other's answer to bias it.
      const bodies = verdicts.map((v) => v.body);
      const rules = bodies.find((v) => v.by === "rules");
      const ear = bodies.find((v) => v.by === "ear");
      const asks = mergeAsks(bodies);
      const maxRounds = brief.maxRounds ?? o.rounds;
      // WHO SETTLES THE PIECE. Requiring both reviewers made the fault count a veto and left the ear
      // advisory, which is backwards for something meant to be worth hearing: a real run had the
      // critic approve while the counter held out over minor faults, and the round limit ended it.
      // So the ear carries the decision once the arithmetic finds nothing serious. It cannot settle
      // a piece that is actually broken, because a clash, a parallel or a bar in the wrong chord
      // costs more than this slack.
      const counted = typeof rules?.faults === "number" ? rules.faults : Infinity;
      const bothAgree = bodies.every((v) => v.approve);
      const earDecides = ear?.approve === true && counted <= EAR_SLACK;
      const approved = bothAgree || earDecides || b.round >= maxRounds;
      const settledBy = bothAgree
        ? "both reviewers approved"
        : earDecides
        ? `the ear approved and the count was low (${counted})`
        : `round limit (${maxRounds}) reached`;

      await client.put({
        kind: NOTE,
        body: stamp({
          song: b.song,
          round: b.round,
          topic: "review",
          rules: rules?.summary ?? "",
          ear: ear?.summary ?? "",
          agreed: Boolean(rules?.approve) === Boolean(ear?.approve),
          asked: [...asks.keys()],
        }),
      }, `review-note:${b.song}:${b.round}`);

      if (!approved) {
        for (const instrument of brief.parts) {
          const notes = asks.get(instrument);
          await client.put({
            kind: PART,
            body: stamp({
              song: b.song,
              instrument,
              round: b.round + 1,
              guidance: `Round ${b.round + 1}. Keep what works; change only what was asked.`,
              notes: notes?.length ? notes : ["nothing was asked of your part: send it back unchanged"],
            }),
          }, `part:${b.song}:${b.round + 1}:${instrument}`);
        }
        say(`[producer] ${b.song} r${b.round}: revising, ${asks.size} part(s) asked`);
        return;
      }

      // ---- approved (or out of rounds): render ----
      // ONE SETTLEMENT PER SONG. Both verdicts can already be written when the first is claimed, so
      // both handlers see a complete round and both would finish the song: the same race the draft
      // key closes on the phrase side, and it produced two final notes and two renders before this
      // check. Reading first skips the wasted render; the key below is what makes it correct.
      const settled = await client.readOne<Record<string, unknown>>({ kind: NOTE, match: { song: b.song, topic: "final" } });
      if (settled) {
        say(`[producer] ${b.song}: already finished by the other verdict`);
        return;
      }
      const draft = await client.readOne<{ score: Score; title: string }>({ kind: DRAFT, match: { song: b.song, round: b.round } });
      if (!draft) throw new Error(`no draft to render for ${b.song} round ${b.round}`);
      const parsed = parseScore(draft.body.score);
      if (parsed.errors.length > 0) throw new Error(`the approved draft does not parse: ${parsed.errors[0]}`);
      const audio = render(parsed.parts, draft.body.score);
      const seconds = durationSeconds(parsed.parts, draft.body.score);
      const html = page(brief.title, {
        description: brief.description,
        key: brief.key,
        bpm: brief.bpm,
        parts: brief.parts,
        seconds,
      });
      // `scope` labels the manifest AND every file's artifact, and narrows which tree of this name
      // is superseded. Without it the artifact puts carry no team and a scoped grant refuses them.
      const ws = await writeWorkspace(client, {
        name: `song-${b.song.slice(-8).toLowerCase()}`,
        owner: "agent:producer",
        files: { "song.wav": audio.wav, "index.html": html },
        entrypoint: "index.html",
        ...(o.team ? { scope: { [TEAM_FIELD]: o.team } } : {}),
      });
      say(`[producer] ${b.song}: rendered ${seconds.toFixed(1)}s into workspace ${ws.treeDigest.slice(0, 12)}`);

      // A URL anyone can open, minted over the tree's own artifacts and needing no credential: the
      // read grant is checked once, here, at mint. SHORT-LIVED and held in the space's memory, so it
      // dies at `urlExpiresAt` and again whenever the space restarts; `share.ts` mints a fresh one.
      // BEST EFFORT, because a song that rendered must not be lost to a link that could not be minted.
      let shared: { url: string; expiresAt: string } | undefined;
      try {
        const cap = await client.pathCapability(ws.files.map((f) => ({ path: f.path, artifactId: f.artifactId })));
        shared = { url: cap.url, expiresAt: cap.expiresAt };
        say(`[producer] ${b.song}: ${cap.url}`);
      } catch (e) {
        say(`[producer] ${b.song}: rendered, but no share URL: ${(e as Error).message}`);
      }
      // KEYED, not returned as the ack result: an ack result is written per claim, and two claims
      // settling one song is exactly the case above. The key makes a second one a replay.
      await client.put({
        kind: NOTE,
        parentIds: [record.id],
        body: stamp({
          song: b.song,
          topic: "final",
          title: brief.title,
          workspace: `song-${b.song.slice(-8).toLowerCase()}`,
          treeDigest: ws.treeDigest,
          ...(shared ? { url: shared.url, urlExpiresAt: shared.expiresAt } : {}),
          rounds: b.round,
          seconds: Number(seconds.toFixed(2)),
          settledBy,
        }),
      }, `final:${b.song}`);
      return;
    },
  });
}

if (import.meta.main) {
  const url = flag("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
  const token = Deno.env.get("RADIA_DEFINITION_TOKEN");
  if (!token) {
    console.error("producer: RADIA_DEFINITION_TOKEN is required (radia team up sets it for a service member)");
    Deno.exit(1);
  }
  const stop = new AbortController();
  try {
    Deno.addSignalListener("SIGTERM", () => stop.abort());
    Deno.addSignalListener("SIGINT", () => stop.abort());
  } catch { /* not on this platform */ }
  console.error(`producer: assembling, reviewing and rendering on ${url}`);
  await runProducer(new RadiaClient(url, { definitionToken: token }), {
    rounds: Number(flag("--rounds") ?? 2),
    signal: stop.signal,
    log: (m) => console.error(m),
    team: flag("--team"),
  });
}
