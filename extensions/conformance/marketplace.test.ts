// The marketplace convention against a live space (extensions/ts/marketplace.ts,
// agent_docs/design-marketplace.md). One space for the file; every test scopes itself by a `uniq`
// topic, because the kinds hold the other tests' records too.
//
// The cases that earn their place are the ones where the protocol fails SILENTLY: an awarder that
// reads bids the wrong way sees an empty auction and nacks a perfectly good request to
// `dead_letter`, and an awarder that reads a page picks a winner from an arbitrary prefix. Both
// were in the design as written, and both are cheap to reintroduce.

import { assert, assertEquals } from "@std/assert";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { bootSpace, uniq } from "./space.ts";
import {
  BID,
  type BidBody,
  bidderGrants,
  declareMarketKinds,
  eligibleBids,
  forgedBidRefusal,
  lateBidRefusal,
  openAuction,
  placeBid,
  reawardFailed,
  REQUEST,
  requesterGrants,
  runAuction,
  type Select,
  TASK,
  type Work,
} from "../ts/marketplace.ts";

const operator = await bootSpace(7883);
await declareMarketKinds(operator);

/** A requester and its bidders, each with the grants the convention says they hold. */
async function market(bidders: number): Promise<{ requester: RadiaClient; bids: { agent: string; client: RadiaClient }[] }> {
  const rq = `agent:${uniq("requester")}`;
  const rdef = await operator.createAgentDefinition(rq, requesterGrants(rq) as { principal: string; kind: string; operations: string[] }[]);
  const out = [];
  for (let i = 0; i < bidders; i++) {
    const agent = `agent:${uniq("bidder")}`;
    const d = await operator.createAgentDefinition(agent, bidderGrants(agent) as { principal: string; kind: string; operations: string[] }[]);
    out.push({ agent, client: new RadiaClient(operator.base, { definitionToken: d.definitionToken }) });
  }
  return { requester: new RadiaClient(operator.base, { definitionToken: rdef.definitionToken }), bids: out };
}

/** The requester's whole policy, which the runtime knows nothing about: lowest price wins. */
const cheapest: Select = (bids) =>
  bids.slice().sort((a, b) => Number(a.body.price ?? 0) - Number(b.body.price ?? 0))[0] ?? null;
const work: Work = () => ({ title: "do the thing" });

/**
 * Open an auction, bid INSIDE the window, and return once it has closed.
 *
 * A real window is the only way to be inside one, and that is the design rather than an
 * inconvenience: eligibility compares a bid's server-assigned `createdAt` against the request's
 * `availableAt`, so a zero-length window admits nothing, however fast the bids arrive.
 */
async function auctionWith(
  requester: RadiaClient,
  topic: string,
  entries: { client: RadiaClient; agent: string; price: number }[],
  windowSeconds = 1,
): Promise<string> {
  const { id } = await openAuction(requester, { topic, windowSeconds });
  for (const e of entries) await placeBid(e.client, id, e.agent, { price: e.price });
  const closes = Date.parse((await operator.getEnvelope(id))!.availableAt!);
  await new Promise((r) => setTimeout(r, Math.max(50, closes - Date.now() + 100)));
  return id;
}

Deno.test("[marketplace] the window is availableAt: readable while bidding, claimable only after", async () => {
  const topic = uniq("topic");
  const { requester, bids } = await market(1);
  const { id } = await openAuction(requester, { topic, windowSeconds: 60 });

  // A bidder sees it during the window, which is how it knows to bid at all.
  const seen = await bids[0].client.readOne({ kind: REQUEST, match: { topic } });
  assertEquals(seen?.id, id, "a deferred request is READABLE for the whole window");
  // And the awarder cannot end the auction early, because it is not a take candidate yet.
  assertEquals(await runAuction(requester, { select: cheapest, work, reopenSeconds: 1, topic }), { status: "idle" });
});

