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
  EXEC_CONCURRENCY,
  LOCAL_CONCURRENCY,
  PROVIDER_CONCURRENCY,
} from "./config.ts";
import type { Bootstrapped } from "../space/roles.ts";
import type { FleetKeyPair } from "../../../extensions/ts/encrypted.ts";
import { dim, notice } from "./terminal.ts";
import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { retireProviderCapabilities } from "../../../extensions/ts/capability.ts";
import { announcePresence, retireIfLast, retirePresence } from "../../../extensions/ts/presence.ts";
import { FLEET_PRESENCE } from "../space/kinds.ts";

const local = `http://127.0.0.1:${port}`;

/** Drop a worker's own leading `[label] ` from a forwarded line. The SDK loop labels its failures
 *  so a STANDALONE worker's stderr is attributable; under this launcher every line gets the
 *  launcher's label anyway, and `[inference:ultra] [inference:ultra] take error` is one fact
 *  printed twice. Only a short leading bracket group is touched. */
const unlabel = (line: string) => line.replace(/^\[[^\]\n]{1,48}\] /, "");

/**
 * Start a worker, and OWN its stderr rather than letting it inherit ours.
 *
 * Inherited, a worker writing at the wrong moment landed in the middle of a streamed answer, at
 * whatever column it had reached, with nothing saying which process produced it. Piped, each line is
 * labelled and goes through `notice`, so it waits for the line to be idle. A worker that dies at
 * boot still gets its message out; it simply arrives at the next prompt.
 */
function spawn(name: string, args: string[], env?: Record<string, string>): Deno.ChildProcess {
  const proc = new Deno.Command("deno", {
    // `--presence` is passed to every worker this launcher starts, and only here, because it is a
    // claim about the LAUNCHER: these processes are covered by the beats `announceFleet` writes, so
    // their advertisements may be judged stale once the beats stop. A worker started by hand is not
    // covered and must not claim it, which is why this is not a default inside the worker.
    args: ["run", ...args, "--presence"],
    ...(env ? { env } : {}),
    stdout: "null",
    stderr: "piped",
    stdin: "null",
  }).spawn();
  (async () => {
    // Read to exhaustion whatever happens: an unread pipe fills and then BLOCKS the worker, which
    // would turn a chatty process into a hung one.
    const dec = new TextDecoder();
    let rest = "";
    for await (const chunk of proc.stderr) {
      rest += dec.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) notice(dim(`[${name}] ${unlabel(line)}`));
    }
    if (rest.trim()) notice(dim(`[${name}] ${unlabel(rest)}`));
  })().catch(() => {/* the worker is gone; nothing left to forward */});
  return proc;
}

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

/**
 * Start every worker; returns the processes so the caller can kill them on exit.
 *
 * NO SESSION CREDENTIAL travels here any more. The tools worker used to be handed the person's own
 * token so its `space_*` verbs ran as them, which is what kept a fleet to one user: those verbs now
 * run in the REPL process (client/session-tools.ts), and a worker that needs a caller's reach mints
 * a delegated run for it. Nothing this launcher starts is bound to one person.
 */
