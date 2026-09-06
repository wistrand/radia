// The RULES reviewer: arithmetic, not judgment, and a member rather than a helper function.
//
//   deno run -A examples/teams/song-creator/checker.ts --url … --song <id>
//
// It could have been a call inside the producer. Making it an agent buys three things a function
// cannot. Its verdict is a RECORD written by a principal the players cannot impersonate, because a
// grant pattern on `by` means only this one may write `{by: "rules"}`. It shows up as its own lane
// in `radia activity`, so a reader sees two reviewers working. And it reviews BLIND, at the same
// time as the model critic and without seeing its opinion, which is what turns "what does each kind
// of reviewer catch?" into a fact the run records rather than a claim the README makes.
//
// What it cannot do is the other half of the job. It finds four parallel fifths perfectly and will
// never notice that the melody is dull. That asymmetry is the point of running both.

import { RadiaClient } from "../../../sdk/ts/client.ts";
import { agentLoop } from "../../../sdk/ts/loop.ts";
import { TEAM_FIELD } from "../../../extensions/ts/team.ts";
import { analyse, faults } from "./analysis.ts";
import { parseScore, type Score } from "./score.ts";
import { DRAFT, REVIEW, VERDICT } from "./kinds.ts";

const flag = (n: string) => {
  const i = Deno.args.indexOf(n);
  return i >= 0 ? Deno.args[i + 1] : undefined;
};

export interface RulesVerdict {
  approve: boolean;
  summary: string;
  asks: { instrument: string; note: string }[];
  faults: number;
  metrics: Record<string, unknown>;
}

/**
 * The whole judgment, exported so the smoke can assert it without a space.
 *
 * A finding is turned into an ASK addressed to one instrument, because that is what the next round
 * needs: "bar 3 has parallel fifths between lead and harmony" is a fact, and the player who has to
 * act on it needs it as its own instruction. Findings naming two parts ask BOTH, since either could
 * move and this reviewer has no opinion about which should.
 */
export function judge(score: Score, key: string): RulesVerdict {
  const parsed = parseScore(score);
  if (parsed.errors.length > 0) {
    // ONE ASK PER DISTINCT MISTAKE, not one per token. A player who wrote every note in the wrong
    // format produces an error per note: a real run made 122 of them, and unbounded they became 122
    // instructions on the next round's record, which is a prompt nobody can act on. What the player
    // needs is the rule, once, with a count saying how much of the part it applies to.
    const distinct = new Map<string, { instrument: string; note: string; n: number }>();
    for (const e of parsed.errors) {
      const instrument = e.split(":")[0];
      // A parse error is already addressed to an instrument by `parseScore`, which prefixes it, and
      // the quoted token is the only part that varies between repeats of one mistake.
      const k = `${instrument}|${e.replace(/'[^']*' /, "")}`;
      const hit = distinct.get(k);
      if (hit) hit.n++;
      else distinct.set(k, { instrument, note: e, n: 1 });
    }
    return {
      approve: false,
      summary: `the score does not parse: ${parsed.errors.length} error(s) in ${distinct.size} distinct place(s)`,
      // CAPPED PER INSTRUMENT, never globally. A global cap is spent by whoever appears first in
      // the score: with two parts mis-formatted it left the third player no notes at all, and a
      // player with no notes is told its part was fine, so a broken part would stay broken forever.
      asks: [...new Set([...distinct.values()].map((a) => a.instrument))].flatMap((instrument) =>
        [...distinct.values()].filter((a) => a.instrument === instrument).slice(0, 2).map((a) => ({
          instrument,
          note: a.n > 1 ? `${a.note} (and ${a.n - 1} more like it: fix every note in your part)` : a.note,
        }))
      ),
      faults: 999,
      metrics: {},
    };
  }
  const m = analyse(parsed.parts, score, key);
  const asks: { instrument: string; note: string }[] = [];
  // Bounded, and the bound is a kindness rather than a cost saving: a player handed thirty notes
  // rewrites everything and the next round is a different piece, not a fixed one.
  for (const f of m.findings.slice(0, 6)) {
    const targets = f.parts.length > 0 ? f.parts : [parsed.parts[0]?.instrument ?? "lead"];
    for (const t of targets) asks.push({ instrument: t, note: `bar ${f.bar}: ${f.detail}` });
  }
  const n = faults(m);
  return {
    approve: n === 0,
    // EVERY COUNTED FAULT APPEARS HERE. The summary is what a reader sees instead of the metrics, so
    // one that omits a term makes the total look wrong: `offChord` and `bland` were counted and left
    // out, and a piece could be told it had 4 faults beside a list of five zeroes.
    summary: n === 0
      ? "no measurable faults: nothing sounds a semitone apart, no parallel fifths or octaves, every strong beat is in its chord, nothing is dull and it resolves"
      : `${n} fault(s): ${m.dissonance} clash(es), ${m.parallels} parallel motion(s), ${m.outOfKey ?? 0} out of key, ` +
        `${m.offChord ?? 0} off the bar's chord, ${m.bland} dull part(s), ` +
        `${m.leaps} unanswered leap(s), ${m.emptyBars} empty bar(s)${m.endsOnTonic === false ? ", and it does not resolve to the tonic" : ""}`,
    asks,
    faults: n,
    metrics: { ...m, findings: undefined },
  };
}

if (import.meta.main) {
  const url = flag("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
  const token = Deno.env.get("RADIA_DEFINITION_TOKEN");
  if (!token) {
    console.error("checker: RADIA_DEFINITION_TOKEN is required (radia team up sets it for a service member)");
    Deno.exit(1);
  }
  const client = new RadiaClient(url, { definitionToken: token });
  // The team label on the verdict, for the same reason the producer stamps its writes: a service
  // holds a plain SDK client, and a record with no team is one no member's grant can read.
  const team = flag("--team");
  const stop = new AbortController();
  try {
    Deno.addSignalListener("SIGTERM", () => stop.abort());
    Deno.addSignalListener("SIGINT", () => stop.abort());
  } catch { /* not on this platform */ }

  console.error(`checker: reviewing ${REVIEW}{by: rules} on ${url}`);
  await agentLoop(client, {
    name: "checker",
    patterns: [{ kind: REVIEW, match: { by: "rules" } }],
    signal: stop.signal,
    log: (m) => console.error(m),
    handle: async (record) => {
      const b = record.body as { song: string; round: number; draft: string; key?: string };
      const draft = await client.readOne<{ score: Score; key: string }>({ kind: DRAFT, match: { song: b.song, round: b.round } });
      if (!draft) throw new Error(`no draft for ${b.song} round ${b.round}`);
      const v = judge(draft.body.score, draft.body.key ?? b.key ?? "C major");
      console.error(`checker: ${b.song} round ${b.round}: ${v.approve ? "approved" : v.summary}`);
      return {
        kind: VERDICT,
        body: { song: b.song, round: b.round, by: "rules", ...v, ...(team ? { [TEAM_FIELD]: team } : {}) },
        parentIds: [draft.id],
      };
    },
  });
}