Deno.test("[marketplace] an award is one transaction: the request consumed and the task emitted", async () => {
  const topic = uniq("topic");
  const { requester, bids } = await market(3);
  const id = await auctionWith(requester, topic, [
    { ...bids[0], price: 30 },
    { ...bids[1], price: 10 },
    { ...bids[2], price: 20 },
  ]);

  const out = await runAuction(requester, { select: cheapest, work, reopenSeconds: 1, topic });
  assert(out.status === "awarded", JSON.stringify(out));
  assertEquals(out.winner, bids[1].agent, "the requester's policy decided, and the runtime ranked nothing");
  assertEquals(out.bids, 3);
  assertEquals((await operator.getEnvelope(id))!.state, "consumed", "the request is closed by the same ack");

  const task = (await operator.getRecord<{ assignee: string; request: string }>(out.task))!;
  assertEquals(task.body.assignee, bids[1].agent);
  assertEquals(task.body.request, id, "readable back as a query, not only as a children walk");
  // The award is a SHAPE: the task hangs off the request AND the bid that won it.
  assert(task.runtimeMeta.parentIds.includes(id), JSON.stringify(task.runtimeMeta.parentIds));
  const winningBid = (await operator.queryAll<{ bidder: string }>({ kind: BID, match: { request: id } }))
    .find((b) => b.body.bidder === bids[1].agent)!;
  assert(task.runtimeMeta.parentIds.includes(winningBid.id), "and names WHAT was accepted, not only who");

  // Only the winner may claim it, and it is ordinary work to everyone else.
  assertEquals(await bids[0].client.take({ pattern: { kind: TASK, match: { request: id } } }), null);
  const claimed = await bids[1].client.take({ pattern: { kind: TASK, match: { request: id } } });
  assertEquals(claimed?.record.id, out.task);
});

Deno.test("[marketplace] every bid is read, not a page: the awarder sees past the children limit", async () => {
  // `getChildren` pages at 100. An auction with more bidders than that is where selecting over a
  // page silently picks from an arbitrary prefix, which is this repo's most repeated defect.
  const topic = uniq("topic");
  const { requester, bids } = await market(1);
  const N = 130;
  const id = await auctionWith(
    requester,
    topic,
    Array.from({ length: N }, (_, i) => ({ ...bids[0], price: N - i })),
    5,
  );

  const page = await operator.getChildren(id);
  assert(page.length < N, `the page is bounded (${page.length}), which is why children is the wrong read`);
  const { eligible } = await eligibleBids(requester, id, new Date(Date.now() + 60_000).toISOString());
  assertEquals(eligible.length, N, "queryAll is exhaustive");
  const out = await runAuction(requester, { select: cheapest, work, reopenSeconds: 1, topic });
  assert(out.status === "awarded" && out.considered === N, JSON.stringify(out));
  // The cheapest bid was written LAST, so a prefix read would have missed it.
  const won = (await operator.getRecord<{ price: number }>((out as { task: string }).task))!;
  assert(won, "awarded from the whole population");
});

Deno.test("[marketplace] without `bid: query` the CHILDREN read lies and the queryAll read refuses", async () => {
  // The two reads fail differently, and that asymmetry is the reason the convention mandates one of
  // them. `children` is filtered to what the caller may read, so an awarder lacking the grant sees
  // an unbid auction and would nack a perfectly good request towards dead_letter, believing itself
  // correct. `queryAll` on the same data is refused outright, which is a bug report.
  const topic = uniq("topic");
  const { bids } = await market(1);
  const blind = `agent:${uniq("blind")}`;
  const d = await operator.createAgentDefinition(blind, [
    { principal: blind, kind: REQUEST, operations: ["put", "take", "query", "read_one"], scope: { createdBy: "self" } },
    { principal: blind, kind: TASK, operations: ["put"] },
    // deno-lint-ignore no-explicit-any
  ] as any);
  const client = new RadiaClient(operator.base, { definitionToken: d.definitionToken });
  const { id } = await openAuction(client, { topic, windowSeconds: 1 });
  await placeBid(bids[0].client, id, bids[0].agent, { price: 1 });

  assertEquals((await client.getChildren(id)).length, 0, "SILENT: a real bid reads as an empty auction");
  const refused = await client.queryAll({ kind: BID, match: { request: id } }).then(() => null, (e: Error) => e.message);
  assert(refused?.includes("no 'query' grant for kind 'bid'"), `LOUD: ${refused}`);
});

