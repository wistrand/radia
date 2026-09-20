// What `radia team up --init` does to this team, as a function the smoke can call.
//
// It reads `team.json` and performs the same two steps in the same order: declare the kinds, then
// mint each member with the grants the file asks for. Nothing here is a second copy of the rules.
// `declareKind` and `addMember` are the ones the verb uses, so a member minted by the smoke holds
// exactly what a member minted by the CLI holds, including the per-member `pattern` narrowing and
// the team label that `memberGrantPattern` adds to it.
//
// There is no operator step beside `radia team up` any more. Until 2026-09-20 there was: the team
// file could only say `<kind>:<op,op>`, which scopes to the team and no further, so the three
// grants that make a player's hand its own had to be assigned out of band. `TeamGrant` closed
// that, and this file is what is left of the step.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { addMember, declareKind, declareTeamKinds, liveKinds, readDefinition } from "../../../extensions/ts/team.ts";
import type { KindDef } from "../../../sdk/ts/wire.ts";
import { KINDS } from "../../poker/poker.ts";
import type { TeamGrant } from "../../../src/surfaces/teamfile.ts";

export const PLAYERS = ["ada", "ben", "cy", "dee"];

interface TeamFileShape {
  team: string;
  kinds: KindDef[];
  members: { name: string; service?: boolean; grants?: (string | TeamGrant)[] }[];
}

/** The team file beside this one, which is the single source of both the kinds and the grants. */
export async function readTeamFile(dir: string): Promise<TeamFileShape> {
  return JSON.parse(await Deno.readTextFile(`${dir}/team.json`)) as TeamFileShape;
}

/** The CLI's own spelling of a member grant, in the two forms `team.json` accepts. */
const grantOf = (g: string | TeamGrant): TeamGrant =>
  typeof g === "string"
    ? { kind: g.split(":")[0], operations: (g.split(":")[1] ?? "").split(",").map((o) => o.trim()).filter(Boolean) }
    : g;

/**
 * Declare the kinds and mint every member, the way `--init` does.
 *
 * Returns the definition token per member so a caller can run as one. Idempotent in the sense
 * `--init` is: a second call supersedes each definition rather than appending a second live one.
 */
export async function provisionTeam(
  operator: RadiaClient,
  dir: string,
): Promise<{ team: string; declared: number; tokens: Map<string, string> }> {
  const file = await readTeamFile(dir);
  // `team.json` carries a COPY of the kinds, because `--init` must declare them before it mints
  // any member and a grant pattern does not compile against an undeclared path. Two sources, so
  // they drift: the scripted example declares `KINDS` and the team declares the file's, and a
  // change to one is silently absent from the other. Cheap to check, and the fix is one line of
  // `deno eval` writing `KINDS` back into the file.
  if (JSON.stringify(file.kinds) !== JSON.stringify(KINDS)) {
    throw new Error(
      "examples/teams/poker/team.json kinds have drifted from examples/poker/poker.ts KINDS; " +
        "regenerate the file's `kinds` from that export",
    );
  }
  // The TEAM's own kinds first, then the file's, which is the order `--init` uses and not an
  // arbitrary one: the standard member grants are scoped to `{team}`, so `task`, `note`,
  // `artifact`, `capability` and `workspace` must carry that indexed path before any member is
  // minted or the grant pattern does not compile.
  await declareTeamKinds(operator);
  const live = await liveKinds(operator);
  for (const k of file.kinds) await declareKind(operator, k, live);

  const tokens = new Map<string, string>();
  for (const m of file.members) {
    const agent = `agent:${m.name}`;
    const prior = await readDefinition(operator, agent);
    const member = await addMember(operator, agent, {
      teams: [file.team],
      supersedes: prior.id,
      extra: (m.grants ?? []).map(grantOf),
    });
    tokens.set(agent, member.definitionToken);
  }
  return { team: file.team, declared: file.kinds.length, tokens };
}
