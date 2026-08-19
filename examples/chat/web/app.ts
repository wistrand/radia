/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// The chat, in a browser (agent_docs/plan-chat-web-ui.md phase 2).
//
// This file is the browser's answer to what `chat.ts` does for a terminal, and the comparison is
// the point: it holds no operator credential, starts no worker, and owns no turn. It signs in,
// attaches to a conversation, and calls the SAME `runTurn` the REPL calls. Everything between the
// question and the answer happens in the space.
//
// WHAT IT DELIBERATELY DOES NOT DO. It parks no watch streams: a browser allows six connections per
// origin over HTTP/1.1, shared across tabs, and a chat session's five would leave nothing for the
// requests themselves. `waiting.ts` already degrades to its 250ms reconcile tick when a watch is
// refused, so this front end simply never opens one and takes the tick as its spine. Whether it can
// afford one is a measurement, not a guess, and it has not been taken.

import { RadiaClient, RadiaClientError } from "../../../sdk/ts/client.ts";
import { installUI } from "../client/ui.ts";
import { Thread } from "../client/thread.ts";
import { cancelTurn, findOpenTurn, runTurn, ToolSet, TurnCancelled } from "../client/turn.ts";
import { type LiveMessage, liveView, renderMessages } from "../client/live.ts";
import { setSessionOwner } from "../space/roles.ts";
import { SESSION_TOOL_SCHEMAS, serveSessionTools } from "../client/session-tools.ts";
import { staging } from "../client/attachments.ts";
import { attachArtifact } from "../client/attach.ts";
import { mediaTypeFor } from "../util.ts";
import { domUI } from "./dom-ui.ts";
import { beginSignIn, completeSignIn, displayName, expired, type OidcInfo, probeSpace, signOut, storedToken } from "./auth.ts";

const $ = (id: string) => document.getElementById(id)!;
const show = (id: string, on: boolean) => ($(id).hidden = !on);
const setText = (id: string, s: string) => ($(id).textContent = s);

/** The grants a session cannot chat without. Not the whole set (`space/roles.ts` owns that): enough
 *  to tell "this app has not admitted you" from "something else broke", which is the distinction
 *  a person cannot make from a 403. */
const NEEDED = [
  { kind: "conversation", ops: ["put"] },
  { kind: "message", ops: ["put", "query"] },
  { kind: "llm_call", ops: ["put", "query"] },
];

let OIDC: OidcInfo | null = null;
let client: RadiaClient;
let thread: Thread;
let tools: ToolSet;
let busy = false;
let attachments: ReturnType<typeof staging>;
/** The principal the SPACE resolved this token to, so a question can be drawn as mine or theirs. */
let me = "";
/** Whether this tab may write to the conversation. See `electWriter`. */
let writer = true;
/** Set when this tab holds the conversation's lock, so it can hand it over. */
let releaseLock: (() => void) | null = null;
const stopping = new AbortController();

const ui = domUI({
  transcript: $("transcript"),
  status: $("status"),
  onAppend: () => {
    // Follow the tail only while the reader is already there: yanking the view back while somebody
    // is reading earlier in a long answer is the one thing an autoscroll must not do.
    const el = $("transcript");
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  },
});
installUI(ui);

// ---- sign-in ----

async function boot(): Promise<void> {
  OIDC = (await probeSpace()).oidc;
  const params = new URLSearchParams(location.search);
  if (params.has("code") || params.has("error")) {
    const err = await completeSignIn(params, OIDC);
    if (err) return gate(err);
  }
  if (!storedToken()) return gate("");
  try {
    await start();
  } catch (e) {
    if (expired(e) && OIDC) return void beginSignIn(OIDC, { silent: true });
    gate(`could not start: ${(e as Error).message}`);
  }
}

function gate(message: string): void {
  show("app", false);
  show("gate", true);
  setText("boot", "");
  ($("signin") as HTMLButtonElement).disabled = !OIDC;
  setText(
    "gate-note",
    message ||
      (OIDC ? "" : "this space advertises no OIDC issuer; whoever runs it starts it with --oidc-issuer and --oidc-audience"),
  );
}