Deno.test("[marketplace] zero bids reopens the auction, and a late bid competes in the next round", async () => {
  const topic = uniq("topic");
  const { requester, bids } = await market(1);
  // A real window, waited out: a zero-length one is refused, because it admits no bid at all.
  const { id } = await openAuction(requester, { topic, windowSeconds: 0.05 });
  await new Promise((r) => setTimeout(r, 150));

  const first = await runAuction(requester, { select: cheapest, work, reopenSeconds: 1, topic });
  assert(first.status === "reopened" && first.bids === 0, JSON.stringify(first));
  const env = await operator.getEnvelope(id);
  assertEquals(env!.state, "available", "reopened, not consumed");
  assertEquals(env!.attempt, 1, "and a round is an attempt, which is what bounds them");
  assert(env!.availableAt > new Date().toISOString(), "the backoff IS the next window");

  // A bid arriving after round one's close is simply early for round two.
  await placeBid(bids[0].client, id, bids[0].agent, { price: 5 });
  await new Promise((r) => setTimeout(r, 1100));
  const second = await runAuction(requester, { select: cheapest, work, reopenSeconds: 1, topic });
  assert(second.status === "awarded" && second.winner === bids[0].agent, JSON.stringify(second));
});

Deno.test("[marketplace] a bid past the current close is held over rather than counted", async () => {
  const topic = uniq("topic");
  const { requester, bids } = await market(1);
  const { id, closesAt } = await openAuction(requester, { topic, windowSeconds: 0.05 });
  await new Promise((r) => setTimeout(r, 150));
  await placeBid(bids[0].client, id, bids[0].agent, { price: 9 });

  // Eligibility compares two SERVER-ASSIGNED instants, so nothing here trusts a body field.
  const { all, eligible } = await eligibleBids(requester, id, closesAt);
  assertEquals(all.length, 1);
  assertEquals(eligible.length, 0, "created after the close, so not this round's business");
  const later = await eligibleBids(requester, id, new Date(Date.now() + 60_000).toISOString());
  assertEquals(later.eligible.length, 1, "and eligible once the window it belongs to arrives");
});

Deno.test("[marketplace] a bid NAMED BY ID is judged by the window too, not only by its auction", async () => {
  const topic = uniq("topic");
  const { requester, bids } = await market(2);
  const id = await auctionWith(requester, topic, [{ ...bids[0], price: 10 }]);
  // An awarder that PICKS gets the window from `eligibleBids`. One handed a bid id does not, and
  // both such paths (`space_award`, `POST .../award`) checked only that the bid named this
  // auction, so this bid would have won by being asked for by name.
  const { id: lateId } = await placeBid(bids[1].client, id, bids[1].agent, { price: 1 });
  const late = (await operator.getRecord<BidBody>(lateId))!;
  const inTime = (await operator.queryAll<BidBody>({ kind: BID, match: { request: id } })).find((b) => b.id !== lateId)!;

  assertEquals(await lateBidRefusal(operator, id, inTime), null, "a bid from inside the window is awardable by id");
  const refusal = await lateBidRefusal(operator, id, late);
  assert(refusal?.includes("after this round closed"), String(refusal));
  // Unreadable is a refusal, never a fallback to now: the same wrong answer, silently.
  assert((await lateBidRefusal(bids[0].client, id, inTime))?.includes("cannot read the window"), "no envelope, no award");
});

Deno.test("[marketplace] a bid's `bidder` is checked against who WROTE it, where the caller can tell", async () => {
  const topic = uniq("topic");
  const { requester, bids } = await market(2);
  const { id } = await openAuction(requester, { topic, windowSeconds: 60 });
  // `bidder` is an ordinary body field, so this bid offers another agent's services.
  const { id: forgedId } = await placeBid(bids[0].client, id, bids[1].agent, { price: 1 });
  const { id: honestId } = await placeBid(bids[1].client, id, bids[1].agent, { price: 9 });
  const forged = (await operator.getRecord<BidBody>(forgedId))!;
  const honest = (await operator.getRecord<BidBody>(honestId))!;

  assert((await forgedBidRefusal(operator, forged))?.includes("never bid"), "the operator can resolve the run and refuses");
  assertEquals(await forgedBidRefusal(operator, honest), null);
  // A PRIVILEGED submitter bidding for somebody is not forgery: an operator seeds auctions this
  // way and a broker submits for an agent with no client of its own.
  const { id: onBehalf } = await placeBid(operator, id, bids[1].agent, { price: 5 });
  assertEquals(await forgedBidRefusal(operator, (await operator.getRecord<BidBody>(onBehalf))!), null);
  // FAIL-SOFT, and the limit is the point: attribution needs `agent_run`, which a requester does
  // not hold, so it awards as before rather than refusing work it cannot check.
  assertEquals(await forgedBidRefusal(requester, forged), null, "a caller that cannot attribute says nothing");
});

