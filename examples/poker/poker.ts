// Fixed-limit Texas hold'em on a space, where the hidden information is enforced by GRANTS rather
// than by a prompt asking players not to look.
//
// examples/teams/go-fish/ stopped exactly here, and says so: "Hands travel as notes any member
// could query, and a read leaves NO event, so a player that peeks at another's hand note is
// invisible to the space; the prompt is the only thing against it. A `hand` kind under per-player
// pattern-scoped grants is the next step if that matters." In Go Fish peeking is rude. With a pot
// it is the whole game, so this example takes that step.
//
// Three properties carry the demonstration, and `smoke.ts` asserts each:
//   READ  a player holds `hole: query` scoped to {owner: self}, so another player's hole cards are
//         not hidden by convention, they are unreachable: `grant AND request` is computed server
//         side, and the ops read plane asks `readAccess` the same question.
//   WRITE the same pattern on `action: put` means a player cannot forge another player's fold.
//         An ack-emitted result is authorized as a put for the ACTING agent, so this holds on the
//         settle path too, which is the only way an action is ever written.
//   ORDER the dealer writes one `action_request` matching one player's take pattern. Turn order is
//         therefore claimability: no orchestrator, no lock, and the other three cannot act out of
//         turn even if their code tries.
//
// No models and no API key. The players are scripted, so a run is reproducible from its seed.

import type { RadiaClient } from "../../sdk/ts/client.ts";
import { declareKind, liveKinds } from "../../extensions/ts/team.ts";

// ---------------------------------------------------------------------------
// Cards and hand ranking
// ---------------------------------------------------------------------------

/** A card is 0..51: rank = c % 13 (0 = deuce, 12 = ace), suit = (c / 13) | 0. */
export type Card = number;
const RANKS = "23456789TJQKA";
const SUITS = "cdhs";
export const cardName = (c: Card): string => `${RANKS[c % 13]}${SUITS[(c / 13) | 0]}`;

/** Deterministic PRNG, so a seeded run repeats exactly and a failing hand can be replayed. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function shuffled(next: () => number): Card[] {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * Rank the best five-card hand out of seven. Higher is better; values are comparable across hands
 * and nothing else about them is meaningful.
 *
 * Category in the top nibble, then the tiebreak ranks most significant first, so two hands of the
 * same category compare on their kickers without a second pass.
 */
export function evaluate7(cards: Card[]): number {
  const bySuit: number[][] = [[], [], [], []];
  const count = new Array(13).fill(0);
  for (const c of cards) {
    bySuit[(c / 13) | 0].push(c % 13);
    count[c % 13]++;
  }
  const straightTop = (ranks: number[]): number => {
    const present = new Array(13).fill(false);
    for (const r of ranks) present[r] = true;
    // The wheel: an ace plays low, and it is the one straight whose top card is not its highest.
    for (let top = 12; top >= 3; top--) {
      if ([0, 1, 2, 3, 4].every((k) => present[top - k])) return top;
    }
    if (present[12] && present[0] && present[1] && present[2] && present[3]) return 3;
    return -1;
  };
  const flushSuit = bySuit.findIndex((s) => s.length >= 5);
  if (flushSuit >= 0) {
    const sf = straightTop(bySuit[flushSuit]);
    if (sf >= 0) return (8 << 20) | (sf << 16);
    const top5 = [...bySuit[flushSuit]].sort((a, b) => b - a).slice(0, 5);
    return (5 << 20) | top5.reduce((acc, r) => (acc << 4) | r, 0);
  }
  const st = straightTop(cards.map((c) => c % 13));
  const groups = count
    .map((n, r) => ({ n, r }))
    .filter((g) => g.n > 0)
    .sort((a, b) => (b.n - a.n) || (b.r - a.r));
  const pack = (cat: number, ranks: number[]) => (cat << 20) | ranks.slice(0, 5).reduce((acc, r) => (acc << 4) | r, 0);
  const kickers = (used: number[], take: number) =>
    groups.filter((g) => !used.includes(g.r)).map((g) => g.r).slice(0, take);
  if (groups[0].n === 4) return pack(7, [groups[0].r, ...kickers([groups[0].r], 1)]);
  if (groups[0].n === 3 && groups[1]?.n >= 2) return pack(6, [groups[0].r, groups[1].r]);
  if (st >= 0) return pack(4, [st]);
  if (groups[0].n === 3) return pack(3, [groups[0].r, ...kickers([groups[0].r], 2)]);
  if (groups[0].n === 2 && groups[1]?.n === 2) {
    return pack(2, [groups[0].r, groups[1].r, ...kickers([groups[0].r, groups[1].r], 1)]);
  }
  if (groups[0].n === 2) return pack(1, [groups[0].r, ...kickers([groups[0].r], 3)]);
  return pack(0, groups.map((g) => g.r));
}