($("signin") as HTMLButtonElement).onclick = async () => {
  if (!OIDC) return;
  const err = await beginSignIn(OIDC);
  if (err) setText("gate-note", err);
};
($("signout") as HTMLButtonElement).onclick = signOut;

// ---- the session ----

async function start(): Promise<void> {
  client = new RadiaClient(location.origin, { token: storedToken() });
  const health = await client.health() as { principal: string };
  const perms = await client.permissions(health.principal) as {
    principal: string;
    subject: string;
    privileged: boolean;
    kinds: { kind: string; operations: string[] }[];
  };
  const owner = perms.subject || perms.principal;
  me = owner;
  // The IdP's name where there is one, with the PRINCIPAL still beside it: the name is what the
  // issuer called this person and the principal is what the space enforces, so showing only the
  // first would hide the thing every record is stamped with (the console's rule, plan-console-auth).
  const shown = displayName();
  setText("who", shown && owner.startsWith("human:") ? `${shown} · ${owner}` : owner);
  ($("who") as HTMLElement).title = owner;
  show("who", true);
  show("signout", true);

  const held = new Map((perms.kinds ?? []).map((k) => [k.kind, k.operations ?? []]));
  const missing = perms.privileged ? [] : NEEDED.filter((n) => !n.ops.every((op) => (held.get(n.kind) ?? []).includes(op)));
  if (missing.length > 0) {
    // The commonest join-mode failure, and it looks exactly like a broken token: a valid credential
    // with none of this app's grants. Name which, and who fixes it.
    show("app", false);
    show("gate", true);
    setText("boot", "");
    setText(
      "gate-note",
      `This is a valid session as ${owner}, but it does not hold this app's grants ` +
        `(missing: ${missing.map((m) => m.kind).join(", ")}). Whoever runs the fleet admits you with ` +
        `"deno run -A examples/chat/grant-user.ts ${owner}", or restarts it with --auto-grant.`,
    );
    return;
  }

  // `owner` is stamped on every message this session writes, so it has to be the principal the
  // SPACE resolved, never anything this page decided.
  setSessionOwner(owner);

  const { id, resumed } = await resolveConversation();
  await refuseIfEncrypted(id);

  // Which tab may type. Not a correctness gate any more: `Thread.append` claims its slot, so two
  // clients take different ones and two turns cannot share a `turnAt` (phase 7). It stays because
  // two boxes on one conversation in one browser is confusing, and the lock MOVES on Take over, so
  // stepping between tabs costs a click. Nothing arbitrates against the terminal or another
  // machine, and after phase 7 nothing needs to.
  writer = await electWriter(id);

  thread = !resumed
    ? await Thread.open(client, { principal: owner, privileged: perms.privileged }, id)
    // A VIEWER writes nothing, and a system message is a write. `resume` appends one, which is what
    // makes taking the thread up different from watching it.
    : writer
    ? await Thread.resume(client, id, { principal: owner, privileged: perms.privileged })
    : await Thread.attach(client, id);
  // The inspection tools, served BY THIS TAB on its own credential, and offered to the model
  // directly because they are not advertised (client/session-tools.ts). They cannot be delegated to
  // a worker at all: a delegated run carries no ops power and loses `scope: {createdBy: "self"}`, so
  // whoever is asking has to be the one answering. Nothing about that is terminal-specific, which is
  // the whole reason the page is as capable here as the REPL.
  //
  // NO WATCH. `agentLoop` would park one stream per kind, and a page's six connections per origin
  // are worth more than a wakeup: the claim loop's own tick answers within a second, which is
  // invisible next to the tool call it is answering.
  //
  // Every tab serves, viewer or not. Claims are leased, so two tabs cannot answer one call, and the
  // redundancy is free: if the tab that asked goes away mid-call, another can still answer it.
  void serveSessionTools(client, stopping.signal, undefined, false).catch((e) => ui.notice(`[session tools stopped: ${e}]`));

  tools = new ToolSet(client, SESSION_TOOL_SCHEMAS);
  await tools.scopeTo(thread.id);

  // Ctrl-V, a picker or a drop STAGES; Send writes. The same `staging` the terminal uses, for the
  // same reason and with the same rule: the placeholder in the box IS the record of intent, so
  // deleting it before sending means the bytes were never stored (client/attachments.ts). The chat
  // stamps no retention, which makes an attachment permanent, which makes that rule worth keeping.
  attachments = staging((item) => attachArtifact(client, item, { conversationId: id, owner }));
  wireAttaching();

  show("gate", false);
  show("app", true);
  setText("conv", thread.id);
  setText("resume-cmd", `deno task chat -- --conversation ${thread.id}`);
  location.hash = `#c/${thread.id}`;

  // The console's Graph tab, on THIS conversation: the view lives in the URL, so a link is all it
  // takes. The same affordance the terminal prints at boot, and for the same reason — the turn is a
  // chain of records, so what the waterfall draws is the thing that actually ran.
  const space = document.querySelector('meta[name="radia-space"]')?.getAttribute("content") ?? "";
  if (space && !space.startsWith("__")) {
    const link = $("graph") as HTMLAnchorElement;
    link.href = `${space}/#graph/${thread.id}`;
    link.hidden = false;
  }

  if (resumed) await renderHistory(id);
  applyRole();

  // Follow a turn that is ALREADY RUNNING. This is what makes "the turn is records" visible rather
  // than merely true: close the tab mid-answer, open it again, and the same turn finishes here.
  const open = await findOpenTurn(client, thread.id).catch(() => null);
  if (open) void follow(open);

  // Everything anyone else says, from here on. No watch stream: a browser has six connections per
  // origin and a parked stream is one of them, so this front end lives on the reconcile tick.
  void liveView({
    client,
    conversationId: thread.id,
    accountedFor: () => thread.upToIndex,
    busy: () => busy,
    patterns: [],
    signal: stopping.signal,
  }).catch(() => {});

  // A backgrounded tab has its timers throttled and its connections dropped, so coming back is the
  // one moment worth reconciling out of turn rather than waiting for the next tick.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !busy) void catchUp();
  });

  ($("compose") as HTMLTextAreaElement).focus();
}

