// The record vocabulary, in one place because five processes have to agree on it: two services, a
// smoke that drives them with no model at all, and (later) the harness members that replace the
// scripted halves.
//
// Every kind here is app-owned. The runtime has never heard of any of them, and the `usage` strings
// are how a model learns what to write, since nothing teaches the space in a prompt
// (CLAUDE.md, "discover, don't hardcode").
//
// WHY THE STAGES ARE SEPARATE KINDS rather than one `task` routed by tags: each stage's output IS
// the next stage's claim pattern, so the pipeline needs no tags, no assignee and no orchestrator.
// A member says `{kind: "phrase"}` and that is the whole of its routing.

import type { KindDef } from "../../../sdk/ts/client.ts";
import { TEAM_FIELD } from "../../../extensions/ts/team.ts";

/** Every kind here indexes `team`, and it is not decoration: `radia team add` scopes a member's
 *  grants with a pattern on that field, and a kind that does not index it can hold no grant that
 *  compiles. The services stamp it on every write, since only the MCP adapter fills it by itself. */
const team = { path: TEAM_FIELD, type: "keyword" } as const;

export const SONG_REQUEST = "song_request";
export const BRIEF = "brief";
export const PART = "part";
export const PHRASE = "phrase";
export const DRAFT = "draft";
export const REVIEW = "review";
export const VERDICT = "verdict";
export const NOTE = "note";

/** Who reviews. Two reviewers, two records, two exclusive claims: they work at once and neither can
 *  take the other's job. `rules` is arithmetic, `ear` is a model. */
export type Reviewer = "rules" | "ear";

export const SONG_KINDS: KindDef[] = [
  {
    kind: SONG_REQUEST,
    indexedPaths: [team, { path: "song", type: "keyword" }],
    claimable: true,
    usage: "A song somebody wants. body: {description, seconds?}. Claim it to write the brief: " +
      "decide key, tempo, meter and which parts the piece needs, then emit one `part` per player.",
  },
  {
    kind: BRIEF,
    indexedPaths: [team, { path: "song", type: "keyword" }],
    claimable: false,
    usage: "The plan every player works from. body: {song, title, description, key, bpm, meter: " +
      "{beats, unit}, bars, chords, parts: [instrument], maxRounds}. `chords` is ONE SYMBOL PER BAR " +
      "(['D','G','D','Bm',…], same length as `bars`) and it is what lets parts written apart agree " +
      "about the harmony: on the strong beats of a bar, play notes from that bar's chord. " +
      "Reference data: read it, never claim it.",
  },
  {
    kind: PART,
    indexedPaths: [team, { path: "song", type: "keyword" }, { path: "instrument", type: "keyword" }, { path: "round", type: "integer" }],
    claimable: true,
    usage: "One player's job for one round. body: {song, instrument, guidance, round, notes?}. " +
      "`notes` is present on a revision and says what the reviewers asked you to change. Answer " +
      "with a `phrase` for this instrument and round.",
  },
  {
    kind: PHRASE,
    indexedPaths: [team, { path: "song", type: "keyword" }, { path: "instrument", type: "keyword" }, { path: "round", type: "integer" }],
    claimable: true,
    usage: "One player's music. body: {song, instrument, round, phrase}. The phrase is bars " +
      "separated by |, each bar a run of PITCH/DENOM: `C4/4 E4/8 r/8 | G3/2 r/2`. PITCH is a " +
      "letter A-G, an optional # or b, and an octave number (C4 is middle C); `r` is a rest. " +
      "DENOM is the note value as a power of two, 1 to 64: /4 is a quarter note, /8 an eighth. A " +
      "dot after the denominator adds half its length again (`C4/4.`). EVERY BAR MUST SUM TO THE " +
      "METER, so four /4 notes in 4/4, and a bar that does not is refused by its number. Pitches " +
      "outside C1..C7 are refused. The brief's `bars` says how many bars to write.",
  },
  {
    kind: DRAFT,
    indexedPaths: [team, { path: "song", type: "keyword" }, { path: "round", type: "integer" }],
    claimable: false,
    usage: "Every player's phrases assembled for one round, which is the first time anyone sees " +
      "them together. body: {song, round, score}. Reference data for the reviewers to read.",
  },
  {
    kind: REVIEW,
    indexedPaths: [team, { path: "song", type: "keyword" }, { path: "round", type: "integer" }, { path: "by", type: "keyword" }],
    claimable: true,
    usage: "A request to review one draft. body: {song, round, by, draft}. `by` is 'rules' or " +
      "'ear' and decides who may claim it. Reviewers work BLIND: neither sees the other's verdict, " +
      "so what each catches is a fact the run records rather than an assumption.",
  },
  {
    kind: VERDICT,
    indexedPaths: [team, { path: "song", type: "keyword" }, { path: "round", type: "integer" }, { path: "by", type: "keyword" }],
    claimable: true,
    usage: "One reviewer's answer. body: {song, round, by, approve, summary, faults?, asks: " +
      "[{instrument, note}]}. Each ask names ONE instrument and one change, since that is what the " +
      "next round hands that player. What is measured includes DULLNESS, not only mistakes: one " +
      "note length throughout, or the same bar played over and over, counts against a piece exactly " +
      "as a wrong note does.",
  },
];

