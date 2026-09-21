// Watch a poker table from the terminal, as a dealer's-eye view rather than a record feed.
//
//   deno run -A examples/poker/follow.ts                 # the newest session on the space
//   deno run -A examples/poker/follow.ts --session tmu9x --no-color --no-hole --width 100
//
// A standalone script and deliberately not a CLI verb: `radia activity --follow` is the general
// view and stays general, while this one knows what a street is, which seat is out, and that a
// fold means the row goes quiet. Everything it draws comes from the same public reads a player
// has, so it is also a demonstration that the table reads back from records.
//
// IT SHOWS EVERY HOLE CARD its token can read, which with an operator credential is all of them.
// That is the point of a spectator view and it is why this is not something a player may run:
// `--no-hole` is for a recording, not for safety. A player's own token sees its own cards here
// and nothing else, because the grant is scoped, which is the property worth watching.
//
// CARDS ARE DRAWN AS LETTERS, not as suit glyphs. U+2660..2663 are East Asian Ambiguous and the
// red pair have emoji presentation, so a terminal that renders them wide silently breaks every
// row below. Colour carries the suit instead, and colour is off into a pipe, under NO_COLOR and
// past --no-color, the convention `radia activity` uses.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { resolveToken } from "../../src/credentials.ts";
import { ACTION, ACTION_REQUEST, BOARD, HOLE, RESULT } from "./poker.ts";
import { NOTE } from "../../extensions/ts/team.ts";

const arg = (name: string, fallback?: string) => {
  const at = Deno.args.indexOf(`--${name}`);
  return at >= 0 ? Deno.args[at + 1] : fallback;
};
const url = arg("url", "http://127.0.0.1:7788")!;
// NOT DEFAULTED TO "poker". A team label is a choice the team file makes, and a run under any
// other one was invisible here: the view queried a label nobody was playing under and drew an
// empty table. Unset means "whichever team wrote the newest action".
const wantedTeam = arg("team");
const intervalMs = Number(arg("interval", "1000"));
const wanted = arg("session");
const showHole = !Deno.args.includes("--no-hole");
const colour = Deno.stdout.isTerminal() && !Deno.env.get("NO_COLOR") && !Deno.args.includes("--no-color");

const paint = (code: string) => (s: string) => (colour && s ? `\x1b[${code}m${s}\x1b[0m` : s);
const C = { dim: paint("2"), bold: paint("1"), red: paint("31"), green: paint("32"), yellow: paint("33") };

// INNER WIDTH, from the terminal and re-read every frame so a resize takes effect. 62 is the
// floor and the fallback: `consoleSize` throws when stdout is not a tty, which is the case in a
// pipe or a recording, and a fixed width is what makes that output diffable. The surplus goes to
// the last column of each row, which is where the note text and the dealer's remarks live.
const widthOf = (): number => {
  const at = Deno.args.indexOf("--width");
  if (at >= 0) return Math.max(40, Number(Deno.args[at + 1]));
  try {
    // THE WHOLE TERMINAL. Notes are the widest thing here and the most worth reading, so the
    // frame takes the width it is given and the note column absorbs it. What must NOT stretch is
    // a seat's mark: at 200 columns a right-aligned "to act" sat 150 characters from the name it
    // belonged to, so those columns are fixed and the row pads after them.
    return Math.max(62, Math.min(Deno.consoleSize().columns - 4, 400));
  } catch {
    return 62;
  }
};
let W = widthOf();

/** A cell. `p` is the painted form of `t` and must have the same display width. */
interface Seg {
  t: string;
  p?: string;
  w?: number;
  right?: boolean;
}

/** Lay cells out in fixed columns, so a row's width is arithmetic rather than counted by eye. */
function row(segs: Seg[]): string {
  let plain = "";
  let painted = "";
  for (const s of segs) {
    const w = s.w ?? s.t.length;
    const t = s.t.length > w ? s.t.slice(0, w) : s.t;
    const p = s.t.length > w ? t : s.p ?? t;
    const fill = " ".repeat(Math.max(0, w - t.length));
    plain += s.right ? fill + t : t + fill;
    painted += s.right ? fill + p : p + fill;
  }
  const tail = " ".repeat(Math.max(0, W - plain.length));
  return `│ ${painted}${tail} │`;
}
const rule = (l: string, r: string) => l + "─".repeat(W + 2) + r;

/** `Kd` -> red K d. Hearts and diamonds are the red pair; the letter keeps the width at two. */
const card = (c: string) => (/[hd]$/.test(c) ? C.red(c) : c);
const cards = (list: string[]): Seg => ({ t: list.join(" "), p: list.map(card).join(" ") });