/** Render whatever landed while this tab was asleep, immediately. The live view's own pass does the
 *  same thing on its next tick; this only removes the wait. */
async function catchUp(): Promise<void> {
  const rows = await client.query(
    { kind: "message", match: { conversationId: thread.id, index: { $gt: thread.upToIndex } }, orderBy: [{ path: "index" }] },
    50,
  ).catch(() => []);
  const last = rows[rows.length - 1]?.body as { index?: number } | undefined;
  if (!rows.length || typeof last?.index !== "number") return;
  renderMessages(rows.map((r) => r.body as Parameters<typeof renderMessages>[0][number]));
  thread.noteExternal(last.index);
}

/**
 * One writer per conversation per browser profile, elected by the Web Locks API.
 *
 * A lock MOVES rather than being shared, so handing over is safe: the holder releases when another
 * tab asks over a `BroadcastChannel`, and the waiter's queued request acquires it. Where the API is
 * absent, everybody writes: refusing to let someone type because their browser is old would be a
 * worse failure than the collision this avoids.
 */
async function electWriter(conversationId: string): Promise<boolean> {
  const locks = (navigator as { locks?: LockManager }).locks;
  if (!locks) return true;
  const name = `radia.chat.${conversationId}`;
  const channel = new BroadcastChannel(name);

  const hold = (): Promise<boolean> =>
    new Promise((decided) => {
      locks.request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          decided(false);
          return Promise.resolve();
        }
        // Held until something resolves this promise: another tab asking for it, or this one closing.
        return new Promise<void>((release) => {
          releaseLock = () => {
            releaseLock = null;
            release();
          };
          decided(true);
        });
      });
    });

  channel.onmessage = async (e: MessageEvent) => {
    if (e.data === "release" && releaseLock) {
      // Somebody else wants the thread. Step down, then say so on screen.
      releaseLock();
      writer = false;
      applyRole();
    } else if (e.data === "released" && !writer) {
      writer = await hold();
      applyRole();
    }
  };
  stopping.signal.addEventListener("abort", () => releaseLock?.(), { once: true });
  globalThis.addEventListener("pagehide", () => {
    releaseLock?.();
    channel.postMessage("released");
  });

  ($("takeover") as HTMLButtonElement).onclick = () => channel.postMessage("release");
  return await hold();
}