export const CATEGORIES = [
  "high card",
  "pair",
  "two pair",
  "trips",
  "straight",
  "flush",
  "full house",
  "quads",
  "straight flush",
];
export const categoryOf = (score: number): string => CATEGORIES[score >>> 20];

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

// PREFIXED, because this example can be pointed at a space that is already running something
// else. A kind declaration is a record and a redeclaration is a successor, so declaring a bare
// `action` would silently change the routing contract of any app that already owned that name.
export const HOLE = "poker_hole";
export const BOARD = "poker_board";
export const ACTION_REQUEST = "poker_action_request";
export const ACTION = "poker_action";
export const RESULT = "poker_hand_result";

/**
 * `owner` and `player` are indexed because they are what a grant pattern narrows on, and a grant
 * may only narrow on a declared path. That is the whole reason this example declares its own
 * kinds rather than reusing `note`: the isolation IS the indexing contract.
 */
export const KINDS = [
  {
    kind: HOLE,
    indexedPaths: [
      { path: "owner", type: "keyword" as const },
      { path: "handId", type: "keyword" as const },
      { path: "session", type: "keyword" as const },
      { path: "team", type: "keyword" as const },
    ],
    claimable: false,
    usage:
      "One player's two hole cards for one hand, written by the dealer. Every player holds " +
      "`hole: query` scoped to {owner: self}, so this kind is readable only by the player it " +
      "belongs to and by the dealer that dealt it. Never claimed.",
  },
  {
    kind: BOARD,
    indexedPaths: [
      { path: "handId", type: "keyword" as const },
      { path: "street", type: "keyword" as const },
      { path: "session", type: "keyword" as const },
      { path: "team", type: "keyword" as const },
    ],
    claimable: false,
    usage: "The community cards for one street of one hand. Public: every player queries it unscoped.",
  },
  {
    kind: ACTION_REQUEST,
    indexedPaths: [
      { path: "player", type: "keyword" as const },
      { path: "handId", type: "keyword" as const },
      { path: "street", type: "keyword" as const },
      { path: "session", type: "keyword" as const },
      { path: "team", type: "keyword" as const },
    ],
    claimable: true,
    usage:
      "It is this player's turn. Claimable by exactly one principal, because each player's " +
      "`action_request: take` grant is scoped to {player: self}. Claiming it IS taking the turn; " +
      "there is no lock and no orchestrator. Ack it with an `action`.",
  },
  {
    kind: ACTION,
    indexedPaths: [
      { path: "player", type: "keyword" as const },
      { path: "handId", type: "keyword" as const },
      { path: "street", type: "keyword" as const },
      { path: "session", type: "keyword" as const },
      { path: "team", type: "keyword" as const },
    ],
    claimable: false,
    usage:
      "What a player did. body: {session, handId, street, type, amount}. `type` is fold, check, " +
      "call, bet or raise. FIXED LIMIT, so `amount` is not free: 0 to fold or check, `toCall` to " +
      "call, `toCall + betSize` to bet or raise, and no other value. Check only when `toCall` is 0; " +
      "bet when `toCall` is 0, raise when it is not; neither while `canRaise` is false. Write no " +
      "`player` and no `team`: both are filled in from your grant, which is why you cannot write " +
      "another player's action. Public, so the betting history is auditable.",
  },
  {
    kind: RESULT,
    indexedPaths: [
      { path: "handId", type: "keyword" as const },
      { path: "session", type: "keyword" as const },
      { path: "team", type: "keyword" as const },
    ],
    claimable: false,
    usage: "Who won one hand, with how much and by what, plus every hand shown at showdown.",
  },
];