interface Action { handId: string; street: string; player: string; type: string; amount?: number; by?: string }
interface Request { handId: string; street: string; player: string; stack?: number; pot?: number; toCall?: number; betSize?: number; canRaise?: boolean }
interface Board { handId: string; street: string; cards: string[] }
interface Hole { handId: string; owner: string; cards: string[] }
interface Note { [k: string]: unknown }
interface Result {
  handId: string;
  pot: number;
  winners: string[];
  shown?: { player: string; cards: string[]; hand: string }[];
  standings?: { player: string; stack: number }[];
}
type Rec<T> = { id: string; body: T; runtimeMeta: { createdAt: string; parentIds: string[]; createdBy: string } };

const short = (p: string) => p.replace("agent:", "");

/**
 * What the move COST, computed from the request it answers rather than read off the action.
 *
 * The dealer ignores the `amount` a player writes and posts `owed` or `owed + betSize` from its
 * own state, so the body's number is a client claim the runtime discarded. Showing it presents a
 * raise that never happened as if it had. `+n` is chips added, which is the question the raw
 * number cannot answer: `raise 4` reads as "to 4" just as easily.
 */
function move(a: Action, req?: Request): string {
  if (a.type === "fold" || a.type === "check") return a.type;
  if (!req) return a.type;
  const cost = a.type === "call" ? req.toCall ?? 0 : (req.toCall ?? 0) + (req.betSize ?? 0);
  const claimed = a.amount !== undefined && a.amount !== cost ? ` (asked ${a.amount})` : "";
  return `${a.type} +${cost}${claimed}`;
}
const ago = (iso: string) => `${Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))}s`;