/**
 * The three ways bytes arrive in a browser: a picker, a paste, a drop.
 *
 * All of them end in the same place, which is the point: one staging list, one marker format, one
 * moment of writing. The terminal has one way (Ctrl-V) and the same rules apply to it.
 */
function wireAttaching(): void {
  const box = $("compose") as HTMLTextAreaElement;
  const picker = $("file") as HTMLInputElement;

  const stage = async (files: FileList | File[] | null): Promise<void> => {
    for (const file of Array.from(files ?? [])) {
      // The browser's own type when it has one, the extension when it does not: a picker knows
      // `image/png`, a drag from some applications knows nothing at all.
      const mediaType = file.type || mediaTypeFor(file.name);
      const bytes = new Uint8Array(await file.arrayBuffer());
      insertAtCursor(box, attachments.stage({ bytes, mediaType, filename: file.name }) + " ");
    }
    showStaged();
  };

  picker.onchange = async () => {
    await stage(picker.files);
    picker.value = ""; // so picking the same file twice stages it twice, which is what was asked
  };
  ($("attach") as HTMLButtonElement).onclick = () => picker.click();

  box.addEventListener("paste", (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return; // ordinary text paste: leave it alone
    e.preventDefault();
    void stage(files);
  });

  // Dropping anywhere on the conversation, not just on the box: aiming at a textarea is not what
  // anyone does with a file.
  for (const ev of ["dragover", "drop"] as const) {
    $("app").addEventListener(ev, (e: Event) => {
      e.preventDefault();
      if (ev === "drop") void stage((e as DragEvent).dataTransfer?.files ?? null);
    });
  }
}

/** Insert at the caret rather than appending: the placeholder's POSITION in the line is what the
 *  assistant reads as "here is the file I mean". */
function insertAtCursor(box: HTMLTextAreaElement, text: string): void {
  const at = box.selectionStart ?? box.value.length;
  box.value = box.value.slice(0, at) + text + box.value.slice(box.selectionEnd ?? at);
  box.selectionStart = box.selectionEnd = at + text.length;
  box.focus();
}

/** What is staged, and that sending it is permanent. Said where the decision is made rather than in
 *  a banner nobody rereads: the chat stamps no retention, so these do not expire. */
function showStaged(): void {
  const n = attachments.size;
  setText(
    "staged",
    n === 0 ? "" : `${n} attachment${n === 1 ? "" : "s"} staged. Sending stores ${n === 1 ? "it" : "them"} permanently; delete the [attach …] text to drop ${n === 1 ? "it" : "them"}.`,
  );
  show("staged", n > 0);
}

/** The composer follows the role: a viewer cannot type, and is told why rather than left wondering
 *  what is wrong with the box. */
function applyRole(): void {
  ($("compose") as HTMLTextAreaElement).disabled = !writer;
  ($("send") as HTMLButtonElement).disabled = !writer || busy;
  show("viewing", !writer);
}

/**
 * Which conversation this tab is for.
 *
 * Named in the URL or created, never chosen from a list: a session deliberately does not hold
 * `conversation: query`, because enumerating them would list every conversation on the space
 * (`resolveConversation` in chat.ts). The fragment is what makes a reload, a bookmark and a shared
 * link the same mechanism.
 */
