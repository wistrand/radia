// CLI chatbot: pure record I/O. It makes NO external calls; it only reads and writes records.
// Thinking (`llm_call` → the assistant `message`, streamed as `llm_chunk`), acting (`tool_call` →
// `tool_result`), drawing, code execution and saved files all flow through the space, served by
// workers this launches as scoped subprocesses. Watch the whole loop in the console's Feed tab.
//
//   OPENROUTER_API_KEY=... deno task chat
//
// The map. Five areas, each answering one question:
//
//   chat.ts       this file: bootstrap, launch, banner, the REPL loop
//   util.ts       worker argument parsing and artifact media helpers
//
//   client/       what the REPL itself does
//     config.ts     everything read from the environment (setup, never per-turn behaviour)
//     fleet.ts      launching the workers, and the permission set each one gets
//     thread.ts     the conversation as `message` records on the space
//     turn.ts       one user turn: llm_call → tools → answer, plus tool discovery
//     waiting.ts    watch-driven wakeups, progress rendering, stall diagnosis
//     terminal.ts   everything drawn to the screen, and the one consumer of stdin
//     edit.ts       what a keystroke means and what the line looks like after it (no I/O)
//     markdown.ts   the answer rendered while it streams
//
//   workers/      the five agent processes, each with its own identity and grants
//     inference.ts · router.ts · tools.ts · images.ts · exec.ts
//
//   tools/        what those workers actually do
//     files.ts (sandboxed file + compute) · space.ts (inspect + remediate)
//     save.ts (store content); the sandbox itself is extensions/ts/sandbox.ts
//     workers/exec.ts also serves save_procedure/read_procedure: named, reusable programs
//
//   space/        how this app uses Radia
//     kinds.ts (record kinds, incl. `procedure`) · roles.ts (grants + run tokens)
//     capability.ts (advertising a tool) · progress.ts (turn progress as records)
//
//   provider/     the outside world
//     openrouter.ts (chat completions) · imagegen.ts (image generation)
//     vision.ts (reading an image or a PDF)
//     context.ts (thread records → provider payload; pure, and where the context bugs live)

import { RadiaClient } from "../../sdk/ts/client.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { assignUserGrants, bootstrap, setSessionOwner } from "./space/roles.ts";
import { watchAutoGrants } from "./space/auto-grant.ts";
import {
  CONVERSATION_KEY_KIND,
  ConversationErasedError,
  conversationKeys,
  currentFleetKey,
  fleetKeyPair,
  livePersonKeys,
  personKeyPair,
  publishPersonKey,
  publishFleetKey,
  writeConversationKey,
} from "./space/keys.ts";
import { type ConversationKey, NoConversationKeyError, sealConversation } from "../../extensions/ts/encrypted.ts";
import { apiKey, encryptMode, EXEC_TIMEOUT_MS, execRoots, loginDefinitionToken, loginSource, loginToken, operatorToken, resume, scopeMode, spaceDb, TIERS, toolRoots, url } from "./client/config.ts";
import { announceFleet, launchFleet, launchWebUi, retireFleetAdvertisements, spawnSpace } from "./client/fleet.ts";
import { denoSandbox } from "../../extensions/ts/sandbox.ts";
import { declareSandbox } from "../../extensions/ts/sandbox-registry.ts";
import { ToolSet } from "./client/turn.ts";
import { SESSION_TOOL_SCHEMAS, serveSessionTools } from "./client/session-tools.ts";
import { Thread } from "./client/thread.ts";
import { cancelTurn, runTurn, TurnCancelled } from "./client/turn.ts";
import { watchWakeups } from "./client/waiting.ts";
import { liveView } from "./client/live.ts";
import { dim, endStatus, holdLine, lineReader, notice, releaseTerminal, showStatus, terminalUI, tty, watchCancel, write } from "./client/terminal.ts";
import { installUI } from "./client/ui.ts";
import { reviewGrantRequests } from "./client/grants.ts";
import { clipboardReader, missingClipboardTool, readClipboard } from "./client/clipboard.ts";
import { staging } from "./client/attachments.ts";
import { attachArtifact } from "./client/attach.ts";
import { arg, mediaTypeFor } from "./util.ts";
import { sleep } from "./util.ts";

// This process draws on a terminal, so it says so before anything can draw. The protocol half
// (turn/waiting/grants) reaches its surface through client/ui.ts and no longer knows what a
// terminal is; installing is the one thing that decides which front end this is.
installUI(terminalUI);

// The key belongs to whoever LAUNCHES THE FLEET, because the inference and image workers are the
// only processes that call a provider. A joining session starts no workers, so demanding one of it
// would be asking every person for a credential they never use — and asking them to hold a shared
// secret is the opposite of what the deployment split is for. Checked against the same condition
// that decides whether this process launches anything (an operator credential is present).
if (!apiKey && operatorToken()) {
  console.error("Set OPENROUTER_API_KEY (get one at https://openrouter.ai/keys).");
  console.error("  It is needed HERE because this process starts the workers that call the provider.");
  console.error("  A session joining a fleet somebody else started needs no key.");
  Deno.exit(1);
}
if (toolRoots.length === 0) {
  console.error("No readable sandbox directories (RADIA_CHAT_DIRS).");
  Deno.exit(1);
}
// A SESSION credential is required, and never falls back to the space's open-mode no-header
// shortcut, which answers as the operator and would silently give a session the whole control
// plane. `--serve` is the exception and it is not a loophole: that mode has no person at the
// keyboard, runs no REPL, and does the deployment half only. It needs the OPERATOR credential
// instead, checked where the split is made.
if (!loginToken && !Deno.args.includes("--serve")) {
  console.error("Set RADIA_CHAT_TOKEN (or --token) to your session token.");
  console.error("  Mint one:  radia login human:<you>");
  console.error("  There is no default identity: the chat will not run as an unnamed principal.");
  Deno.exit(1);
}