Deno.test("[marketplace] a failed winner is RE-AWARDED from the preserved bids, never re-auctioned", async () => {
  const topic = uniq("topic");
  const { requester, bids } = await market(2);
  const id = await auctionWith(requester, topic, [{ ...bids[0], price: 1 }, { ...bids[1], price: 2 }]);
  const first = await runAuction(requester, { select: cheapest, work, reopenSeconds: 1, topic });
  assert(first.status === "awarded" && first.winner === bids[0].agent, JSON.stringify(first));

  // The winner fails for good: the operator dead-letters its task, which is what repeated expiry
  // reaches on its own.
  await operator.admin("dead-letter", first.task);
  const repaired = await reawardFailed(requester, { select: cheapest, work });
  const mine = repaired.filter((r) => r.request === id);
  assertEquals(mine.length, 1);
  assert("winner" in mine[0] && mine[0].winner === bids[1].agent, JSON.stringify(mine[0]));

  // The bids were the recovery plan: no new request exists, and the runner-up holds the work.
  assertEquals((await operator.queryAll({ kind: REQUEST, match: { topic } })).length, 1, "no re-auction");
  const claimed = await bids[1].client.take({ pattern: { kind: TASK, match: { request: id } } });
  assert(claimed, "the runner-up can claim what it was re-awarded");

  // Repairing twice awards nobody, and the REASON is that a successor is already doing the work.
  // This case used to assert an exhausted bid list, which was the right answer for the wrong
  // reason: with only two bidders the tried-set happened to run out first, and with three it would
  // have awarded the same job again. The successor check is what actually stops it.
  const again = await reawardFailed(requester, { select: cheapest, work });
  const mineAgain = again.filter((r) => r.request === id);
  assertEquals(mineAgain.length, 1);
  assert("skipped" in mineAgain[0] && mineAgain[0].skipped === "successor-live", JSON.stringify(mineAgain[0]));
  const tasks = await operator.queryAll({ kind: TASK, match: { request: id } });
  assertEquals(tasks.length, 2, "the original and one successor, not three");
});

Deno.test("[marketplace] a policy that throws GIVES THE AUCTION BACK rather than stalling it", async () => {
  // `select` is the caller's own code and may throw. Everything after the claim runs while the
  // auction is leased, so without giving it back a thrown policy parks the auction until the lease
  // lapses and spends one of its bounded rounds on nothing.
  const topic = uniq("topic");
  const { requester, bids } = await market(1);
  const id = await auctionWith(requester, topic, [{ ...bids[0], price: 3 }]);

  const boom: Select = () => {
    throw new Error("the policy blew up");
  };
  let threw = "";
  await runAuction(requester, { select: boom, work, reopenSeconds: 1, topic }).catch((e: Error) => threw = e.message);
  assertEquals(threw, "the policy blew up", "the caller's error reaches the caller, unmasked");

  const env = await operator.getEnvelope(id);
  assertEquals(env!.state, "available", "and the auction is claimable again at once");
  assertEquals(env!.attempt, 0, "released, not nacked: a policy bug is not one of the auction's rounds");

  // Which means the very next pass can award it, with the same bids still standing.
  const out = await runAuction(requester, { select: cheapest, work, reopenSeconds: 1, topic });
  assert(out.status === "awarded" && out.winner === bids[0].agent, JSON.stringify(out));
});