function frame(
  session: string,
  team: string,
  actions: Rec<Action>[],
  requests: Rec<Request>[],
  boards: Rec<Board>[],
  holes: Rec<Hole>[],
  results: Rec<Result>[],
  notes: Rec<Note>[],
): string {
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
  const hands = [...new Set(actions.map((a) => a.body.handId).concat(requests.map((r) => r.body.handId)))].sort();
  const hand = hands[hands.length - 1] ?? "";
  const mine = actions.filter((a) => a.body.handId === hand).sort(byId);
  const open = requests.filter((r) => r.body.handId === hand).sort(byId);
  const turn = open[open.length - 1];
  const board = boards.filter((b) => b.body.handId === hand).sort((a, b) => a.body.cards.length - b.body.cards.length).pop()?.body;
  const settled = results.find((r) => r.body.handId === hand)?.body;
  const final = results.find((r) => r.body.handId === "final")?.body;

  // PARENTAGE DECIDES WHETHER A MOVE HAPPENED, which is the rule the dealer itself applies
  // (`waitForAction` accepts only an action naming the request it sent). A player's grant carries
  // `action: put`, needed so its ack can write a result, and that same grant lets it write an
  // action while holding no turn: one seat wrote four parentless folds in a hand it had already
  // been timed out of. The dealer ignored every one; a viewer keying on hand/street/seat did not.
  const byRequest = new Map(requests.map((r) => [r.id, r.body]));
  const parentOf = (a: Rec<Action>) => a.runtimeMeta.parentIds.find((id) => byRequest.has(id));
  // A late ack names the SAME request the dealer gave up on, and the timeout fold that preceded
  // it names that request too. Both are drawn, marked, since hiding either makes a real ordering
  // look sane. Keying this on hand/street/seat instead would also catch the second decision of a
  // raising war, which is a real move.
  const abandoned = new Set(mine.filter((a) => a.body.by === "timeout").map(parentOf).filter(Boolean));

  // Each turn record carries the stack of the player it asks, which is the only number available
  // before a hand settles.
  const stack = new Map<string, number>();
  for (const r of requests) if (typeof r.body.stack === "number") stack.set(r.body.player, r.body.stack);
  // A settled hand publishes every stack, so prefer it: a request only names the seat it asks,
  // and a seat nobody has asked since hand 3 was otherwise still showing its hand-3 stack.
  for (const r of [...results].sort(byId)) for (const st of r.body.standings ?? []) stack.set(st.player, st.stack);

  const counted = mine.filter((a) => parentOf(a) && !(a.body.by !== "timeout" && abandoned.has(parentOf(a))));
  const paid = new Set(counted.filter((a) => ["call", "bet", "raise"].includes(a.body.type)).map((a) => a.body.player));
  const folded = new Set(counted.filter((a) => a.body.type === "fold").map((a) => a.body.player));
  const last = new Map<string, Action>();
  for (const a of counted) last.set(a.body.player, a.body);
  const cardsOf = new Map<string, string[]>();
  for (const h of holes) if (h.body.handId === hand) cardsOf.set(h.body.owner, h.body.cards);
  // SEATS IN THE ORDER THEY ACT, not alphabetically, so reading down the panel is reading the
  // hand. The dealer asks preflop as utg..sb,bb, and only the big blind is ever asked with
  // nothing to call, so both blinds are readable without knowing what the blinds cost. The
  // button rotates every hand (`rotateButton`), which is why this is recomputed per hand rather
  // than being a property of the roster.
  const preflop = requests.filter((r) => r.body.handId === hand && r.body.street === "preflop").sort(byId);
  const asked: string[] = [];
  for (const r of preflop) if (!asked.includes(r.body.player)) asked.push(r.body.player);
  const bb = preflop.find((r) => r.body.toCall === 0)?.body.player;
  const sb = asked[(bb ? asked.indexOf(bb) : asked.length) - 1];
  const pos = new Map(asked.map((p, i) => [p, p === bb ? "bb" : p === sb ? "sb" : i === 0 ? "utg" : ""]));
  const dealt = [...new Set([...holes.map((h) => h.body.owner), ...requests.map((r) => r.body.player)])].sort();
  const seats = [...asked, ...dealt.filter((p) => !asked.includes(p))];

  // Net chips. The starting stack is the dealer's own option and is never written, so it is
  // recovered as the LARGEST stack any seat was first asked with: everyone starts equal, and the
  // seats that post no blind are still whole when the table first speaks to them.
  const first = new Map<string, number>();
  for (const r of [...requests].sort(byId)) {
    if (typeof r.body.stack === "number" && !first.has(r.body.player)) first.set(r.body.player, r.body.stack);
  }
  const base = Math.max(...first.values(), 0);
  // Nobody is to act once the seat the dealer last asked has answered.
  const waiting = turn && !mine.some((a) => parentOf(a) === turn.id) && !settled ? turn : undefined;

  const out: string[] = [rule("┌", "┐")];
  const street = settled ? "settled" : turn?.body.street ?? "dealing";
  out.push(row([
    { t: `${team}  ${session}`, p: C.bold(`${team}  ${session}`), w: 30 },
    // No denominator: the dealer's `--hands` is not published, so the only honest count is how
    // many have been dealt.
    { t: `hand ${Math.max(1, hands.indexOf(hand) + 1)}`, w: 12 },
    { t: street, p: C.yellow(street) },
  ]));
  out.push(rule("├", "┤"));

  out.push(row([
    { t: "board", p: C.dim("board"), w: 7 },
    board ? { ...cards(board.cards), w: 20 } : { t: "-", w: 20 },
    { t: `pot ${settled?.pot ?? turn?.body.pot ?? 0}`, p: C.bold(`pot ${settled?.pot ?? turn?.body.pot ?? 0}`) },
  ]));
  out.push(rule("├", "┤"));

  for (const seat of seats) {
    const out_ = folded.has(seat);
    const acting = waiting?.body.player === seat;
    const held = showHole ? cardsOf.get(seat) ?? [] : [];
    const shown = cards(held);
    const chips = stack.get(seat);
    const net = chips !== undefined && base ? chips - base : undefined;
    const mark = settled ? (settled.winners.includes(seat) ? "won" : "") : out_ ? "folded" : acting ? "to act" : "";
    out.push(row([
      // A caret beside the seat to act, because a right-hand tag is the last thing read on a row.
      { t: acting ? "> " : "  ", p: acting ? C.yellow("> ") : "  ", w: 2 },
      { t: short(seat), p: out_ ? C.dim(short(seat)) : C.bold(short(seat)), w: 6 },
      { t: pos.get(seat) ?? "", p: C.dim(pos.get(seat) ?? ""), w: 5 },
      // `~` when the number predates a bet this seat has already made: the stack comes from the
      // request that ASKED it, and only a settled hand publishes what it actually holds.
      { t: chips === undefined ? "-" : `${chips}${!settled && paid.has(seat) ? "~" : ""}`, w: 6, right: true },
      { t: net === undefined ? "" : net > 0 ? `+${net}` : String(net), p: net ? (net > 0 ? C.green(`+${net}`) : C.red(String(net))) : undefined, w: 6, right: true },
      { t: "  ", w: 2 },
      out_ ? { t: shown.t, p: C.dim(shown.t), w: 7 } : { ...shown, w: 7 },
      { t: mark, p: mark === "to act" ? C.yellow(mark) : mark === "won" ? C.green(mark) : C.dim(mark), w: 10 },
    ]));
  }

  // What the seat to act is actually being asked, which is the half a move list never shows: a
  // fold facing 0 to call and a fold facing a raise are not the same decision.
  if (waiting) {
    const b = waiting.body;
    const ask = `${short(b.player)} owes ${b.toCall ?? 0}, bet ${b.betSize ?? 0}, raise ${b.canRaise ? "open" : "capped"}`;
    // A TURN NOBODY IS ANSWERING looks identical to one being thought about. Past five minutes it
    // is almost always a table whose processes are gone: `--fresh` leaves the request `available`
    // and nothing in the space says the players went away.
    const stalled = Date.now() - Date.parse(waiting.runtimeMeta.createdAt) > 300_000;
    out.push(rule("├", "┤"));
    out.push(row([
      { t: "  " + ask, p: "  " + C.dim(ask), w: 46 },
      {
        t: `${ago(waiting.runtimeMeta.createdAt)} ${stalled ? "stalled" : "waiting"}`,
        p: (stalled ? C.red : C.yellow)(`${ago(waiting.runtimeMeta.createdAt)} ${stalled ? "stalled" : "waiting"}`),
        w: 20,
      },
    ]));
  }

  // THE HAND AS A STORY, grouped under the street it happened on with the cards that came with
  // that street. A flat list of moves cannot be followed, because the board it was played against
  // is the thing that changed.
  out.push(rule("├", "┤"));
  if (mine.length === 0) out.push(row([{ t: "  waiting for the first action", p: C.dim("  waiting for the first action") }]));
  const dealtAt = new Map(boards.filter((b) => b.body.handId === hand).map((b) => [b.body.street, b.body.cards]));
  for (const st of ["preflop", "flop", "turn", "river"]) {
    const moves = mine.filter((a) => a.body.street === st);
    if (moves.length === 0) continue;
    const potHere = open.filter((r) => r.body.street === st).pop()?.body.pot;
    out.push(row([
      { t: "  " + st, p: "  " + C.bold(st), w: 11 },
      { ...cards(dealtAt.get(st) ?? []), w: 12 },
      { t: potHere === undefined ? "" : `pot ${potHere}`, p: C.dim(potHere === undefined ? "" : `pot ${potHere}`) },
    ]));
    for (const a of moves) {
      const parent = parentOf(a);
      const late = a.body.by !== "timeout" && abandoned.has(parent);
      const note = !parent
        ? "no turn claimed, ignored"
        : a.body.by === "timeout"
        ? "dealer's clock, not a decision"
        : late
        ? "late, the table had moved on"
        : "";
      const text = move(a.body, parent ? byRequest.get(parent) : undefined);
      out.push(row([
        { t: "      " + short(a.body.player), w: 12 },
        { t: text, p: note ? C.dim(text) : text, w: 18 },
        { t: note, p: late || !parent ? C.red(note) : C.dim(note), w: W - 30 },
      ]));
    }
  }

  // THE CHANNEL, ALWAYS SHOWN, including when it is empty. The count is the measurement this
  // table exists to make (`examples/teams/poker/README.md`), and an absent section reads as "not
  // watching" rather than as zero. `created_by` is a run id, so the author is recovered the way
  // `floor.ts` recovers it: the run that wrote a seat's actions is that seat.
  const whoIs = new Map<string, string>();
  for (const a of actions) whoIs.set(a.runtimeMeta.createdBy, a.body.player);
  out.push(rule("├", "┤"));
  const players = notes.filter((n) => whoIs.has(n.runtimeMeta.createdBy)).length;
  const headline = players === 0
    ? (notes.length ? `no player notes (${notes.length} from the floor)` : "no notes written")
    : `${players} player note${players === 1 ? "" : "s"}`;
  out.push(row([
    { t: "  channel", p: "  " + C.bold("channel"), w: 12 },
    { t: headline, p: players ? C.red(headline) : C.dim(headline) },
  ]));
  // ONE LINE PER RULING, not one per addressee. The floor writes a copy to every seat so that a
  // reader filtering on its own name sees it, which is correct and makes five records of one
  // event; collapsing them on the message keeps the panel readable and loses nothing.
  const seen = new Set<string>();
  const distinct = notes.filter((n) => {
    const body = { ...(n.body as Record<string, unknown>) };
    delete body.to;
    const key = JSON.stringify(body);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const n of distinct.slice(-5)) {
    // The floor is the only writer that never takes a turn, so it is the one author the action
    // records cannot name.
    const who = whoIs.get(n.runtimeMeta.createdBy) ?? "floor";
    const b = n.body as { to?: string; message?: string; text?: string };
    const to = String(b.to ?? "all");
    const said = String(b.message ?? b.text ?? JSON.stringify(n.body));
    const from = `${short(who)} -> ${short(to)}`;
    out.push(row([
      { t: "      " + from, p: "      " + C.dim(from), w: 22 },
      { t: said, p: who === "floor" ? C.red(said) : said, w: Math.max(20, W - 22) },
    ]));
  }

  const done = results.filter((r) => r.body.handId !== "final").sort(byId);
  if (done.length) {
    out.push(rule("├", "┤"));
    if (done.length > 10) {
      const skipped = `  ... ${done.length - 10} earlier hands`;
      out.push(row([{ t: skipped, p: C.dim(skipped) }]));
    }
    for (const r of done.slice(-10)) {
      const b = r.body;
      const how = b.shown?.find((s) => b.winners.includes(s.player))?.hand ?? "";
      out.push(row([
        { t: "  " + b.handId.split("-").pop()!, p: "  " + C.dim(b.handId.split("-").pop()!), w: 6 },
        { t: `pot ${b.pot}`, w: 9 },
        { t: b.winners.map(short).join(", "), p: C.green(b.winners.map(short).join(", ")), w: 14 },
        { t: how, p: C.dim(how), w: W - 29 },
      ]));
    }
  }
  out.push(rule("└", "┘"));
  if (final) {
    const s = (final.standings ?? []).map((x) => `${short(x.player)} ${x.stack}`).join("   ");
    out.push("  " + C.bold("final") + "  " + s);
  }
  return out.join("\n");
}

const token = Deno.env.get("RADIA_TOKEN") || resolveToken(url);
if (!token) throw new Error(`no credential for ${url}; start it with \`radia dev\` or set RADIA_TOKEN`);
const client = new RadiaClient(url, { token });
const enc = new TextEncoder();

for (;;) {
  try {
    W = widthOf();
    const [actions, requests, boards, holes, results, notes] = await Promise.all([
      client.queryAll<Action>({ kind: ACTION }),
      client.queryAll<Request>({ kind: ACTION_REQUEST }),
      client.queryAll<Board>({ kind: BOARD }),
      showHole ? client.queryAll<Hole>({ kind: HOLE }) : Promise.resolve([]),
      client.queryAll<Result>({ kind: RESULT }),
      // A note's body is whatever its writer chose, so it carries no `session` to filter on and
      // is scoped by TIME instead: ULIDs sort by write order, so "after this session's first
      // record" is the same question. A space with no `note` kind declared is not an error here.
      client.queryAll<Note>({ kind: NOTE }).catch(() => []),
    ]);
    // ONE SESSION, or the view is every game ever played here: `--fresh` clears the open work and
    // leaves the history. The newest action names the current one.
    // REQUESTS COUNT, NOT JUST ACTIONS. The dealer writes holes, a board and the first turn
    // before anybody has moved, and deriving the session from actions alone drew "no poker
    // records" over a table that was already dealt and waiting on its first player.
    const newest = [...actions, ...requests].sort((a, b) => (a.id < b.id ? 1 : -1))[0];
    const nb = newest?.body as unknown as { session?: string; team?: string } | undefined;
    const session = wanted ?? nb?.session ?? "";
    const team = wantedTeam ?? nb?.team ?? "";
    const of = <T,>(rows: { body: T }[]) => rows.filter((r) => (r.body as unknown as { session?: string }).session === session);
    const start = [...actions, ...requests].filter((r) => (r.body as unknown as { session?: string }).session === session)
      .map((r) => r.id).sort()[0] ?? "";
    const text = session
      ? frame(
        session,
        team,
        of(actions) as Rec<Action>[],
        of(requests) as Rec<Request>[],
        of(boards) as Rec<Board>[],
        of(holes) as Rec<Hole>[],
        of(results) as Rec<Result>[],
        (notes as Rec<Note>[]).filter((n) => n.id >= start && (n.body as { team?: string }).team === team),
      )
      : wantedTeam
      ? `  nothing dealt on team '${wantedTeam}' yet`
      : "  nothing dealt on this space yet";
    Deno.stdout.writeSync(enc.encode(`\x1b[H\x1b[2J${text}\n`));
  } catch (e) {
    Deno.stdout.writeSync(enc.encode(`\x1b[H\x1b[2J  ${e instanceof Error ? e.message : String(e)}\n`));
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}