/**
 * Declare the kinds, the way `radia team up --init` declares a team's.
 *
 * NOT `registerKind` in a loop. `declareKind` canonicalises path order first, and the idempotency
 * key is order-independent while the row is not, so a plain `registerKind` after an `--init` is
 * `idempotency_conflict`: same key, different content. It also merges with a live declaration
 * rather than replacing it, which is what makes running this beside `--init` safe in either order.
 */
export async function declarePokerKinds(admin: RadiaClient): Promise<number> {
  const live = await liveKinds(admin);
  for (const k of KINDS) await declareKind(admin, k, live);
  return KINDS.length;
}

/** What a player principal may do. Everything that is not public is narrowed to itself. */
export function playerGrants(principal: string): { principal: string; kind: string; operations: string[]; pattern?: Record<string, unknown> }[] {
  return [
    { principal, kind: HOLE, operations: ["query"], pattern: { owner: principal } },
    { principal, kind: ACTION_REQUEST, operations: ["take"], pattern: { player: principal } },
    { principal, kind: ACTION, operations: ["put"], pattern: { player: principal } },
    { principal, kind: ACTION, operations: ["query"] },
    { principal, kind: BOARD, operations: ["query"] },
    { principal, kind: RESULT, operations: ["query"] },
  ];
}

// ---------------------------------------------------------------------------
// The dealer
// ---------------------------------------------------------------------------

export type Street = "preflop" | "flop" | "turn" | "river";
const STREETS: Street[] = ["preflop", "flop", "turn", "river"];

export interface Seat {
  principal: string;
  name: string;
  stack: number;
}

export interface ActionBody {
  handId: string;
  street: Street;
  player: string;
  type: "fold" | "check" | "call" | "bet" | "raise";
  amount: number;
}

export interface HandOutcome {
  handId: string;
  pot: number;
  winners: string[];
  shown: { player: string; cards: string[]; hand: string }[];
  foldedOnTimeout: string[];
  /** Requests the dealer gave up waiting for. They are still `available`; see the README. */
  abandonedRequests: string[];
}