const procs: Deno.ChildProcess[] = [];
const shutdown = new AbortController();
// Set when THIS process launched the fleet. It is what makes withdrawal on the way out belong to
// this launcher rather than to every fleet on the space (client/fleet.ts).
let fleetId: string | undefined;

/** Where the web UI is served, if it is. One definition for `--serve --web` and for the probe that
 *  prints the link in an ordinary session. */
const webPort = Number(arg("--web-port") ?? "8082");

function cleanup() {
  // FIRST, and on every path that reaches here. The prompt owns raw mode for the whole session, so
  // exiting without giving it back leaves the user's shell with no echo and no line editing, which
  // is a far worse thing to leave behind than whatever went wrong.
  releaseTerminal();
  shutdown.abort();
  for (const p of procs) {
    try {
      p.kill();
    } catch { /* already gone */ }
  }
}
// Raw mode swallows Ctrl-C, so the process can no longer die by signal while a prompt is up: the
// editor handles that key itself. These cover the paths a signal still arrives on (a `kill`, a
// terminal closing) and the ones where something throws its way out of the REPL.
for (const sig of ["SIGTERM", "SIGHUP"] as const) {
  try {
    Deno.addSignalListener(sig, () => {
      cleanup();
      Deno.exit(0);
    });
  } catch { /* not available on this platform */ }
}
globalThis.addEventListener("unload", releaseTerminal);

// Liveness only, and the one call that legitimately carries no credential: `/v0/health` is public
// so a client can tell "no space here" apart from "not allowed", even under `--auth required`.
const probe = new RadiaClient(url);
async function healthy(): Promise<boolean> {
  try {
    await probe.health();
    return true;
  } catch {
    return false;
  }
}

// Connect to a running space, or bring one up.
const usingRunning = await healthy();
if (!usingRunning) {
  procs.push(spawnSpace());
  for (let i = 0; i < 75 && !await healthy(); i++) await sleep(200);
  if (!await healthy()) {
    console.error("space did not start");
    cleanup();
    Deno.exit(1);
  }
}

// Two clients, two credentials, and they are NOT the same principal. `admin` bootstraps (register
// kinds, assign grants, mint the worker run tokens), all of which is privileged. `session` is the
// person at the keyboard, holding only what was granted to them.
//
// Resolved here rather than at import: a space this process just spawned writes its credential file
// during startup, so reading earlier always misses.
// SETUP AND SESSION ARE DIFFERENT JOBS, and only the first one is privileged. Registering kinds,
// minting the worker definitions and launching the fleet is a DEPLOYMENT step; sitting down to
// talk is not. While the two were one step, every person who opened the chat had to hold the
// control plane, which is the opposite of what the rest of this example argues for and is what
// kept a fleet to one user (agent_docs/plan-scaling.md item 3).
//
// So the operator credential is now OPTIONAL, and its absence selects JOIN MODE: no bootstrap, no
// fleet, no privileged read — just the REPL on the person's own token, against a space somebody
// else set up (`--serve`, below, or `deno task chat` on the same machine).
const serveOnly = Deno.args.includes("--serve");
const opToken = operatorToken();
const admin = opToken ? new RadiaClient(url, { token: opToken }) : undefined;
if (!admin && serveOnly) {
  console.error(`--serve sets a space up for others, which is privileged, and there is no operator credential for ${url}.`);
  console.error("  `radia dev` provisions one automatically; set RADIA_TOKEN to override.");
  cleanup();
  Deno.exit(1);
}

// Bootstrap as operator, then hand each worker its own least-privilege run token. Skipped entirely
// in join mode: the space is already set up, and a session that could do this would be an operator.
if (admin) await registerChatKinds(admin);
// The fleet's wrapping key, published BEFORE anything can create a conversation. It belongs with
// the kinds rather than with `setUpSpace`, and the ordering is the reason: a solo `deno task chat`
// resolves its conversation first and sets the space up afterwards, so a key published in
// `setUpSpace` does not exist yet when `--encrypt` needs to seal against it. Generated here because
// this is the process holding the private half; a joining session only ever reads the public one.
const fleetKey = admin ? await fleetKeyPair({ create: true }) : undefined;
if (admin && fleetKey) await publishFleetKey(admin, fleetKey);

/** The DEPLOYMENT half: worker credentials, the jail declaration, the fleet, and the boot sweep.
 *  Shared by both paths so `--serve` and a solo `deno task chat` cannot drift into setting a space
 *  up differently. Nothing here is per-person; the one thing that is (`assignUserGrants`) stays
 *  with the session, which is the whole point of the split. */
async function setUpSpace(a: RadiaClient): Promise<void> {
  const tokens = await bootstrap(a, {});
  // The OPERATOR declares the jail it is about to launch a worker into. Not the worker: a manifest
  // claim is descriptive by definition, and an execution guarantee must not be. This process
  // configured the flags, so it is the one that can honestly say what they are.
  await declareSandbox(a, denoSandbox({ name: "deno", readRoots: execRoots, timeoutMs: Number(EXEC_TIMEOUT_MS) }));
  // No session credential goes to the fleet. The tools worker used to be handed one so its
  // `space_*` verbs ran as a person; those verbs are served in the REPL now, which is what lets
  // these workers serve everybody.
  // Announced BEFORE the workers start, so a fleet exiting in the gap between the two sees this
  // one and leaves the shared advertisements alone (client/fleet.ts).
  fleetId = announceFleet(a, shutdown.signal);
  procs.push(...launchFleet(tokens, fleetKey));
  // The retention sweep, at the one moment this app reliably has an operator credential in hand.
  // Best-effort in the background: a chat that cannot sweep is a chat, not an error.
  a.gc().then((r) => {
    if (r.swept > 0) notice(dim(`swept ${r.swept} expired records (${Object.keys(r.byKind).join(", ")})`));
  }).catch(() => {/* not the session's problem */});
}