/** What each principal holds. The interesting ones are the two reviewers: a pattern on `by` means
 *  the model literally cannot write the rules verdict, refused by `bodyMatchesGrant` on the body. */
export function grantsFor(role: "arranger" | "player" | "producer" | "checker" | "critic", agent: string, instrument?: string): {
  principal: string;
  kind: string;
  operations: string[];
  pattern?: Record<string, unknown>;
}[] {
  const g = (kind: string, operations: string[], pattern?: Record<string, unknown>) => ({ principal: agent, kind, operations, ...(pattern ? { pattern } : {}) });
  // Every member declares what it listens for, which is what makes the routing views show a lane per
  // agent. Without it a member still works and logs a warning it cannot act on.
  const base = [g("interest", ["put", "query"])];
  const of = (...grants: ReturnType<typeof g>[]) => [...base, ...grants];
  switch (role) {
    case "arranger":
      return of(g(SONG_REQUEST, ["take", "query", "read_one"]), g(BRIEF, ["put", "query", "read_one"]), g(PART, ["put"]));
    case "player":
      // Scoped to its own instrument: a player cannot claim another's job, and the routing is the
      // grant rather than a rule in a prompt.
      return of(
        g(PART, ["take", "query", "read_one"], { instrument }),
        g(BRIEF, ["query", "read_one"]),
        g(PHRASE, ["put"]),
        g(VERDICT, ["query", "read_one"]),
      );
    case "producer":
      return of(
        g(PHRASE, ["take", "query", "read_one"]),
        g(VERDICT, ["take", "query", "read_one"]),
        g(BRIEF, ["query", "read_one"]),
        g(DRAFT, ["put", "query", "read_one"]),
        g(REVIEW, ["put", "query", "read_one"]),
        g(PART, ["put", "query", "read_one"]),
        // `read_one` beside the `put`: the producer checks whether a song is already finished before
        // rendering it, since two verdicts can be claimed after both were written.
        g(NOTE, ["put", "query", "read_one"]),
        // The rendered song is a tree of artifacts plus a manifest, which is what makes it servable
        // at a URL instead of a blob somebody has to download.
        g("workspace", ["put", "query", "read_one"]),
        g("artifact", ["put", "query", "read_one"]),
      );
    case "checker":
      return of(g(REVIEW, ["take", "query", "read_one"], { by: "rules" }), g(DRAFT, ["query", "read_one"]), g(VERDICT, ["put"], { by: "rules" }));
    case "critic":
      return of(g(REVIEW, ["take", "query", "read_one"], { by: "ear" }), g(DRAFT, ["query", "read_one"]), g(VERDICT, ["put"], { by: "ear" }));
  }
}
