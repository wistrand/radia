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

import {
  CLASSIFY_MODEL,
  EXEC_TIMEOUT_MS,
  execRoots,
  IMAGE_MODEL,
  port,
  spaceDb,
  TIERS,
  toolRoots,
  url,
  VISION_MEDIA_TYPES,
  VISION_MODEL,
} from "./config.ts";
import type { Bootstrapped } from "../space/roles.ts";
import { dim, notice } from "./terminal.ts";

const local = `http://127.0.0.1:${port}`;

/**
 * Start a worker, and OWN its stderr rather than letting it inherit ours.
 *
 * Inherited, a worker writing at the wrong moment landed in the middle of a streamed answer, at
 * whatever column it had reached, with nothing saying which process produced it. Piped, each line is
 * labelled and goes through `notice`, so it waits for the line to be idle. A worker that dies at
 * boot still gets its message out; it simply arrives at the next prompt.
 */
function spawn(name: string, args: string[]): Deno.ChildProcess {
  const proc = new Deno.Command("deno", { args: ["run", ...args], stdout: "null", stderr: "piped", stdin: "null" }).spawn();
  (async () => {
    // Read to exhaustion whatever happens: an unread pipe fills and then BLOCKS the worker, which
    // would turn a chatty process into a hung one.
    const dec = new TextDecoder();
    let rest = "";
    for await (const chunk of proc.stderr) {
      rest += dec.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) notice(dim(`[${name}] ${line}`));
    }
    if (rest.trim()) notice(dim(`[${name}] ${rest}`));
  })().catch(() => {/* the worker is gone; nothing left to forward */});
  return proc;
}

/**
 * Start every worker; returns the processes so the caller can kill them on exit.
 *
 * `sessionToken` is REQUIRED, and it is the session's own credential rather than anything minted
 * here. The tools-worker runs the `space_*` verbs under it, so a scoped session cannot launder /ops
 * access through a worker that happens to hold more. It used to be optional, which meant the
 * privileged path was the one you got by not passing it.
 */
/** Where materialised workspace trees live for the life of this chat. One directory, created here
 *  so the exec worker's write grant can name it exactly. */
export const workspaceRoot = Deno.makeTempDirSync({ prefix: "radia-ws-" });

/** The agents this launcher starts, and therefore the ones whose advertisements it withdraws on the
 *  way out. Named here rather than derived from the processes, because a worker that died still has
 *  a `capability` record standing and is exactly the one worth retiring. */
export const FLEET_PROVIDERS = [
  "agent:chat-tools",
  "agent:chat-exec",
  "agent:chat-images",
  "agent:chat-inference",
];

export function launchFleet(tokens: Bootstrapped, sessionToken: string): Deno.ChildProcess[] {
  const { inferenceToken, routerToken, toolsToken, imagesToken, execToken } = tokens;
  const procs: Deno.ChildProcess[] = [];

  // One inference-worker per tier, all the same agent: each claims only `{llm_call, tier}` and
  // serves its model. Rank follows insertion order (cheap → capable) and drives escalation.
  let rank = 0;
  for (const [tier, model] of Object.entries(TIERS)) {
    procs.push(spawn(`inference:${tier}`, [
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
  procs.push(spawn("router", [
    "--allow-net",
    "--allow-env",
    "examples/chat/workers/router.ts",
    "--url", url,
    "--token", routerToken,
    "--classify-model", CLASSIFY_MODEL,
  ]));

  // Images: same privilege shape as inference (key + egress, no files). Draws (storing its output as
  // an artifact and returning a reference) and reads (fetching an artifact and asking a vision
  // model). One process, because both halves want exactly the API key and the network and nothing else.
  procs.push(spawn("images", [
    "--allow-net",
    "--allow-env",
    "examples/chat/workers/images.ts",
    "--url", url,
    "--token", imagesToken,
    "--model", IMAGE_MODEL,
    "--vision-model", VISION_MODEL,
    "--vision-types", VISION_MEDIA_TYPES.join(","),
  ]));

  // Tools: reads only the sandbox dirs, reaches only the local space, and gets NO env. Its space_*
  // tools act as the SESSION principal (--session-token) so a scoped user cannot launder /ops
  // access through a privileged worker.
  procs.push(spawn("tools", [
    `--allow-net=127.0.0.1:${port}`,
    `--allow-read=${toolRoots.join(",")}`,
    "examples/chat/workers/tools.ts",
    "--url", local,
    "--token", toolsToken,
    "--session-token", sessionToken,
    ...toolRoots.flatMap((r) => ["--dir", r]),
  ]));

  // Exec: may spawn `deno` and `bwrap` and reach the space, nothing else. The child it spawns gets no
  // permissions at all (extensions/ts/sandbox.ts), so the dangerous half of the pair holds no credential.
  //
  // TWO NAMES, because a language is a capability name and each one has its own jail: `deno` runs
  // `run_javascript`, `bwrap` runs `run_python`. Naming both is not the same as granting both, since
  // the worker PROBES each jail at boot and publishes nothing for one that fails. On a host without
  // bubblewrap the permission is simply unused and Python is absent, which is the honest outcome.
  // Listing the binaries rather than passing a bare `--allow-run` matters: bare means ANY executable,
  // and the whole point of this process is that it can start two specific jails and nothing else.
  //
  // WORKSPACE ROOT. Materialising a tree means the WORKER writes files, which it previously could
  // not do at all, so this is a real capability increase and it is scoped to one directory created
  // here rather than granted broadly. It lives in the OS temp area on purpose: the sandbox child is
  // handed `--deny-read` on `.radia` (it holds the KEK and the database), and a deny beats an
  // allow in Deno, so a tree materialised under the runtime directory would be unreadable by the
  // very process meant to read it.
  procs.push(spawn("exec", [
    `--allow-net=127.0.0.1:${port}`,
    "--allow-run=deno,bwrap",
    "--allow-env=HOME", // only to give the sandboxed child a module-cache home
    `--allow-write=${workspaceRoot}`,
    `--allow-read=${workspaceRoot}`, // to read back what it just wrote, and nothing else
    "examples/chat/workers/exec.ts",
    "--workspace-root", workspaceRoot,
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
