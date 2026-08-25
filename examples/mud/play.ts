// A terminal client: type a line, read the room.
//
//   deno run -A examples/mud/play.ts --url http://127.0.0.1:7788 --as agent:mud-alice --token <def>
//
// It writes ONE kind (`command`) and reads three. Everything else a player sees is somebody else's
// record: the narrator's, or an NPC's. That asymmetry is the design, not an accident of this file.
//
// A TICK, NOT A STREAM. Phase 2's page has a hard six-connections-per-origin budget and will do the
// same thing (agent_docs/plan-mud.md), so the terminal uses the shape the page has to use rather
// than a nicer one it cannot share. The cursor is a RECORD ID: ids are globally ordered, so it
// survives walking into another room without being reset, and a room change is nothing more than
// asking a different pattern with the same cursor.

import { RadiaClient, type RadiaRecord } from "../../sdk/ts/client.ts";
import { WORLD_ID } from "./kinds.ts";
import { type EventBody, recentEvents, tailEvents } from "./feed.ts";

const arg = (n: string) => {
  const i = Deno.args.indexOf(n);
  return i >= 0 ? Deno.args[i + 1] : undefined;
};

const url = arg("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const token = arg("--token");
const me = arg("--as");
const worldId = arg("--world") ?? WORLD_ID;
if (!token || !me) throw new Error("usage: play.ts --as <principal> --token <definition token> [--url …]");

const client = new RadiaClient(url, { definitionToken: token });
let roomId: string | null = null;
let cursor = "";
let running = true;

/** Where this player is, from `presence` and never from anything this process remembers. */
async function locate(): Promise<string | null> {
  const rows = await client.queryNewest({ kind: "presence", match: { worldId, actor: me } }, 1);
  return rows.length ? (rows[0].body as { roomId: string }).roomId : null;
}

function show(record: RadiaRecord): void {
  const body = record.body as EventBody;
  // `audience` is a display convention, so this filter is the only thing honouring it. The space
  // would happily serve the whole world's feed; see roles.ts on why fog of war is not a grant.
  if (body.audience !== "room" && body.audience !== me) return;
  console.log(body.text);
}

async function pump(): Promise<void> {
  // A command is claimed by the narrator, so a player whose narrator is down, or is nacking, sees
  // NOTHING: they type, the record lands, and no line ever comes back. Silence is the worst
  // available failure here, so say so once rather than letting them keep typing into it.
  let quiet = 0;
  while (running) {
    try {
      const here = await locate();
      if (!here && ++quiet === 30) {
        console.error(
          "(nothing is narrating: the space took the command and no `presence` came back. " +
            "Check the terminal running `deno task mud` for nacks.)",
        );
      }
      if (here) {
        if (!roomId && !cursor) {
          // Joining: show the tail of the room rather than its whole history, the same rule the
          // console's Feed follows.
          const seed = await recentEvents(client, worldId, here, 20);
          for (const r of seed) show(r);
          cursor = seed.length ? seed[seed.length - 1].id : cursor;
        } else {
          for (const r of await tailEvents(client, worldId, here, cursor)) {
            show(r);
            cursor = r.id;
          }
        }
        roomId = here;
      }
    } catch (e) {
      console.error(`(the space said: ${e instanceof Error ? e.message : e})`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function send(text: string): Promise<void> {
  await client.put({ kind: "command", body: { worldId, actor: me, text } });
}

console.log(`You are ${me}. Type 'help', or '/quit' to leave.\n`);
pump();
// The world places a newcomer on their first command, so this is also the join.
await send("look");

let buffer = "";
for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line === "/quit") {
      running = false;
      Deno.exit(0);
    }
    if (line) await send(line).catch((e) => console.error(`(refused: ${e instanceof Error ? e.message : e})`));
  }
}
running = false;
