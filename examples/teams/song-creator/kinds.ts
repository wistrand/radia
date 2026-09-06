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
import teamFile from "./team.json" with { type: "json" };

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

/**
 * The record vocabulary, READ FROM `team.json` rather than restated here.
 *
 * `radia team up --init` declares kinds from that file, and this module is what the services and the
 * smokes declare from, so two copies of one vocabulary meant two things to keep in step. They did
 * not: `brief` gained its `chords` field here and the team file went on describing a plan without
 * one, so every agent that discovered the kind learned the old shape. One source, no drift.
 *
 * Every kind there indexes `team`, and that is not decoration: `radia team add` scopes a member's
 * grants with a pattern on that field, and a kind that does not index it can hold no grant that
 * compiles. The services stamp it on every write, since only the MCP adapter fills it by itself.
 */
export const SONG_KINDS: KindDef[] = teamFile.kinds as unknown as KindDef[];

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
