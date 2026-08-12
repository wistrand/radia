// The turn worker: one process running the conversation chain (extensions/ts/turn.ts).
//
// Everything here is launch. The chain itself is an extension, because "an LLM turn as records" is
// a convention any agent app wants and this app has no special claim on it.

import { RadiaClient } from "../../../sdk/ts/client.ts";
import { runTurnWorker } from "../../../extensions/ts/turn.ts";
import { arg } from "../util.ts";

// No env fallback, deliberately: the fleet runs this worker with a port and nothing else (no
// `--allow-env`), so reading the environment here is a NotCapable crash rather than a default.
// It survived only because `--url` is always passed and `??` short-circuits before reaching it.
// Same shape as the tools worker, and pinned by smoke-fleet.ts.
const url = arg("--url") ?? "http://127.0.0.1:7788";
const token = arg("--token");
const maxRounds = Number(arg("--max-rounds") ?? "8");

const client = new RadiaClient(url, token ? { definitionToken: token } : {});
// No `[turn]` prefix: the launcher labels every line it forwards (`spawn`, client/fleet.ts), so
// self-labelling printed "[turn] [turn] watching messages".
console.error(`watching messages on ${url} (max ${maxRounds} rounds)`);
// `delegate`: the chat's exec worker holds its session-data grants under `delegable:agent:chat-exec`
// (space/roles.ts), so the record it claims has to name the person it is serving. That name comes
// from the run this worker emits under, never from the body.
await runTurnWorker(client, { maxRounds, delegate: true });