// SERVE MODE: the deployment half, once, with no person at the keyboard. It parks holding the
// fleet so everyone else can join with nothing but their own login. This is the split — the
// privileged work happens here instead of once per session.
if (serveOnly && admin) {
  await setUpSpace(admin);
  // `--auto-grant`: everyone the IdP vouches for may use this chat, said once here instead of one
  // `grant-user.ts` per person. Opt-in because it is a policy decision, and it changes what a ban
  // is — see space/auto-grant.ts.
  const autoGrant = Deno.args.includes("--auto-grant");
  if (autoGrant) {
    watchAutoGrants(admin, shutdown.signal, (m) => notice(dim(m)));
  }
  // `--web`: serve the browser UI beside the fleet, so joining costs one URL and one click instead
  // of a checkout and a Deno (agent_docs/plan-chat-web-ui.md). A separate process, spawned by the
  // launcher; this one holds the operator credential and must not be the one listening.
  const web = Deno.args.includes("--web") ? `http://127.0.0.1:${webPort}` : "";
  if (web) procs.push(launchWebUi(webPort));

  write(`\nfleet serving ${url}. Sessions join with:  deno task chat\n`);
  if (web) {
    write(`Or in a browser, with nothing installed:  ${web}\n`);
    write(dim(`  Send people that URL; they sign in with SSO and hold nothing else.\n`));
    // The IdP has to know this origin by both spellings, and the two fields are separate. Said here
    // because the failure lands on the person clicking, not on whoever configured the realm.
    write(dim(`  The IdP needs ${web}/* in Valid Redirect URIs and ${web} in Web Origins.\n`));
  }
  write(
    autoGrant
      ? `Auto-granting every enrolled identity. To keep somebody out, RETIRE THEIR MAPPING\n` +
        `  (radia put oidc_identity …{retired:true}). Revoking their grants is NOT a ban: it holds\n` +
        `  until this process restarts, and then they are admitted again.\n`
      : `New SSO identities arrive with no grants. Let one in with:\n` +
        `  deno run -A examples/chat/grant-user.ts <their human:oidc-… principal>\n` +
        `  …or restart with --auto-grant to admit everyone the IdP vouches for.\n`,
  );
  write(`Ctrl-C to stop the workers.\n\n`);
  await new Promise<void>((r) => shutdown.signal.addEventListener("abort", () => r(), { once: true }));
  cleanup();
  try {
    if (fleetId) await retireFleetAdvertisements(admin, fleetId);
  } catch { /* the space may already be gone */ }
  await sleep(100);
  Deno.exit(0);
}
// Which conversation this session is for. Resolved AFTER the session's credential exists, because
/**
 * Give a new conversation its key material: one DEK, wrapped to the fleet's published public key
 * and under this person's own key (plan-encryption.md phase 2).
 *
 * A record of its own rather than a field on the anchor, because a session cannot fetch a record by
 * id — get-by-id is the ops plane — so key material has to be addressed by content like everything
 * else here.
 *
 * Refuses rather than falling back to plaintext. `--encrypt` is a promise about where the content
 * goes, and a session that silently wrote a plaintext thread because a key was missing would break
 * it in the one way nobody checks.
 */
async function sealConversationKey(conversationId: string): Promise<void> {
  const fleet = await currentFleetKey(admin ?? session).catch(() => undefined);
  if (!fleet) {
    throw new Error(
      `--encrypt needs the fleet's public key, and no live 'fleet_key' record is on ${url}. ` +
        `Whoever runs the fleet publishes it:  deno task chat -- --serve`,
    );
  }
  // To EVERY machine this person reads on, not just this one. That is the whole of the multi-machine
  // fix at seal time: a key published from a laptop is in the registry, so a conversation started on
  // a desktop is readable there without anyone copying a file. Earlier conversations are reached by
  // enrolment instead (`conversationKeys(..., enrolFor)`), which needs a session that can already
  // open them.
  const mine = await livePersonKeys(session, owner);
  const { encryption } = await sealConversation(fleet, mine);
  await writeConversationKey(admin ?? session, conversationId, owner, encryption);
}

