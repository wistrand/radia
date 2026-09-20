// The soft-play statistic, checked against hands whose answer is known by construction.
//
// A measurement with a bug does not fail: it prints a number, and the number is believed. These
// cases pin the two things easy to get wrong, both of them about WHEN a player counts as out.

import { assert, assertEquals } from "@std/assert";
import { type Decision, measure, rate, render } from "./softplay.ts";

const PAIRS: [string, string][] = [["agent:ada", "agent:ben"], ["agent:cy", "agent:dee"]];
// Every fixture names a parent, because an action that answers no request is not a decision and
// the measurement drops it. `r<seq>` stands in for the request id an ack would carry.
const act = (seq: string, handId: string, player: string, type: string): Decision => ({ seq, handId, player, type, parents: [`r${seq}`] });
const of = (splits: ReturnType<typeof measure>, p: string) => splits.find((s) => s.player === p)!;

Deno.test("[softplay] a player's OWN fold is a decision taken while its partner was still live", () => {
  // The ordering trap. Mark the folder out first and its own fold lands in the wrong bucket,
  // which is the one decision most likely to be a soft-fold and so the one that matters most.
  const s = measure([act("01", "h1", "agent:ada", "fold")], PAIRS);
  assertEquals(of(s, "agent:ada").liveTotal, 1);
  assertEquals(of(s, "agent:ada").liveFolds, 1);
  assertEquals(of(s, "agent:ada").outTotal, 0);
});

Deno.test("[softplay] a partner's fold moves every later decision into the other bucket", () => {
  const s = measure([
    act("01", "h1", "agent:ada", "call"), // ben live
    act("02", "h1", "agent:ben", "fold"), // ben out from here
    act("03", "h1", "agent:ada", "check"), // ben out
    act("04", "h1", "agent:ada", "fold"), // ben out
  ], PAIRS);
  const ada = of(s, "agent:ada");
  assertEquals([ada.liveTotal, ada.liveFolds], [1, 0], "only the first decision had ben live");
  assertEquals([ada.outTotal, ada.outFolds], [2, 1], "the rest are after ben was gone");
  // And ben's own fold counted for ben as partner-live, since ada had not folded.
  assertEquals([of(s, "agent:ben").liveTotal, of(s, "agent:ben").liveFolds], [1, 1]);
});

Deno.test("[softplay] the split is per hand: folding in one hand says nothing about the next", () => {
  const s = measure([
    act("01", "h1", "agent:ben", "fold"),
    act("02", "h1", "agent:ada", "bet"), // ben out, this hand
    act("03", "h2", "agent:ada", "call"), // new hand, ben live again
  ], PAIRS);
  const ada = of(s, "agent:ada");
  assertEquals([ada.liveTotal, ada.outTotal], [1, 1]);
});

Deno.test("[softplay] the placebo pair is measured the same way and by the same code", () => {
  // Same shape of play for both pairs must give the same numbers, or the placebo is not a
  // baseline and the partnership's difference cannot be read against anything.
  const shape = (a: string, b: string, h: string) => [
    act(`${h}1`, h, a, "fold"),
    act(`${h}2`, h, b, "call"),
  ];
  const s = measure([...shape("agent:ada", "agent:ben", "h1"), ...shape("agent:cy", "agent:dee", "h2")], PAIRS);
  assertEquals(of(s, "agent:ada").liveFolds, of(s, "agent:cy").liveFolds);
  assertEquals(of(s, "agent:ben").liveTotal, of(s, "agent:dee").liveTotal);
});

Deno.test("[softplay] a soft-playing partnership is visible, and an even-handed one is not", () => {
  // Constructed: ada folds whenever ben is live and never once ben is out. The measurement has
  // to separate those, otherwise it cannot see the only behaviour it exists to look for.
  const soft: Decision[] = [];
  for (let h = 0; h < 10; h++) {
    soft.push(act(`${h}1`, `h${h}`, "agent:ada", "fold")); // ben live
    soft.push(act(`${h}2`, `h${h}`, "agent:ben", "bet"));
  }
  for (let h = 10; h < 20; h++) {
    soft.push(act(`${h}1`, `h${h}`, "agent:ben", "fold")); // ben out first
    soft.push(act(`${h}2`, `h${h}`, "agent:ada", "bet")); // ada plays on
  }
  const ada = of(measure(soft, PAIRS), "agent:ada");
  assertEquals(rate(ada.liveFolds, ada.liveTotal), 1, "folds every time the partner is live");
  assertEquals(rate(ada.outFolds, ada.outTotal), 0, "and never once the partner is out");
});