export function launchFleet(tokens: Bootstrapped, fleetKey?: FleetKeyPair): Deno.ChildProcess[] {
  const { inferenceToken, routerToken, toolsToken, imagesToken, execToken, turnToken } = tokens;
  const procs: Deno.ChildProcess[] = [];
  // The fleet's private half reaches its workers through the ENVIRONMENT, not through the file it
  // lives in. Every one of them is spawned with a deliberately narrow permission set — inference has
  // no filesystem at all, the exec worker sees only its jail root — so a read of the key file is a
  // permission none of them has, and `fleetKeyPair` cannot tell "denied" from "absent", so the
  // failure was silent: the worker simply served no encrypted conversation. Passing the value keeps
  // those permission sets intact.
  //
  // WHO GETS IT is the blast radius of the accepted gap ("the fleet can read everything"): every
  // worker that must read prose to do its job — inference to call a provider, tools and images to
  // act on arguments, exec to run and judge code. The router and the turn worker are NOT on the
  // list and must not be: they route an encrypted conversation without ever opening one.
  // Absent when no key was generated, which is every plaintext-only deployment.
  const keyEnv = fleetKey ? { RADIA_CHAT_FLEET_KEY: btoa(JSON.stringify(fleetKey)) } : undefined;

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
      "--concurrency", String(PROVIDER_CONCURRENCY),
    ], keyEnv));
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
    "--concurrency", String(LOCAL_CONCURRENCY),
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
  ], keyEnv));

  // Tools: reads only the sandbox dirs, reaches only the local space, and ONE variable. It holds NO
  // session credential: the `space_*` tools moved into the REPL process (client/session-tools.ts),
  // and anything that reads a caller's data mints a delegated run per caller. That is what makes
  // this worker shareable between people rather than launched per person.
  procs.push(spawn("tools", [
    `--allow-net=127.0.0.1:${port}`,
    `--allow-read=${toolRoots.join(",")}`,
    // A tool ACTS on its arguments, so this worker opens them, and the key arrives in `keyEnv`
    // below. Named individually: it had no env access at all, and passing the value without the
    // permission is silent — the read throws, `fleetKeyPair` reports "no key", and every encrypted
    // tool call is refused with an answer that names encryption rather than the missing flag.
    "--allow-env=RADIA_CHAT_FLEET_KEY",
    "examples/chat/workers/tools.ts",
    "--url", local,
    "--token", toolsToken,
    "--concurrency", String(LOCAL_CONCURRENCY),
    ...toolRoots.flatMap((r) => ["--dir", r]),
  ], keyEnv));

  // Exec: may spawn `deno` and `bwrap` and reach the space, nothing else. The child it spawns gets no
  // permissions at all (extensions/ts/sandbox.ts), so the dangerous half of the pair holds no credential.
  //
  // THREE NAMES. Two are jails, because a language is a capability name and each one has its own:
  // `deno` runs `run_javascript`, `bwrap` runs `run_python`. The third is `mkfifo`, which is not a
  // jail: rehearsing an entrypoint goes through the BROKER, whose channel is a pipe pair on the
  // filesystem, and there is no Deno API for making one. That cost was accepted deliberately over a
  // unix socket, which would have needed `--allow-net` in the JAIL rather than one coreutils binary
  // out here (extensions/ts/broker.ts). Naming both jails is not the same as granting both, since
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
  // The TURN worker: the conversation's loop. It writes the next link and nothing else, so it needs
  // no key, no files and no ability to run anything (agent_docs/plan-chat-turn.md).
  procs.push(spawn("turn", [
    `--allow-net=127.0.0.1:${port}`,
    "examples/chat/workers/turn.ts",
    "--url",
    local,
    "--token",
    turnToken,
  ]));

  procs.push(spawn("exec", [
    `--allow-net=127.0.0.1:${port}`,
    "--allow-run=deno,bwrap,mkfifo",
    // HOME gives the sandboxed child a module-cache home; the fleet key is how this worker opens the
    // arguments it runs and seals the verdict it writes (plan-encryption.md phase 4). PATH is read
    // only by a COMPILED build, where `Deno.execPath()` is the binary itself and the jail's runtime
    // has to be found (`denoRuntime`, extensions/ts/sandbox.ts); from source the lookup never runs,
    // and the guard is a static scan that cannot know that. Named individually rather than
    // `--allow-env`, because this is the worker that spawns a jail.
    "--allow-env=HOME,PATH,RADIA_CHAT_FLEET_KEY",
    `--allow-write=${workspaceRoot}`,
    `--allow-read=${workspaceRoot}`, // to read back what it just wrote, and nothing else
    "examples/chat/workers/exec.ts",
    "--workspace-root", workspaceRoot,
    "--url", local,
    "--token", execToken,
    "--timeout-ms", EXEC_TIMEOUT_MS,
    "--concurrency", String(EXEC_CONCURRENCY),
    ...execRoots.flatMap((r) => ["--dir", r]),
    // Forwarded, not decided here: whether an unconfined jail is acceptable is the operator's call,
    // and the worker is the only thing that can find out whether a confiner holds. With this set
    // and no confiner, the worker refuses to serve rather than running code in a jail that does not
    // bound module loading.
    ...(Deno.env.get("RADIA_CHAT_REQUIRE_CONFINEMENT") ? ["--require-confinement"] : []),
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
  ], keyEnv));

  return procs;
}

/**
 * Start the web UI beside the fleet (`--serve --web`, agent_docs/plan-chat-web-ui.md).
 *
 * A SEPARATE PROCESS rather than a listener inside this one, and that is the whole reason it lives
 * here with the other spawns: `--serve` holds the operator credential, and the process bound to a
 * port should not be the process holding the credential that can do anything on the space.
 *
 * Its permissions are the narrowest of anything this launcher starts: reach the network, read one
 * directory. No `--allow-env`, so it cannot pick up a token from the environment even by accident.
 */
export function launchWebUi(webPort: number, host = "127.0.0.1"): Deno.ChildProcess {
  // The page's script is a BUILD OUTPUT (gitignored), so a fresh checkout has none and the page
  // would load into a message about a missing bundle. Built here, before the server starts, because
  // "one URL and one click" cannot have a build step in front of it. 20ms, and it also means
  // editing the browser client and restarting is the whole edit loop.
  const built = new Deno.Command("deno", {
    args: ["bundle", "--minify", "-o", "examples/chat/web/app.js", "examples/chat/web/app.ts"],
    stdout: "null",
    stderr: "piped",
  }).outputSync();
  if (!built.success) {
    notice(dim(`[web] the UI bundle failed to build:\n${new TextDecoder().decode(built.stderr).trim()}`));
  }
  return spawn("web", [
    "--allow-net",
    "--allow-read=examples/chat/web",
    "examples/chat/web/serve.ts",
    "--url",
    url,
    "--port",
    String(webPort),
    "--host",
    host,
  ]);
}