// in join mode there is no operator client to resolve it with, and still before grants are
// assigned, because a conversation-scoped grant binds to this id.
//
// READING conversations stays operator-only on purpose: enumerating them needs
// `conversation: query`, which would let any session list every conversation on the space. That is
// a real widening to save a keystroke.
async function resolveConversation(): Promise<{ id: string; resumed: boolean }> {
  if (resume && resume !== "last") return { id: resume, resumed: true };
  if (resume === "last") {
    if (!admin) {
      // `last` needs to ENUMERATE, which is the half a session deliberately cannot do. Naming the
      // id works in join mode, and so does starting fresh.
      write("--conversation last needs the operator credential this session does not hold; starting a new one\n");
    } else {
      // Newest first. That is the keyset direction, which is the only way to ask for the most recent.
      const recent = await admin.query({ kind: "conversation" }, 1, { dir: "desc" });
      if (recent.length > 0) return { id: recent[0].id, resumed: true };
      write("no conversation to resume; starting a new one\n");
    }
  }
  // CREATED by whoever is here. A session holds `conversation: put` and no read of any kind, which
  // is the safe half of the pair: starting a thread of your own tells you nothing about anyone
  // else's, while `query` would list every conversation on the space.
  try {
    const id = (await (admin ?? session).put({ kind: "conversation", body: {} })).id;
    // AFTER the anchor, because the key record names the conversation and the id is the server's
    // to assign. A failure here throws before a single message is written, which is the ordering
    // that matters: `--encrypt` must never leave a usable thread with no key.
    if (encryptMode) await sealConversationKey(id);
    return { id, resumed: false };
  } catch (e) {
    // The commonest join-mode failure, and it used to be a raw `forbidden` from four frames down.
    // `radia login` assigns the CLI's grants, not this app's: a person minted that way has a valid
    // credential and none of what the chat needs, which looks identical to a broken token.
    console.error(`\ncannot start a conversation as ${owner}: ${(e as Error).message}`);
    console.error(`  This session has a valid credential but not this app's grants.`);
    console.error(`  Someone holding the operator credential assigns them:  deno task chat -- --serve`);
    console.error(`  Or join an existing thread you already have access to:  --conversation <id>\n`);
    cleanup();
    Deno.exit(1);
  }
}

// Who is at the keyboard, resolved from the SPACE rather than taken on trust: the token names a
// run, and its subject is the person. Nothing the caller says is consulted, so a forged body field
// cannot claim someone else's identity.
// BOTH HALVES. The run token is what every request carries; the definition token is what mints the
// next one when it lapses, so a long conversation is no longer bounded by a credential's clock.
const session = new RadiaClient(url, {
  token: loginToken,
  ...(loginDefinitionToken ? { definitionToken: loginDefinitionToken } : {}),
});
let who: string;
try {
  // BOTH calls, at startup, rather than on the first message. `ensureCredential` only ACTS when
  // it has to mint (a present token is taken on faith), so a dead token surfaces at the first
  // authenticated request — the health read below is deliberately that request.
  await session.ensureCredential();
  who = (await session.health()).principal;
} catch (e) {
  // The commonest way here: the STORED login outlived the database it was minted against (a
  // space restarted onto a different store still answers on the same port). The server's raw
  // refusal ("a valid agent-definition token is required") says nothing about which credential
  // or what to do, so say it here, by source.
  console.error(`cannot start a session on ${url}: ${(e as Error).message}`);
  if (loginSource === "stored") {
    console.error(`  The stored login for this space is stale (the space's database does not know it).`);
    console.error(`  Mint a fresh one:  radia login human:<you>`);
  } else if (loginSource === "flag") {
    console.error(`  The --token you passed was not accepted; mint a fresh one with: radia login human:<you>`);
  } else if (loginSource === "env") {
    console.error(`  RADIA_CHAT_TOKEN was not accepted; mint a fresh one with: radia login human:<you>`);
  }
  Deno.exit(1);
}
// Asked of the SESSION, not the operator: any principal may read its OWN permissions, including
// one holding none (CLAUDE.md). That is what makes this work in join mode, and it was never a
// reason to hold the operator credential in the first place.
const perms = await session.permissions(who) as { subject: string; privileged: boolean };
const owner = perms.subject;
const privileged = perms.privileged;
setSessionOwner(owner);

// THIS MACHINE's key pair for this person, and its public half published so any session of theirs
// can seal to it (plan-encryption.md, the multi-machine fix). Done once at startup rather than at
// first encryption, because publishing has to happen BEFORE a conversation is sealed for the key to
// be included; content-keyed, so a machine used daily writes one record ever. Best-effort: a
// session without the grant simply cannot be enrolled, and says so only if it later asks to encrypt.
const myKey = await personKeyPair(url, owner);
await publishPersonKey(session, owner, myKey).catch(() => {});

// The person's display name, when their identity enrolled through OIDC: read from the
// enrollment record (the runtime's answer, agent_docs/plan-oidc.md), never from anything the
// session claims about itself. Banner decoration only; every record still carries the principal.
let displayName = "";
try {
  for (const r of await (admin ?? session).query({ kind: "oidc_identity" }, 200, { dir: "desc" })) {
    const b = r.body as { principal?: string; profile?: string; name?: string; username?: string; retired?: boolean };
    if (b.principal !== owner) continue;
    if (!b.retired) {
      if (typeof b.profile === "string") {
        // Display claims live in a PROFILE ARTIFACT so they are erasable (plan-oidc.md); a
        // shredded one simply reads as no name, which is the erasure doing its job.
        const p = JSON.parse(new TextDecoder().decode(await (admin ?? session).getArtifact(b.profile))) as { name?: string; username?: string };
        displayName = p.name ?? p.username ?? "";
      } else {
        displayName = b.name ?? b.username ?? ""; // enrolled before claims moved out of line
      }
    }
    break; // the newest record for this principal decides, either way
  }
} catch { /* nothing enrolled, a shredded profile, or no read: the principal alone is fine */ }