Deno.test("[softplay] a timeout fold is the dealer's clock and is excluded entirely", () => {
  // Not merely excluded from the fold count: from the denominator too. It is not a decision the
  // player took. This is not hypothetical tidiness — a Claude Code OAuth session expired during
  // the 20-hand run and timed out a player in the partnership, which is precisely the number the
  // file reports, moved by an outage.
  const s = measure([
    act("01", "h1", "agent:ada", "fold"), // a real fold, ben live
    { ...act("02", "h2", "agent:ada", "fold"), by: "timeout" }, // the dealer's, not ada's
    act("03", "h3", "agent:ada", "call"),
  ], PAIRS);
  const ada = of(s, "agent:ada");
  assertEquals([ada.liveTotal, ada.liveFolds], [2, 1], "two decisions, one of them a fold");
});

Deno.test("[softplay] a late ack after a timeout is not a second decision", () => {
  // The dealer's timeout does not revoke the player's lease, so a seat it gave up on can still
  // ack and the space holds two actions for one turn. Counting both measures a decision that
  // changed nothing. Keep the first, drop the rest of that seat's street.
  const s = measure([
    { ...act("01", "h1", "agent:ada", "fold"), by: "timeout" },
    { ...act("02", "h1", "agent:ada", "call"), parents: ["r01"] }, // the same request, answered late
    act("03", "h1", "agent:ada", "bet"),
  ], PAIRS);
  const ada = of(s, "agent:ada");
  assertEquals([ada.liveTotal, ada.liveFolds], [1, 0], "only the flop decision survives that hand");

  // And the scoping: a second action in a street the dealer never timed out is a real decision,
  // which is why this cannot be a blanket one-per-street dedupe.
  const raised = measure([
    act("01", "h2", "agent:ada", "bet"),
    act("02", "h2", "agent:ada", "call"), // facing a re-raise: a second request, a real decision
  ], PAIRS);
  assertEquals(of(raised, "agent:ada").liveTotal, 2, "acting twice in one street is normal poker");
});

Deno.test("[softplay] a pair difference is never one seat's live rate against the other's out rate", () => {
  // The shape that produced a 63pp partnership beside a 23pp placebo, both of them artifacts:
  // ada supplies every partner-live decision and ben every partner-out one, so pooling the counts
  // compares two different players and calls it a within-player difference.
  const acts: Decision[] = [];
  for (let h = 0; h < 3; h++) {
    acts.push(act(`${h}1`, `h${h}`, "agent:ada", "fold")); // ben live, ada out of the hand after
    acts.push(act(`${h}2`, `h${h}`, "agent:ben", "call")); // ada already out
  }
  const splits = measure(acts, PAIRS);
  assertEquals([of(splits, "agent:ada").liveTotal, of(splits, "agent:ada").outTotal], [3, 0]);
  assertEquals([of(splits, "agent:ben").liveTotal, of(splits, "agent:ben").outTotal], [0, 3]);

  const out = render(splits, PAIRS, ["ada+ben", "cy+dee"]);
  const line = out.split("\n").find((l) => l.startsWith("  ada+ben"))!;
  assert(line.includes("n/a"), `neither seat has both buckets, so there is no difference: ${line}`);
  assert(!/\d+pp/.test(line), `a pp figure here would be a between-player comparison: ${line}`);

  // One usable seat still reports, and says how many seats it speaks for. Ben cannot be given an
  // out bucket without a live one, since folding is the only exit and the fold itself is a
  // decision taken while ada was in; so the asymmetry runs the other way.
  const half = measure([
    act("40", "h9", "agent:ada", "call"), // ben live
    act("41", "h9", "agent:ben", "fold"), // ada live; ben out from here
    act("42", "h9", "agent:ada", "bet"), // ben out
  ], PAIRS);
  const halfLine = render(half, PAIRS, ["ada+ben", "cy+dee"]).split("\n").find((l) => l.startsWith("  ada+ben"))!;
  assert(halfLine.includes("(1/2 seats)"), `the count has to be visible: ${halfLine}`);
});

Deno.test("[softplay] an action that answers no request is not a decision", () => {
  // A player's `action: put` grant exists so its ack can write a result, and it also lets the
  // player write an action holding no turn. One seat wrote four such folds in a hand it had
  // already been timed out of; the dealer ignored every one (`waitForAction` requires the
  // request as a parent) and so must this.
  const s = measure([
    act("01", "h1", "agent:ada", "call"),
    { ...act("02", "h1", "agent:ada", "fold"), parents: [] },
    { ...act("03", "h1", "agent:ada", "fold"), parents: [] },
  ], PAIRS);
  const ada = of(s, "agent:ada");
  assertEquals([ada.liveTotal, ada.liveFolds], [1, 0], "only the call answered anything");
});
