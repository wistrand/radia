// The turn worker: one process running the conversation chain (extensions/ts/turn.ts).
//
// Everything here is launch. The chain itself is an extension, because "an LLM turn as records" is
// a convention any agent app wants and this app has no special claim on it.

import { RadiaClient } from "../../../sdk/ts/client.ts";
import { runTurnWorker } from "../../../extensions/ts/turn.ts";
import { arg } from "../util.ts";

const url = arg("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const token = arg("--token");
const maxRounds = Number(arg("--max-rounds") ?? "8");

const client = new RadiaClient(url, token ? { definitionToken: token } : {});
console.error(`[turn] watching messages on ${url} (max ${maxRounds} rounds)`);
await runTurnWorker(client, { maxRounds });