// JOIN MODE diagnostics, BEFORE the first thing that can fail on a missing grant. This process
// starts no workers and holds no authority beyond what was granted to this person, so two absences
// are worth naming at boot rather than leaving to be discovered:
//
//   - it cannot assign grants. A session with none cannot work, and the fix is somebody holding
//     the operator credential, not anything this process can do.
//   - it cannot APPROVE a grant request. `request_grant` still writes one; it is answered
//     elsewhere.
if (!admin) {
  const mine = await session.permissions(who) as { kinds: { kind: string }[] };
  if (!privileged && !mine.kinds.some((k) => k.kind === "message")) {
    // The EXACT command, principal included. This session is the one thing that knows its own
    // principal, and an SSO one is 32 hex characters nobody retypes: printing the line to forward
    // is the difference between "ask your admin" and a copyable fix.
    write(`\n${owner} holds no 'message' grant on this space, so a turn cannot even start.\n`);
    write(`  Send this to whoever holds the operator credential:\n\n`);
    write(`    deno run -A examples/chat/grant-user.ts ${owner}\n\n`);
    write(`  (a plain 'radia login' mints a valid credential with the CLI's grants, not this app's;\n`);
    write(`   a fleet started with --auto-grant would have admitted you already)\n\n`);
  }
  // A fleet nobody started answers nothing, and the symptom is a turn that hangs rather than an
  // error. Say so at boot instead — but only when the registry was actually READABLE and empty. A
  // session with no grants cannot read it at all, and reporting that as "nobody is serving" sends
  // someone to restart a fleet that is running fine.
  const serving = await session.query({ kind: "capability" }, 1).then((r) => r.length).catch(() => -1);
  if (serving === 0) {
    write(`no worker is advertising a capability on ${url}; turns will wait forever.\n`);
    write(`  Start the fleet:  deno task chat -- --serve\n\n`);
  }
}

const conversation = await resolveConversation();

// THE UNIT IS THE CONVERSATION, even though the flag is per session (plan-encryption.md), so a
// RESUMED thread decides for itself and `--encrypt` is only needed to CREATE one. The two
// directions are not symmetric, and that asymmetry is the whole rule:
//
//   encrypted thread, no flag  -> adopt it. Strictly more protection than was asked for, and the
//     only thing that could work anyway: writing plaintext into it makes a half-encrypted thread,
//     which is a payload no provider will take.
//   plaintext thread, --encrypt -> REFUSE. Adopting the thread here would silently write content in
//     clear that someone explicitly asked to have encrypted, which is the one direction that turns
//     a promise into a lie. There is no migration: the earlier turns cannot be re-sealed.
if (conversation.resumed) {
  // A read, never an absence: "no key record" and "no grant to look" are different answers, and
  // only one of them means the thread is plaintext.
  const sealed = await (admin ?? session)
    .readOne({ kind: CONVERSATION_KEY_KIND, match: { conversationId: conversation.id } })
    .then((r) => r !== null)
    .catch(() => undefined);
  if (sealed === false && encryptMode) {
    console.error(`\nconversation ${conversation.id} was created without encryption, and that cannot be changed.`);
    console.error(`  Resume it without --encrypt (its earlier turns cannot be re-sealed), or start a new thread.\n`);
    cleanup();
    Deno.exit(1);
  }
  if (sealed === undefined && encryptMode) {
    // The read itself failed: no grant, or a space set up before this kind existed. `--encrypt` is
    // a promise about where the content goes, so an unverifiable resume refuses instead of guessing.
    console.error(`\ncannot read conversation ${conversation.id}'s key to check whether it is encrypted.`);
    console.error(`  Ask for 'conversation_key: read_one' on this space, or start a new thread.\n`);
    cleanup();
    Deno.exit(1);
  }
}

// What the session's grants bind to. `owner` is this identity across all its conversations;
// `conversationId` is this thread only. See RADIA_CHAT_SCOPE.
const scope = scopeMode === "conversation"
  ? { conversationId: conversation.id }
  : { owner };
// ---- DEPLOYMENT SETUP: everything below this line needs the operator, and only runs with one ----
// SOLO MODE: one process is both halves, which is what `deno task chat` on its own should be. The
// only per-person step is here rather than in `setUpSpace`, because a session chooses its
// credential and never its authority.
if (admin) {
  await setUpSpace(admin);
  await assignUserGrants(admin, owner, scope);
}

// The inspection tools run HERE, on the session's own credential, because a delegated run can
// carry neither the ops plane nor a self-scoped grant (client/session-tools.ts). Claimed like any
// other work, so nothing is left unanswered in the queue; offered to the model directly, because a
// tool only this process can serve has no business in a shared advertisement registry.
// ONE resolver, shared by the thread and by the tools this session serves itself, so both hold the
// same cached DEK rather than unwrapping per consumer.
const sessionKeys = conversationKeys(
  session,
  { kind: "person", principal: owner, keyId: myKey.keyId, privateKey: myKey.privateKey },
  owner,
);
serveSessionTools(session, shutdown.signal, sessionKeys).catch((e) => notice(dim(`[session tools stopped: ${e}]`)));
const tools = new ToolSet(session, SESSION_TOOL_SCHEMAS);
tools.watch(shutdown.signal); // background: keep the tool set live from capability records
watchWakeups(session, shutdown.signal); // background: let the runtime push instead of polling
// background: keep the session's credential alive. Run tokens last 15 minutes, so without this a
// conversation simply died mid-sentence, and the crash came out of whichever write happened to be
// next. Renewal is at half-life; an expired token cannot renew itself.
let sessionLost: string | null = null;
session.keepAlive(shutdown.signal, (reason) => {
  sessionLost = reason;
});

// Still registered, for the window before the prompt claims raw mode (bootstrap, the fleet start)
// and for a SIGINT sent from elsewhere. At the prompt the editor answers Ctrl-C itself.
Deno.addSignalListener("SIGINT", () => {
  cleanup();
  Deno.exit(0);
});

