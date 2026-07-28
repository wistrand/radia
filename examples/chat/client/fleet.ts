// Launching the workers, and the permission set each one gets.
//
// This is the security story of the example, so it is one file you can read top to bottom. Why
// subprocesses at all: permission isolation only holds ACROSS processes, so the rule is that no
// two dangerous capabilities meet in one of them.
//
//   inference ×3   net + env   holds OPENROUTER_API_KEY          no file access
//   router         net + env   holds nothing                     never calls a model directly
//   images         net + env   holds OPENROUTER_API_KEY          no file access
//   tools          local net + read(sandbox dirs)                NO env, so no secrets
//   exec           local net + run(deno) + env(HOME)             holds a run token, never executes
//     └─ sandbox   nothing (optionally read of exec dirs)        spawned per call, no credential
//
// The two that carry the argument: the process that can read files cannot reach the network beyond
// the local space, so reading a file cannot lead to exfiltrating it; and the process that runs
// model-written code holds no credential at all, so compromising it yields a process that can
// print bytes to its parent.
//
// Tokens travel as argv, which `ps` can see. Fine for a local demo, wrong for a deployment: a
// real one would use a secret channel.

import { CLASSIFY_MODEL, EXEC_TIMEOUT_MS, execRoots, IMAGE_MODEL, port, spaceDb, TIERS, toolRoots, url } from "./config.ts";
import type { Bootstrapped } from "../space/roles.ts";

const local = `http://127.0.0.1:${port}`;

function spawn(args: string[]): Deno.ChildProcess {
  return new Deno.Command("deno", { args: ["run", ...args], stdout: "null", stderr: "inherit", stdin: "null" }).spawn();
}

/**
 * Start every worker; returns the processes so the caller can kill them on exit.
 *
 * `sessionToken` is REQUIRED, and it is the session's own credential rather than anything minted
 * here. The tools-worker runs the `space_*` verbs under it, so a scoped session cannot launder /ops
 * access through a worker that happens to hold more. It used to be optional, which meant the
 * privileged path was the one you got by not passing it.
 */
export function launchFleet(tokens: Bootstrapped, sessionToken: string): Deno.ChildProcess[] {
  const { inferenceToken, routerToken, toolsToken, imagesToken, execToken } = tokens;
  const procs: Deno.ChildProcess[] = [];

  // One inference-worker per tier, all the same agent: each claims only `{llm_call, tier}` and
  // serves its model. Rank follows insertion order (cheap → capable) and drives escalation.
  let rank = 0;
  for (const [tier, model] of Object.entries(TIERS)) {
    procs.push(spawn([
      "--allow-net",
      "--allow-env",
      "examples/chat/workers/inference.ts",
      "--url", url,
      "--token", inferenceToken,
      "--tier", tier,
      "--model", model,
      "--rank", String(rank++),
    ]));
  }

  // Router: claims UNTIERED calls, classifies, re-dispatches. Holds no key, because its classifier
  // is itself an `llm_call` served by the fleet.
  procs.push(spawn([
    "--allow-net",
    "--allow-env",
    "examples/chat/workers/router.ts",
    "--url", url,
    "--token", routerToken,
    "--classify-model", CLASSIFY_MODEL,
  ]));

  // Images: same privilege shape as inference (key + egress, no files). Stores its output as an
  // artifact and returns a reference.
  procs.push(spawn([
    "--allow-net",
    "--allow-env",
    "examples/chat/workers/images.ts",
    "--url", url,
    "--token", imagesToken,
    "--model", IMAGE_MODEL,
  ]));

  // Tools: reads only the sandbox dirs, reaches only the local space, and gets NO env. Its space_*
  // tools act as the SESSION principal (--session-token) so a scoped user cannot launder /ops
  // access through a privileged worker.
  procs.push(spawn([
    `--allow-net=127.0.0.1:${port}`,
    `--allow-read=${toolRoots.join(",")}`,
    "examples/chat/workers/tools.ts",
    "--url", local,
    "--token", toolsToken,
    "--session-token", sessionToken,
    ...toolRoots.flatMap((r) => ["--dir", r]),
  ]));

  // Exec: may spawn `deno` and reach the space, nothing else. The child it spawns gets no
  // permissions at all (tools/exec-sandbox.ts), so the dangerous half of the pair holds no credential.
  procs.push(spawn([
    `--allow-net=127.0.0.1:${port}`,
    "--allow-run=deno",
    "--allow-env=HOME", // only to give the sandboxed child a module-cache home
    "examples/chat/workers/exec.ts",
    "--url", local,
    "--token", execToken,
    "--timeout-ms", EXEC_TIMEOUT_MS,
    ...execRoots.flatMap((r) => ["--dir", r]),
    // Never readable, whatever the roots say. One entry covers the lot now that a space writes to a
    // single directory: the KEK decrypts every artifact, and the database beside it holds the whole
    // conversation. The per-user credential file is a separate `.radia` under HOME.
    // `--deny-read` beats `--allow-read` in Deno.
    ...(execRoots.length
      ? [
        "--deny-dir",
        `${Deno.cwd()}/${Deno.env.get("RADIA_DIR") ?? ".radia"}`,
        "--deny-dir",
        `${Deno.env.get("HOME")}/.radia`,
      ]
      : []),
  ]));

  return procs;
}

/** Start a space of our own when none is running. */
export function spawnSpace(): Deno.ChildProcess {
  return new Deno.Command("deno", {
    // `--db` is what makes a restart resumable at all: without it the space is in-memory and the
    // conversation, its saved procedures and its artifacts die with the process.
    args: [
      "run",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "src/main.ts",
      "dev",
      "--port",
      port,
      "--storage",
      "sqlite",
      "--db",
      spaceDb,
    ],
    stdout: "null",
    stderr: "null",
    stdin: "null",
  }).spawn();
}