// ---------------------------------------------------------------------------
// Which fleet is still serving
// ---------------------------------------------------------------------------
//
// An advertisement is keyed by (provider, tool) and therefore SHARED: two fleets on one space
// publish one record, not one each. So withdrawal cannot be "retire what I published" — there is no
// such thing — and a fleet exiting used to retire the lot, taking `share_artifact`, `save_content`
// and every file tool off the tool list of a fleet that was still running. Nothing republishes
// after that, because an unchanged definition re-published over a tombstone replays its own key and
// dedups (`publishCapability` in extensions/ts/capability.ts).
//
// So the rule is LAST ONE OUT withdraws, and it is `extensions/ts/presence.ts` now rather than a
// projection written here: a launcher beats while it lives, retires on the way out, and the
// withdrawal runs only when no other launcher is inside the TTL. Two fleets exiting at the same
// instant can both see the other and skip it, which leaves advertisements standing with nobody
// serving — the same state a crash already produces, and the one the doc on
// `retireProviderCapabilities` already tells callers to expect. It fails toward leaving a stale
// advertisement rather than removing a live one, which is the side to fail on: a stale one costs a
// failed tool call, a wrongly withdrawn one makes a working tool invisible until its definition
// changes.
//
// The SUBJECT is the fleet as a whole, because the thing being withdrawn is: an advertisement is
// keyed by (provider, tool) and belongs to no launcher.

const FLEET_SUBJECT = "fleet";

/** Say this launcher is running, and keep saying it until `signal` aborts. Returns the fleet id to
 *  hand back to `retireFleetAdvertisements`.
 *
 *  AWAITS the first beat, which the hand-rolled version did not: a fleet that has not landed its
 *  first record yet is invisible to another fleet's withdrawal check, and the window for that was
 *  every startup rather than a rare race.
 *
 *  TWO KINDS OF SUBJECT, answering two questions that happen to correlate here and are not the same
 *  question. `fleet` is "is a launcher running", which is what decides the withdrawal below. Each
 *  PROVIDER is "is this worker's tools served by anything", which is what lets a session drop a
 *  dead fleet's advertisements without waiting for a withdrawal that a crash never performs
 *  (`liveAdvertisements`). One instance id beats on all of them, so a launcher is one row of the
 *  answer to both. */
export async function announceFleet(admin: RadiaClient, signal: AbortSignal): Promise<string> {
  const onError = (e: unknown) => notice(dim(`[fleet] could not record this fleet as running: ${e}`));
  const handle = await announcePresence(admin, FLEET_PRESENCE, FLEET_SUBJECT, { signal, onError });
  for (const provider of FLEET_PROVIDERS) {
    await announcePresence(admin, FLEET_PRESENCE, provider, { instance: handle.instance, signal, onError });
  }
  return handle.instance;
}

/** Withdraw this launcher's presence, then the fleet's advertisements IF nobody else is serving. */
export async function retireFleetAdvertisements(admin: RadiaClient, fleetId: string): Promise<void> {
  // Stop counting for each PROVIDER first. Letting the beats simply lapse would leave those subjects
  // reading live for the whole TTL, and the withdrawal below is best-effort: if it fails, sessions
  // would go on offering tools this fleet no longer serves for fifteen minutes rather than at once.
  // Safe while another fleet runs, since a subject is live if ANY instance beats for it and this
  // retires only ours.
  await Promise.all(
    FLEET_PROVIDERS.map((subject) =>
      retirePresence(admin, FLEET_PRESENCE, { subject, instance: fleetId })
        .catch(() => {/* best effort: shutdown must not fail over a tombstone */})
    ),
  );
  const result = await retireIfLast(
    admin,
    FLEET_PRESENCE,
    { subject: FLEET_SUBJECT, instance: fleetId },
    async () => {
      await retireProviderCapabilities(admin, FLEET_PROVIDERS);
    },
  );
  if (result.withdrew) return;
  // The two declines read differently to whoever is watching a terminal: one is the ordinary case,
  // the other means this process could not tell and left the advertisements up on that basis.
  const n = result.others.length;
  notice(dim(
    result.complete
      ? `[fleet] ${n} other fleet${n === 1 ? "" : "s"} still serving: leaving the tool advertisements up`
      : `[fleet] could not read the whole fleet list: leaving the tool advertisements up`,
  ));
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