// The banner is the MARK plus FACTS, aligned, one line each: prose here wraps to fifteen rows on an 80-column
// terminal before the first prompt. What a reader needs at that moment is where the space is, who
// they are, and which directories are exposed. The design positions it also carried (routing is
// automatic, languages are discovered rather than configured, the guarantees differ per jail and
// live in `sandbox` records) are all true and none of them are what you need in the first second;
// they are in examples/chat/README.md, and the assistant can answer the jail question from the
// records themselves, which is the whole point of it being a record.
// `${k} ` before the pad, so a label AT the column width still gets a separator. Without it
// "clipboard" (exactly 9) printed as `clipboardwl-paste`, and every future label of that length
// would have done the same.
const field = (k: string, v: string) => write(`  ${dim(`${k} `.padEnd(9))}${v}\n`);
// HELD until the last field. The fleet is already running by now (it has to be: `tools` reports
// what it advertised), and a worker's boot line is an idle-line notice, so it printed BETWEEN two
// fields and split the block it was aligned to be read as. Held, the fleet's lines arrive together
// underneath it, still in order and still labelled.
holdLine(true);
// THE MARK IS THE FAVICON (docs/favicon.svg): a record claimed out of a space — three waiting,
// one taken. Same four cells, drawn in text instead of SVG, so the terminal and the browser tab
// say the same thing; no colour, the filled cell carries the meaning. On a TERMINAL only: piped
// output keeps the one greppable line below, byte for byte what it always was.
if (tty) {
  // With a display name the principal moves into the dim parenthesis: still there (it is what
  // grants and records say), no longer the greeting. Piped output below stays byte-stable.
  const who = `radia chat  ${dim("·")}  ${displayName ? `${displayName} ${dim(`(${owner})`)}` : owner}${privileged ? dim("  (operator)") : ""}`;
  write(`\n  ╭─╮ ╭─╮\n  ╰─╯ ╰─╯   ${who}\n  ╭─╮ ╔═╗\n  ╰─╯ ╚═╝\n`);
} else {
  write(`\nradia chat  ${dim("·")}  ${owner}${privileged ? dim("  (operator)") : ""}\n`);
}
field("space", `${url}${usingRunning ? dim(" existing") : dim(` spawned, ${spaceDb}`)}`);
field("tiers", Object.entries(TIERS).map(([t, m]) => `${t}=${m}`).join("  "));
field("files", toolRoots.join(", "));
field("exec", execRoots.length ? execRoots.join(", ") : dim("no filesystem (RADIA_CHAT_EXEC_DIRS)"));
if (!privileged) field("auth", dim("scoped: space_* tools that touch /ops will 403"));

// This session's key for this conversation, resolved through the same path a worker uses: read the
// key record, unwrap under what this holder has. No owner is passed because the session's own
// `conversation_key` grant is already scoped to it — the conjunction IS the check.
let dek: ConversationKey | undefined;
try {
  dek = await sessionKeys(conversation.id);
} catch (e) {
  // A key that exists and will not open is fatal: the thread is somebody else's, or sealed under a
  // key this machine no longer has, and either way its content cannot be read or extended.
  if (e instanceof ConversationErasedError) {
    holdLine(false);
    console.error(`\n${e.message}`);
    console.error(`  Nothing can recover it; start a new conversation.\n`);
    cleanup();
    Deno.exit(1);
  }
  if (e instanceof NoConversationKeyError) {
    holdLine(false);
    console.error(`\ncannot open conversation ${conversation.id}: ${e.message}`);
    console.error(`  Its content was encrypted for someone else, or under a key this machine no longer has.\n`);
    cleanup();
    Deno.exit(1);
  }
  // The LOOKUP failed instead — no `conversation_key` grant, typically a space whose grants predate
  // this kind. Continue as plaintext rather than refusing every resume on such a space; if the
  // thread turns out to be encrypted after all, its rows carry the marker and the readers refuse
  // them (phase 1), so the failure stays closed rather than becoming ciphertext on a screen.
  notice(dim(`could not check whether ${conversation.id} is encrypted (${(e as Error).message}); continuing unencrypted`));
}
// Say it in the banner. A resumed thread adopts its own setting, so this can be on without anyone
// having asked for it in this session, and "is my content encrypted" should not need a query.
if (dek) field("content", "encrypted (this conversation's own key)");

let thread: Thread;
try {
  thread = conversation.resumed
    ? await Thread.resume(session, conversation.id, { principal: owner, privileged }, dek)
    : await Thread.open(session, { principal: owner, privileged }, conversation.id, dek);
} catch (e) {
  // Release the banner hold FIRST: the fleet's boot lines are queued behind it, and one of them is
  // often the actual reason this failed (a worker refusing to serve, a space gone away).
  holdLine(false);
  console.error(`could not resume: ${e}`);
  cleanup();
  Deno.exit(1);
}
field(
  "thread",
  thread.resumedFrom > 0
    ? `${thread.id}${dim(` resumed, ${thread.resumedFrom} earlier messages in context`)}`
    : `${thread.id}${dim("  --conversation last to resume it")}`,
);
// The console's Graph tab, on THIS conversation. The view lives in the URL (`#tab/recordId`), so a
// link is all it takes, and the turn is now a chain of records rather than a loop inside this
// process: what the waterfall draws is the thing that actually ran. Printed at boot because that is
// when a terminal can still be clicked through, and because nothing else advertises that the space
// has a console at all.
field("graph", `${url}/#graph/${thread.id}${dim("  the turn as records, with timings")}`);

