// A fresh URL for a song that has already been rendered.
//
//   deno run -A examples/teams/song-creator/share.ts --workspace song-btfhd0gk
//   deno run -A examples/teams/song-creator/share.ts            # the newest song on the space
//
// The producer puts a URL on the final note, but a capability lives in the space's MEMORY and lasts
// `downloadCapabilitySeconds` (300 by default), so that link is dead within minutes and gone for
// good if the space restarted. The tree itself is permanent, so a new link is always one mint away.
//
// The URL carries no credential and needs none: every artifact in the tree was checked against the
// minting caller's read grant once, here. Treat it as the secret, since anyone holding it can open
// the song until it expires.

import { RadiaClient } from "../../../sdk/ts/client.ts";
import { resolveToken } from "../../../src/credentials.ts";
import { TEAM_FIELD } from "../../../extensions/ts/team.ts";
import { listWorkspaces, readWorkspace } from "../../../extensions/ts/workspace.ts";

const flag = (n: string) => {
  const i = Deno.args.indexOf(n);
  return i >= 0 ? Deno.args[i + 1] : undefined;
};

const url = flag("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const team = flag("--team") ?? "song-creator";
const scope = { [TEAM_FIELD]: team };
const token = Deno.env.get("RADIA_TOKEN") ?? resolveToken(url);
if (!token) {
  console.error(`share: no credential for ${url}. Start a space with \`radia dev\`, or set RADIA_TOKEN.`);
  Deno.exit(1);
}
const client = new RadiaClient(url, { token });

let name = flag("--workspace");
if (!name) {
  // The newest song, so the common case needs no id. `listWorkspaces` reports whether it saw the
  // whole set; a truncated listing could hide the newest, so say so rather than pick from a page.
  const all = await listWorkspaces(client);
  if (!all.complete) console.error("share: the workspace listing was truncated; naming --workspace is safer");
  // Sorted by RECORD ID, which is a ULID and therefore ordered by write time. The listing is a map's
  // values and carries no order of its own, so "the last one" would be whatever it happened to be.
  const songs = all.workspaces
    .filter((w) => w.name.startsWith("song-") && (w as unknown as Record<string, unknown>)[TEAM_FIELD] === team)
    .sort((a, b) => (a.id < b.id ? 1 : -1));
  if (songs.length === 0) {
    console.error(`share: no song-* workspace in team ${team}. Run the team first, or pass --team.`);
    Deno.exit(1);
  }
  name = songs[0].name;
}

const ws = await readWorkspace(client, name, undefined, scope);
if (!ws) {
  console.error(`share: no workspace ${name} in team ${team}`);
  Deno.exit(1);
}

const cap = await client.pathCapability(ws.files.map((f) => ({ path: f.path, artifactId: f.artifactId })));
console.log(cap.url);
console.error(`${name}: ${ws.files.length} files, link expires ${cap.expiresAt}`);