export interface DealerOptions {
  /** Stamped on every record and folded into every idempotency key, so a rerun against a space
   *  that already holds a previous run neither dedupes against it nor is counted with it. */
  session?: string;
  /** The team label, when this runs under `radia team up`. Every member's grants are scoped to it,
   *  so a record written without it matches no player's grant and is unreadable by the table. */
  team?: string;
  smallBlind?: number;
  bigBlind?: number;
  /** How long to wait for a player to act before folding them. There is no timer in the space. */
  actionTimeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * Move the button one seat, which every caller dealing a SEQUENCE of hands must do between them.
 *
 * `playHand` posts the blinds on `seats[0]` and `seats[1]`, so a table that never rotates hands
 * each seat one fixed decision problem for the whole session: the same seat completes from the
 * small blind every hand while another checks its option for free and two more open under the
 * gun. Three hands of that read as four player types and are four positions. It also breaks any
 * between-seat comparison, which is how `examples/teams/poker/softplay.ts` came to measure a
 * placebo pair that never sat in a blind against a partnership that always did.
 */
export function rotateButton(seats: Seat[]): void {
  seats.push(seats.shift()!);
}

/**
 * Deal and settle one hand.
 *
 * The dealer is an ordinary principal with grants on every kind. It holds the deck in memory and
 * never writes it, because a record of the deck would be readable by anything holding a grant on
 * that kind, and there would be no kind whose grant list is "nobody".
 */
export async function playHand(
  dealer: RadiaClient,
  seats: Seat[],
  handId: string,
  deck: Card[],
  opts: DealerOptions = {},
): Promise<HandOutcome> {
  const sb = opts.smallBlind ?? 1;
  const bb = opts.bigBlind ?? 2;
  const timeout = opts.actionTimeoutMs ?? 3000;
  const session = opts.session ?? "local";
  const team = opts.team;
  /** Every record the dealer writes carries the session and, under a team, the team label. */
  const stamp = <T extends Record<string, unknown>>(body: T) => (team ? { ...body, team } : body);
  const log = opts.log ?? (() => {});

  const live = new Map(seats.map((s) => [s.principal, true]));
  // A hand ends the moment one player is left: everybody folding is not a possible outcome, so
  // the betting loop breaks here rather than letting the last seat fold into an empty pot.
  const remaining = () => [...live.values()].filter(Boolean).length;
  const committed = new Map(seats.map((s) => [s.principal, 0]));
  const hole = new Map<string, Card[]>();
  const abandoned: string[] = [];
  const timedOut: string[] = [];
  let pot = 0;
  let next = 0;

  // Hole cards. One record per player, each carrying the owner the grant pattern matches on.
  for (const s of seats) {
    const cards = [deck[next++], deck[next++]];
    hole.set(s.principal, cards);
    await dealer.put({
      kind: HOLE,
      body: stamp({ session, handId, owner: s.principal, cards: cards.map(cardName) }),
    }, `hole:${session}:${handId}:${s.principal}`);
  }

  const post = (p: string, amount: number) => {
    const seat = seats.find((s) => s.principal === p)!;
    const paid = Math.min(amount, seat.stack);
    seat.stack -= paid;
    committed.set(p, committed.get(p)! + paid);
    pot += paid;
    return paid;
  };
  post(seats[0].principal, sb);
  post(seats[1 % seats.length].principal, bb);
  log(`${handId}: blinds ${sb}/${bb}, pot ${pot}`);

  const board: Card[] = [];
  for (const street of STREETS) {
    if (remaining() < 2) break;
    if (street !== "preflop") {
      const deal = street === "flop" ? 3 : 1;
      for (let i = 0; i < deal; i++) board.push(deck[next++]);
      await dealer.put({
        kind: BOARD,
        body: stamp({ session, handId, street, cards: board.map(cardName) }),
      }, `board:${session}:${handId}:${street}`);
      for (const p of committed.keys()) committed.set(p, 0);
    }
    // Fixed limit: one bet plus at most three raises, each of one bet size.
    const betSize = street === "preflop" || street === "flop" ? bb : bb * 2;
    let toMatch = street === "preflop" ? bb : 0;
    let raises = 0;
    let acted = 0;
    const order = street === "preflop" ? [...seats.slice(2), ...seats.slice(0, 2)] : seats;

    for (let i = 0; acted < order.length * 4; i++) {
      const seat = order[i % order.length];
      const p = seat.principal;
      if (!live.get(p)) {
        acted++;
        continue;
      }
      const owed = toMatch - committed.get(p)!;
      if (owed === 0 && acted >= order.length) break;

      const req = await dealer.put({
        kind: ACTION_REQUEST,
        body: stamp({
          session,
          handId,
          street,
          player: p,
          toCall: owed,
          betSize,
          canRaise: raises < 3,
          pot,
          board: board.map(cardName),
          stack: seat.stack,
        }),
      });
      const action = await waitForAction(dealer, handId, street, p, req.id, timeout);
      acted++;

      if (action === null) {
        // Nobody claimed it. The space has no timer and the dealer cannot unpublish a record, so
        // the request stays `available` and the dealer folds the seat on its own clock.
        //
        // The fold is WRITTEN, parented on the request it answers. Without it a timeout left no
        // trace at all: the betting history simply skipped a seat, and nothing in the space said
        // whether the player had folded or had never been asked. The dealer is the author, and
        // `by: "timeout"` is what distinguishes it from a fold the player chose.
        await dealer.put({
          kind: ACTION,
          body: stamp({ session, handId, street, player: p, type: "fold", amount: 0, by: "timeout" }),
          parentIds: [req.id],
        }, `action:timeout:${req.id}`);
        abandoned.push(req.id);
        timedOut.push(p);
        live.set(p, false);
        log(`  ${seat.name} timed out, folded (request ${req.id} left available)`);
        if (remaining() < 2) break;
        continue;
      }
      if (action.type === "fold") {
        live.set(p, false);
        log(`  ${seat.name} folds`);
        if (remaining() < 2) break;
        continue;
      }
      if (action.type === "call" || action.type === "check") {
        post(p, owed);
        log(`  ${seat.name} ${owed > 0 ? `calls ${owed}` : "checks"}`);
        continue;
      }
      // ANYTHING ELSE IS A FOLD. The branch below used to be the `else`, so a body whose `type`
      // this dealer does not know fell into it and became a RAISE: a model that wrote
      // `{action: "fold"}` instead of `{type: "fold"}` had its fold played as an aggressive bet.
      // Observed with a live OpenRouter player. The record is valid (a kind constrains routing,
      // not shape), so the dealer is the only thing that can catch it, and the safe reading of a
      // move it cannot parse is the one that risks nothing.
      if (action.type !== "bet" && action.type !== "raise") {
        live.set(p, false);
        log(`  ${seat.name} folds (unreadable action ${JSON.stringify(action.type)})`);
        if (remaining() < 2) break;
        continue;
      }
      // bet or raise: match what is owed, then put in one more bet.
      post(p, owed + betSize);
      toMatch = committed.get(p)!;
      raises++;
      acted = 1; // everyone still in owes an answer to the raise
      log(`  ${seat.name} ${action.type}s to ${toMatch}`);
    }
  }

  // Showdown. A folded hand is never revealed: the dealer writes only the cards of players who
  // reached showdown, so the space holds no record of what a folder was holding.
  const contenders = seats.filter((s) => live.get(s.principal));
  const shown: HandOutcome["shown"] = [];
  let winners: string[] = [];
  if (contenders.length === 1) {
    winners = [contenders[0].principal];
  } else {
    let best = -1;
    for (const s of contenders) {
      const score = evaluate7([...hole.get(s.principal)!, ...board]);
      shown.push({
        player: s.principal,
        cards: hole.get(s.principal)!.map(cardName),
        hand: categoryOf(score),
      });
      if (score > best) {
        best = score;
        winners = [s.principal];
      } else if (score === best) winners.push(s.principal);
    }
  }
  // The odd chip goes to the first winner in seat order, as it does at a real table. Splitting
  // with `Math.floor` alone destroys it, and the smoke's chip-conservation check is the only
  // thing that notices: a chip short per split pot reads as nothing until the totals are added.
  const share = Math.floor(pot / winners.length);
  let odd = pot - share * winners.length;
  for (const w of winners) seats.find((s) => s.principal === w)!.stack += share + (odd-- > 0 ? 1 : 0);

  await dealer.put({
    kind: RESULT,
    // STANDINGS ON EVERY HAND, not only the last one. Stacks are otherwise unpublished, and a
    // reader is left inferring them from whichever `action_request` last named a seat, which can
    // be several hands old and does not include the pot just awarded.
    body: stamp({
      session,
      handId,
      pot,
      winners,
      shown,
      board: board.map(cardName),
      standings: seats.map((s) => ({ player: s.principal, stack: s.stack })),
    }),
  }, `result:${session}:${handId}`);
  log(`  pot ${pot} to ${winners.map((w) => seats.find((s) => s.principal === w)!.name).join(", ")}`);

  return { handId, pot, winners, shown, foldedOnTimeout: timedOut, abandonedRequests: abandoned };
}

/** Poll for the action a player acked. The dealer never reads the player's decision any other way. */
async function waitForAction(
  dealer: RadiaClient,
  handId: string,
  street: Street,
  player: string,
  requestId: string,
  timeoutMs: number,
): Promise<ActionBody | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await dealer.readNewest<ActionBody>({
      kind: ACTION,
      match: { handId, street, player },
    });
    if (found && found.runtimeMeta.parentIds.includes(requestId)) return found.body;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scripted players
// ---------------------------------------------------------------------------

export type Strategy = (view: {
  hole: Card[];
  board: Card[];
  toCall: number;
  canRaise: boolean;
  pot: number;
}) => "fold" | "check" | "call" | "raise";

/** Deterministic strategies. Named so a smoke can assert that more than one of them wins. */
export const STRATEGIES: Record<string, Strategy> = {
  // Plays the strength of what it holds, which is the only one that reads the board.
  solid: ({ hole, board, toCall, canRaise }) => {
    // `evaluate7` ranks whatever it is given, so this works preflop on two cards as well.
    const strong = (evaluate7([...hole, ...board]) >>> 20) >= 1;
    if (strong && canRaise) return "raise";
    if (toCall === 0) return "check";
    return strong ? "call" : "fold";
  },
  // Calls anything, folds nothing. The control.
  calling: ({ toCall }) => (toCall === 0 ? "check" : "call"),
  // Raises whenever it is allowed to, regardless of cards.
  aggressive: ({ toCall, canRaise }) => (canRaise ? "raise" : toCall === 0 ? "check" : "call"),
  // Folds to any bet. Loses slowly and never bluffs.
  timid: ({ toCall }) => (toCall === 0 ? "check" : "fold"),
};

const fromName = (s: string): Card => {
  const r = RANKS.indexOf(s[0]);
  const u = SUITS.indexOf(s[1]);
  return u * 13 + r;
};

/**
 * Run one player until `stop` resolves.
 *
 * Everything this function can see, it sees through its own run token. It reads its hole cards
 * with a query that the server narrows to `{owner: self}`, and it writes its action as the ack of
 * the request it claimed, which the server authorizes as a put for the acting agent.
 */
export async function runPlayer(
  client: RadiaClient,
  principal: string,
  strategy: Strategy,
  stop: { done: boolean },
  onError?: (e: unknown) => void,
): Promise<void> {
  while (!stop.done) {
    try {
      const claim = await client.take<{
        session: string;
        team?: string;
        handId: string;
        street: Street;
        toCall: number;
        canRaise: boolean;
        betSize: number;
        pot: number;
        board: string[];
      }>({ pattern: { kind: ACTION_REQUEST, match: { player: principal } } }, { leaseSeconds: 30 });
      if (!claim) {
        await new Promise((r) => setTimeout(r, 15));
        continue;
      }
      const { session, team, handId, street, toCall, canRaise, betSize, pot, board } = claim.record.body;
      const mine = await client.readNewest<{ cards: string[] }>({ kind: HOLE, match: { handId, owner: principal } });
      const decision = strategy({
        hole: (mine?.body.cards ?? []).map(fromName),
        board: board.map(fromName),
        toCall,
        canRaise,
        pot,
      });
      await client.ack(claim.lease, {
        kind: ACTION,
        body: {
          session,
          // Copied off the request, because this player's own `action: put` grant is scoped to it
          // under a team and an unlabelled body matches no grant. A HARNESS player never does
          // this: the MCP adapter fills in whatever the caller's grant requires after the runtime
          // refuses the write for scope (`scope.fill`, src/surfaces/mcp/). A scripted client has
          // no such retry, so it carries the label forward itself.
          ...(team === undefined ? {} : { team }),
          handId,
          street,
          player: principal,
          type: decision === "raise" ? (toCall === 0 ? "bet" : "raise") : decision,
          amount: decision === "raise" ? toCall + betSize : decision === "call" ? toCall : 0,
        },
        parentIds: [claim.record.id],
      }, `action:${claim.record.id}`);
    } catch (e) {
      onError?.(e);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}