/**
 * The web UI for this space, when somebody is serving one.
 *
 * PROBED, not configured and not discovered from a record. A record would mean a new kind and a new
 * grant, and a grant added later reaches nobody already admitted (extensions/ts/enrolment.ts), which
 * is a real cost for a convenience link. Config would mean every person setting the thing they came
 * here to be told. A probe costs one request at boot and is the only one of the three that can say
 * "there is a page there" rather than "there should be": it prints nothing when nothing answers.
 * `--web-url` / `RADIA_CHAT_WEB` overrides it for a page on another host or port.
 */
async function webUiUrl(): Promise<string | undefined> {
  const explicit = arg("--web-url") ?? Deno.env.get("RADIA_CHAT_WEB");
  if (explicit) return explicit.replace(/\/+$/, "");
  try {
    const guess = `${new URL(url).protocol}//${new URL(url).hostname}:${webPort}`;
    const res = await fetch(`${guess}/`, { signal: AbortSignal.timeout(700) });
    // The page's own marker, so a different service on that port is not mistaken for it.
    return res.ok && (await res.text()).includes('name="radia-space"') ? guess : undefined;
  } catch {
    return undefined; // nothing there, or not reachable from here: say nothing
  }
}
const webUi = await webUiUrl();
if (webUi) field("web", `${webUi}/#c/${thread.id}${dim("  this conversation in a browser")}`);
// Procedures belong to a conversation, so the tool set can only be complete once there is one.
await tools.scopeTo(thread.id);

// True while THIS process is rendering a turn. The live view holds foreign messages until it is
// false, so nothing lands inside an answer.
let turnRunning = false;

// What somebody ELSE says in this conversation, from another client (the web UI, a second terminal).
// As NOTICES, not as a transcript: the prompt owns the cursor here, and `notice` is the queue that
// exists so out-of-band output never lands inside an answer. A watch as the wakeup hint, because a
// terminal can afford one; the tick underneath is what makes it correct.
void liveView({
  client: session,
  conversationId: thread.id,
  accountedFor: () => thread.upToIndex,
  busy: () => turnRunning,
  patterns: [{ kind: "message", match: { conversationId: thread.id } }],
  render: "notice",
  signal: shutdown.signal,
}).catch(() => {/* the session is over; nothing left to follow */});

// Wait for the workers to publish their capabilities (the watch fills the set). Up to ten seconds
// of it, so it PRINTS: silence here reads as a hang.
const bootStart = Date.now();
for (let i = 0; i < 50 && tools.all().length === 0; i++) {
  showStatus("  ", `starting workers · ${Math.round((Date.now() - bootStart) / 1000)}s`);
  await sleep(200);
}
endStatus("");
field("tools", tools.all().length > 0 ? `${tools.all().length} discovered` : dim("none advertised yet"));

/**
 * Ctrl-V: attach whatever is on the clipboard.
 *
 * The terminal cannot deliver a picture. Its paste shortcut has nothing to send when the clipboard
 * holds one, so it sends nothing at all, and the key looks broken. This reads the clipboard through
 * the desktop instead: text is inserted as an ordinary paste would, bytes become an artifact, and a
 * file copied in a file manager (which arrives as a path, not as bytes) is read from disk.
 *
 * THIS process does the reading, not a worker. It is the person's own process with the person's own
 * filesystem; the tools worker is confined to the sandbox directories on purpose, and widening it to
 * arbitrary paths to save a hop would trade the property that the file-reading process cannot reach
 * the network.
 */
const clipboard = await clipboardReader();
field("paste", clipboard ? `${clipboard}  ${dim("Ctrl-V attaches an image, a PDF or a copied file")}` : dim("no reader (wl-paste / xclip / pngpaste); Ctrl-V does nothing"));
write(dim("\n  Ctrl-D to quit, Escape or Ctrl-C to cancel a turn.\n"));
holdLine(false); // and whatever the fleet said while the banner was printing lands now, in order

/** Store bytes as an artifact of this conversation and return the marker that goes in the message.
 *  The marker's shape is shared with the web client (client/attach.ts): it is what the assistant
 *  reads, so two front ends must not describe one attachment two ways. */
const attach = (bytes: Uint8Array, mediaType: string, filename: string) =>
  attachArtifact(session, { bytes, mediaType, filename }, { conversationId: conversation.id, owner });

/**
 * Ctrl-V stages; Enter writes. See `client/attachments.ts` for why: the chat stamps no retention
 * on attachments, so they are permanent, and uploading on the keystroke made a mis-paste
 * permanent. (A shred can still destroy the bytes; staging just keeps it from being needed.)
 */
const attachments = staging(({ bytes, mediaType, filename }) => attach(bytes, mediaType, filename));

