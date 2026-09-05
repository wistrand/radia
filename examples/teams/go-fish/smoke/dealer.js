// A reference dealer program, in the shape the author member is asked to write: the smoke test
// runs the game with this one so the host is tested without a model. Deterministic given the
// setup task's id. Go Fish for `players` in turn order, ranks 1..`ranks`, four suits, five cards
// each, a book is all four of a rank.
//
// The protocol the players and the launcher speak, which a program MUST keep:
//   claimed task {phase: "setup", players, ranks}         -> deal; the game id is this task's id
//   claimed task {phase: "move", game, player, target, rank} -> apply the ask
//   puts: note {to: <player>, topic: "hand", game, cards}  (private hand, to its owner only)
//         note {to: "all", topic: "book", game, player, rank}
//         task {tags: [<next>], phase: "turn", game, players, ranks, title}
//         table {game, seq, state}                          (the dealer's own kind)
//   returns: note {to: <player>, topic: "reply", game, ...}, or {to: "all", topic: "final", game, books, winner}

const SUITS = ["H", "D", "C", "S"];

function rng(seed) {
  let s = 0;
  for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rankOf = (card) => card.slice(0, -1);

function books(state, player) {
  const hand = state.hands[player];
  const laid = [];
  for (let r = 1; r <= state.ranks; r++) {
    const rank = String(r);
    if (hand.filter((c) => rankOf(c) === rank).length === 4) {
      state.hands[player] = hand.filter((c) => rankOf(c) !== rank);
      state.books[player].push(rank);
      laid.push(rank);
    }
  }
  return laid;
}

function draw(state, player) {
  if (state.pile.length === 0) return null;
  const card = state.pile.pop();
  state.hands[player].push(card);
  return card;
}

function over(state) {
  const down = Object.values(state.books).reduce((n, b) => n + b.length, 0);
  if (down === state.ranks) return true;
  return state.pile.length === 0 && Object.values(state.hands).every((h) => h.length === 0);
}

function next(state, from) {
  const i = state.players.indexOf(from);
  for (let k = 1; k <= state.players.length; k++) {
    const p = state.players[(i + k) % state.players.length];
    if (state.hands[p].length > 0 || state.pile.length > 0) return p;
  }
  return from;
}

export default async function (record, space) {
  const b = record.body;
  if (b.phase === "setup") {
    const players = b.players, ranks = Number(b.ranks);
    const random = rng(record.id);
    const deck = [];
    for (let r = 1; r <= ranks; r++) for (const s of SUITS) deck.push(`${r}${s}`);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const state = { game: record.id, players, ranks, pile: deck, hands: {}, books: {}, turn: players[0], seq: 0 };
    for (const p of players) {
      state.hands[p] = [];
      state.books[p] = [];
    }
    for (let k = 0; k < 5; k++) for (const p of players) draw(state, p);
    const laid = [];
    for (const p of players) for (const rank of books(state, p)) laid.push({ player: p, rank });
    return await commit(space, state, null, { laid, event: "setup" });
  }
  if (b.phase !== "move") throw new Error(`unknown phase ${JSON.stringify(b.phase)}`);
  // The NEWEST table RECORD is the current table: a direction read, never "highest seq", since
  // the previous game's seq runs on past a new game's. The game id comes from the table, never
  // from the task: a player copies it forward and a player can forget, and a match on an undefined
  // field matches anything.
  const table = await space.readOne({ kind: "table", match: {}, dir: "desc" });
  if (!table) throw new Error("no table: the game was never dealt");
  const state = table.body.state;
  const { player, target } = b;
  const rank = String(b.rank);
  if (b.game && b.game !== state.game) {
    // A task from a game that is over or abandoned: refused, and NO turn handed on, or it loops.
    return { kind: "note", body: { to: player, topic: "reply", game: b.game, ok: false, event: "wrong-game", current: state.game } };
  }
  // NOT YOUR TURN is the one refusal that hands the turn back to whoever holds it, because that is
  // a different player and asking them again can succeed.
  if (state.turn !== player) return await refuse(space, state, player, "not-your-turn");
  // Anything else wrong with the ask WASTES the sender's turn, and the sender is the player on
  // turn: handing it back asks the same player again, who sends the same thing. Measured, a player
  // with an empty hand invented `{action: "draw"}`, got `unknown-target`, and the game died.
  const known = state.players.includes(target) && target !== player;
  if (!known || !state.hands[player].some((c) => rankOf(c) === rank)) {
    state.turn = next(state, player);
    return await commit(space, state, player, { event: known ? "illegal-ask" : "no-such-player", rank, laid: [] });
  }
  const taken = state.hands[target].filter((c) => rankOf(c) === rank);
  const laid = [];
  const reply = { rank, from: target };
  if (taken.length > 0) {
    state.hands[target] = state.hands[target].filter((c) => rankOf(c) !== rank);
    state.hands[player].push(...taken);
    reply.event = "got";
    reply.cards = taken;
    if (state.hands[target].length === 0) draw(state, target);
    state.turn = player; // keeps the turn
  } else {
    const drew = draw(state, player);
    reply.event = "go-fish";
    reply.drew = drew;
    state.turn = drew && rankOf(drew) === rank ? player : next(state, player);
  }
  for (const r of books(state, player)) laid.push({ player, rank: r });
  if (state.hands[player].length === 0) {
    draw(state, player);
    if (state.turn === player && state.hands[player].length === 0) state.turn = next(state, player);
  }
  return await commit(space, state, player, { ...reply, laid, changed: [player, ...(taken.length ? [target] : [])] });
}

/** An out-of-turn ask changes nothing, and the turn goes to whoever the table says holds it. */
async function refuse(space, state, player, event) {
  await space.put({
    kind: "task",
    body: { tags: [state.turn], phase: "turn", game: state.game, players: state.players, ranks: state.ranks, title: `${state.turn}'s turn` },
  });
  return { kind: "note", body: { to: player, topic: "reply", game: state.game, ok: false, event, turn: state.turn } };
}

/** Write the new table, the private hands, the public books and the next turn; return the reply. */
async function commit(space, state, player, reply) {
  state.seq += 1;
  await space.put({ kind: "table", body: { game: state.game, seq: state.seq, state } });
  const changed = reply.event === "setup" ? state.players : reply.changed ?? [player];
  for (const p of changed) {
    await space.put({ kind: "note", body: { to: p, topic: "hand", game: state.game, cards: state.hands[p] } });
  }
  for (const { player: p, rank } of reply.laid) {
    await space.put({ kind: "note", body: { to: "all", topic: "book", game: state.game, player: p, rank } });
  }
  if (over(state)) {
    const counts = Object.fromEntries(state.players.map((p) => [p, state.books[p].length]));
    const best = Math.max(...Object.values(counts));
    const winner = state.players.filter((p) => counts[p] === best);
    return { kind: "note", body: { to: "all", topic: "final", game: state.game, books: counts, winner: winner.length === 1 ? winner[0] : winner } };
  }
  await space.put({
    kind: "task",
    body: { tags: [state.turn], phase: "turn", game: state.game, players: state.players, ranks: state.ranks, title: `${state.turn}'s turn` },
  });
  const { laid, changed: _c, ...rest } = reply;
  return { kind: "note", body: { to: player ?? "all", topic: "reply", game: state.game, ok: true, ...rest, books: laid, turn: state.turn } };
}