Deno.test("[marketplace] repairing twice does not hand the same work to a THIRD bidder", async () => {
  // Found by probing with three bidders rather than two: a dead-lettered task stays dead-lettered,
  // so every later pass finds it again, and the `tried` filter alone does not stop the next pass
  // awarding to the next bidder while the previous successor is still doing the work. The
  // idempotency key then made it worse rather than safe: the second put differed in `assignee`, so
  // it THREW `idempotency_conflict` and a caller looping repairs crashed instead of resting.
  const topic = uniq("topic");
  const { requester, bids } = await market(3);
  const id = await auctionWith(requester, topic, [
    { ...bids[0], price: 1 },
    { ...bids[1], price: 2 },
    { ...bids[2], price: 3 },
  ]);
  const first = await runAuction(requester, { select: cheapest, work, reopenSeconds: 1, topic });
  assert(first.status === "awarded" && first.winner === bids[0].agent, JSON.stringify(first));
  await operator.admin("dead-letter", first.task);

  const one = (await reawardFailed(requester, { select: cheapest, work })).filter((r) => r.request === id);
  assertEquals(one.length, 1);
  assert("winner" in one[0] && one[0].winner === bids[1].agent, JSON.stringify(one[0]));

  const two = (await reawardFailed(requester, { select: cheapest, work })).filter((r) => r.request === id);
  assertEquals(two.length, 1);
  assert("skipped" in two[0] && two[0].skipped === "successor-live", JSON.stringify(two[0]));

  const tasks = await operator.queryAll<{ assignee: string }>({ kind: TASK, match: { request: id } });
  assertEquals(tasks.length, 2, "the original and ONE successor, never a third bidder on the same job");
  assert(!tasks.some((t) => t.body.assignee === bids[2].agent), "the third bidder was never given live work");
});

Deno.test("[marketplace] a repair judges the AUCTION's window, and sees the real request", async () => {
  // Two bugs in one case. The window: judging by `now` would let a bid that arrived after the close,
  // and was rightly kept out of the auction, win the work by attrition. The request: reading it by
  // a body field cannot work, because the row being repaired is a TASK and has no `topic`, so the
  // caller's policy was handed the failed task wearing a request's type.
  const topic = uniq("topic");
  const { requester, bids } = await market(3);
  const id = await auctionWith(requester, topic, [{ ...bids[0], price: 5 }, { ...bids[1], price: 9 }]);
  const first = await runAuction(requester, { select: cheapest, work, reopenSeconds: 1, topic });
  assert(first.status === "awarded", JSON.stringify(first));

  // The cheapest bid on the space, and far too late to be in this auction.
  await placeBid(bids[2].client, id, bids[2].agent, { price: 0 });
  await operator.admin("dead-letter", first.task);

  const seen: { kind?: string; topic?: unknown }[] = [];
  const watching: Work = (request) => {
    seen.push({ kind: request.kind, topic: request.body.topic });
    return { title: "repaired" };
  };
  const repaired = (await reawardFailed(requester, { select: cheapest, work: watching })).filter((r) => r.request === id);
  assertEquals(repaired.length, 1);
  assert("winner" in repaired[0], JSON.stringify(repaired[0]));
  assertEquals(repaired[0].winner, bids[1].agent, "the runner-up IN the auction, not the cheapest bid on the space");
  assertEquals(seen.length, 1);
  assertEquals(seen[0].kind, "request", "the policy is handed the auction, not the failed task");
  assertEquals(seen[0].topic, topic);
});

Deno.test("[marketplace] bids are sealed against BIDDERS by the grant alone", async () => {
  const topic = uniq("topic");
  const { requester, bids } = await market(2);
  const { id } = await openAuction(requester, { topic, windowSeconds: 1 });
  await placeBid(bids[0].client, id, bids[0].agent, { price: 7 });
  await placeBid(bids[1].client, id, bids[1].agent, { price: 8 });

  // A bidder holds `bid: put` and no read, so it cannot undercut what it cannot see. Self-scope is
  // what still lets it read its own, and the awarder reads them all.
  const rival = await bids[0].client.queryAll({ kind: BID, match: { request: id } }).catch(() => null);
  assert(rival === null || rival.length <= 1, `a bidder sees at most its own bid, saw ${rival?.length}`);
  const { eligible } = await eligibleBids(requester, id, new Date(Date.now() + 60_000).toISOString());
  assertEquals(eligible.length, 2, "while the awarder sees every one");
});