const nextLine = lineReader({
  onClipboard: async () => {
    const clip = await readClipboard();
    if (!clip) {
      // Name the missing tool when there is one. "Empty" would be a lie on a Mac holding a
      // screenshot, and the person would go looking at their clipboard rather than at their PATH.
      const missing = missingClipboardTool();
      notice(dim(missing ? `clipboard: ${missing} is not installed, so images cannot be read here` : "clipboard: empty"));
      return "";
    }
    // Text behaves as a paste, so the key is never the wrong one to press.
    if (clip.kind === "text") return clip.text;
    try {
      if (clip.kind === "bytes") {
        const ext = clip.mediaType.split("/")[1]?.replace("+xml", "") ?? "bin";
        return attachments.stage({ bytes: clip.bytes, mediaType: clip.mediaType, filename: `pasted-${Date.now()}.${ext}` });
      }
      // A file copied in a file manager: a path, so the bytes come off disk. Read now (the path may
      // be gone by the time the line is sent) but stored only on Enter.
      const marks: string[] = [];
      for (const path of clip.paths.slice(0, 4)) {
        const bytes = await Deno.readFile(path);
        const name = path.split("/").pop() || "file";
        marks.push(attachments.stage({ bytes, mediaType: mediaTypeFor(name), filename: name }));
      }
      if (clip.paths.length > marks.length) notice(dim(`clipboard: ${clip.paths.length - marks.length} more file(s) not attached`));
      return marks.join(" ");
    } catch (e) {
      // Reported, never thrown: a failed attach must cost the keystroke and not the line being typed.
      notice(dim(`clipboard: ${e instanceof Error ? e.message : e}`));
      return "";
    }
  },
});
while (true) {
  write("\n");
  // The PROMPT is passed in rather than printed first, because the editor redraws the whole line on
  // every keystroke and has to know what precedes the cursor.
  const staged = await nextLine("you> ");
  if (staged === null) {
    attachments.clear(); // abandoning the line abandons what was staged into it
    break; // EOF / Ctrl-D, or Ctrl-C on an empty line
  }
  if (!staged.trim()) {
    attachments.clear();
    continue;
  }
  // ENTER is what writes the bytes. Everything staged by Ctrl-V and still visible in the line
  // becomes an artifact here, and nothing else does.
  const line = await attachments.commit(staged, (m) => notice(dim(m)));
  // A session that cannot be renewed (stopped, or past its maximum lifetime) is over. Say so and
  // stop rather than letting the next write throw: an uncaught `token_expired` killed the REPL and
  // took the conversation's context with it, and the stack trace named the SDK rather than the
  // credential.
  // A session that could not be renewed AND cannot mint another is over. With a definition token
  // this is nearly unreachable: renewal failing just means the next request exchanges. It still
  // happens when the definition itself was revoked, which is the one case that SHOULD end here.
  if (sessionLost && !loginDefinitionToken) {
    write(`\nsession ended: ${sessionLost}\n`);
    write(`Mint a new one with \`radia login ${owner}\` and restart with --conversation ${conversation.id}.\n`);
    break;
  }
  try {
    await thread.append({ role: "user", content: line });
  } catch (e) {
    // Anything else that fails on the FIRST write of a turn is reported and skipped, never fatal.
    // Losing a REPL to one bad request costs the whole conversation.
    write(`\ncould not record that message: ${(e as Error).message}\n`);
    continue;
  }
  let stopWatching: (() => void) | null = null;
  try {
    // The hook is what collapses the escalation loop into ONE turn: while a `request_grant` is in
    // flight the person is asked here, the decision is written back as a record, and the tool call
    // returns with it, so the assistant can retry inside its remaining rounds. Throttled, because
    // this runs on every poll of the wait loop and each pass is a query.
    let lastReview = 0;
    // Escape trips the turn; the watcher is stopped in `finally` so raw mode never outlives it and
    // Ctrl-C keeps working at the prompt.
    stopWatching = watchCancel(cancelTurn);
    turnRunning = true;
    await runTurn(session, thread, tools, async (tool) => {
      // Only an operator can answer one. In join mode the request is still WRITTEN and still
      // visible; somebody holding the credential approves it from elsewhere.
      if (tool !== "request_grant" || !admin || Date.now() - lastReview < 1000) return;
      lastReview = Date.now();
      try {
        await reviewGrantRequests(session, admin, owner, thread.id, nextLine);
        await tools.scopeTo(thread.id); // a new grant may have changed what is reachable
      } catch (e) {
        write(`\n[grant review failed] ${e}\n`);
      }
    });
  } catch (e) {
    // Cancelling is a thing the user did, not a fault: say what it did and, more importantly, what
    // it did NOT do. The worker keeps its claim, so the answer or the tool result still lands in the
    // space — visible on the Feed and in the thread — and pretending the work was undone would be
    // the one wrong thing to say about an at-least-once runtime.
    if (e instanceof TurnCancelled) {
      // What cancelling does and does not do, and it changed when the loop left this process: the
      // turn STOPS ADVANCING (a `cancel` record, checked before the worker emits the next link),
      // but a call already claimed still runs to completion and its result still lands. Saying so
      // is the point: pretending the work was undone is the one wrong thing to claim about an
      // at-least-once runtime.
      write(dim("\n[cancelled] no further rounds; work already claimed still finishes and lands\n"));
    } else {
      write(`\n[error] ${e}\n`);
    }
  } finally {
    turnRunning = false;
    stopWatching?.();
    stopWatching = null;
  }
  // Between turns as well, as the backstop: a request written by a worker rather than asked for
  // through the blocking tool (or one whose turn died) would otherwise sit pending forever.
  // `admin` is the operator credential this process bootstrapped with. The session itself cannot
  // write a grant, which is the point.
  if (admin) {
    try {
      await reviewGrantRequests(session, admin, owner, thread.id, nextLine);
      await tools.scopeTo(thread.id); // a new grant may have changed what is reachable
    } catch (e) {
      write(`\n[grant review failed] ${e}\n`);
    }
  }
}

cleanup();
// Withdraw the fleet's advertisements on the way out, so the next session's tool list is what is
// actually being served rather than the union of every fleet that ever ran here. Awaited, which is
// why it is here and not in `cleanup()`: that one is called from paths that exit immediately, and a
// withdrawal nobody waits for is a withdrawal that usually does not land.
// Only the process that STARTED the fleet withdraws it. A joining session that retired these would
// take the advertisements away from everybody else still talking.
try {
  if (admin && fleetId) await retireFleetAdvertisements(admin, fleetId);
} catch { /* the space may already be gone; shutting down regardless */ }
await sleep(100);
Deno.exit(0);