async function resolveConversation(): Promise<{ id: string; resumed: boolean }> {
  const named = (location.hash.match(/^#c\/([A-Za-z0-9]+)/) ?? [])[1];
  if (named) return { id: named, resumed: true };
  const { id } = await client.put({ kind: "conversation", body: {} });
  return { id, resumed: false };
}

/** An encrypted conversation is refused rather than rendered: opening one needs a key this browser
 *  has no way to hold yet (phase 6), and showing ciphertext to a person is the failure that the
 *  fail-closed rule in `extensions/ts/encrypted.ts` exists to prevent. */
async function refuseIfEncrypted(conversationId: string): Promise<void> {
  const key = await client.readOne({ kind: "conversation_key", match: { conversationId } }).catch(() => null);
  if (key) {
    throw new Error(
      `conversation ${conversationId} is encrypted, and this browser holds no key for it. ` +
        `Open it in the terminal client (deno task chat -- --conversation ${conversationId}).`,
    );
  }
}

/**
 * What was said before this tab attached.
 *
 * Rendered through the SAME surface the live turn uses, so history and the turn in progress cannot
 * drift apart in appearance. Ascending by `index`, which is what that path is declared sortable for.
 */
async function renderHistory(conversationId: string): Promise<void> {
  const rows = await client.query(
    { kind: "message", match: { conversationId }, orderBy: [{ path: "index" }] },
    500,
  );
  renderMessages(rows.map((r) => r.body as LiveMessage), "full", HOOKS);
  ui.write(ui.dim(`— ${rows.length} earlier record${rows.length === 1 ? "" : "s"} —\n`));
}

/** How this page draws a question: as a bubble, and only as its own when the owner says so. The
 *  port has no concept of one, which is why it arrives as a hook rather than a method. */
const HOOKS = { onUser: (m: LiveMessage) => userSaid(String(m.content ?? ""), m.owner === me) };

/** The person's own message. The protocol half never emits it (a terminal shows it because they
 *  typed it), so the page renders it rather than the port. */
function userSaid(text: string, mine = true): void {
  const el = document.createElement("div");
  el.className = mine ? "user" : "user other";
  el.textContent = text;
  $("transcript").appendChild(el);
}

// ---- taking a turn ----

async function send(): Promise<void> {
  const box = $("compose") as HTMLTextAreaElement;
  const raw = box.value;
  if (!raw.trim() || busy || !writer) return;
  box.value = "";
  setBusy(true);
  // THE UPLOAD HAPPENS HERE, not when the file was chosen. Every placeholder still present becomes
  // an artifact, in the order it was staged; anything deleted first is dropped unwritten. A failed
  // upload costs its attachment and not the message.
  const text = (await attachments.commit(raw, (m) => ui.notice(m))).trim();
  showStaged();
  userSaid(text);
  try {
    await thread.append({ role: "user", content: text });
  } catch (e) {
    ui.notice(`could not record that message: ${(e as Error).message}`);
    return setBusy(false);
  }
  await drive(() => runTurn(client, thread, tools));
}

/** Pick up a turn already in flight. The same render loop, minus the seed: `runTurn` does not care
 *  which client asked the question. */
async function follow(open: { callId: string; turnAt: number }): Promise<void> {
  ui.write(ui.dim("\n[joining a turn already running]\n"));
  setBusy(true);
  await drive(() => runTurn(client, thread, tools, undefined, open));
}

/** Run a turn and report what ended it. One place, because a seeded turn and a followed one fail
 *  in exactly the same ways. */
async function drive(turn: () => Promise<void>): Promise<void> {
  try {
    await turn();
  } catch (e) {
    if (e instanceof TurnCancelled) {
      // What cancelling does and does not do. The turn stops advancing (a `cancel` record the turn
      // worker reads before emitting the next link), but a call already claimed still runs and its
      // result still lands: pretending otherwise is the one wrong thing to say about an
      // at-least-once runtime.
      ui.write(ui.dim("\n[cancelled] no further rounds; work already claimed still finishes and lands\n"));
    } else if (expired(e)) {
      // The run reached its ceiling mid-conversation. Nothing is lost: the transcript is records
      // and the route is in the URL, so coming back lands on this same thread.
      if (OIDC) return void beginSignIn(OIDC, { silent: true });
      ui.write("\n[session expired] sign in again\n");
    } else {
      ui.write(`\n[error] ${e instanceof RadiaClientError ? e.message : e}\n`);
    }
  } finally {
    setBusy(false);
    // A turn may have added a grant or saved a procedure, either of which changes what is callable.
    await tools.scopeTo(thread.id).catch(() => {});
  }
}

function setBusy(on: boolean): void {
  busy = on;
  ($("send") as HTMLButtonElement).disabled = on || !writer;
  show("stop", on);
}

($("send") as HTMLButtonElement).onclick = send;
($("stop") as HTMLButtonElement).onclick = () => cancelTurn();
($("compose") as HTMLTextAreaElement).onkeydown = (e: KeyboardEvent) => {
  // Enter sends, Shift+Enter is a newline: the convention every chat box uses.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
};

boot();
