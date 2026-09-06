// Request / bid / award as a CONVENTION over the kernel, with no runtime support of any kind.
//
// agent_docs/design-marketplace.md is the design and its eight settled questions; this file is
// that design and nothing more. Three built primitives carry the whole protocol:
//
//   THE BIDDING WINDOW is `availableAt` on the request. A record deferred to a future instant is
//   readable (query, read_one) and is NOT a take candidate, so bidders find the request and attach
//   bids for the whole window while nobody can award it early. At the close it becomes claimable.
//
//   SELECTION is `take` then `ack`. Claiming the request IS the exclusive right to award it: at
//   most one valid lease means one awarder, and fencing stops a slow one awarding behind a
//   reassignment. The `ack` consumes the request and emits the assigned task in ONE transaction.
//
//   THE AWARD IS NOT A RECORD, it is a shape: the assigned task, parented to the request and to the
//   winning bid, carrying `assignee` and `request`. There is no `award` kind and nothing to
//   reconcile, because an ack emits exactly one result and this protocol needs exactly one.
//
// Two rules here exist because breaking them fails SILENTLY, which is the whole reason this file
// is not left to each caller: bids are read with `queryAll` on a body field and never through
// `children` (see `eligibleBids`), and an awarder must hold `bid: query` or it reads nothing at all
// and every auction looks empty.

import type { KindDef, Pattern, RadiaClient, RadiaRecord } from "../../sdk/ts/client.ts";
// `declareKind`/`liveKinds` live in team.ts and are not about teams: any app declaring over a kind
// another app owns needs them, and `task` is exactly that here (the teams convention indexes it on
// `team`, `assignee` and `tags`, and this one adds `request`). Their own doc comment says so.
import { declareKind, liveKinds } from "./team.ts";

export const REQUEST = "request";
export const BID = "bid";
/** Reused deliberately rather than invented: `assignee` is already indexed on it, so awarded work
 *  is WORK, understood by ordinary claimants, `radia doctor` and the starvation check alike. */
export const TASK = "task";

export interface RequestBody {
  topic: string;
  /** The same instant as the envelope's `availableAt`. Carried in the body too so a reader can see
   *  the window without an ops-plane envelope read; the ENVELOPE is what enforces it. */
  closesAt: string;
  [k: string]: unknown;
}

export interface BidBody {
  /** Indexed, and the reason the awarder can read bids at all: the read is a data-plane query on
   *  this field, never an ops-plane `children` walk. */
  request: string;
  bidder: string;
  [k: string]: unknown;
}

/** Opaque to the runtime by design (question 4): the kernel supplies lineage, immutability and
 *  one-winner, and ranking is the requester's policy. Indexing a bid field is still fine; ordering
 *  it is an index, not a policy. */
export const MARKET_KINDS: KindDef[] = [
  {
    kind: REQUEST,
    indexedPaths: [{ path: "topic", type: "keyword" }],
    claimable: true,
    usage: "Work put out to bid. body: {topic, closesAt, …spec}. Readable for the whole window " +
      "and claimable only after it, because `availableAt` is the close: bid while you can see it, " +
      "and claiming it is the right to AWARD it, which belongs to whoever wrote it.",
  },
  {
    kind: BID,
    indexedPaths: [{ path: "request", type: "keyword" }, { path: "bidder", type: "keyword" }],
    claimable: false,
    usage: "An offer on one request. body: {request, bidder, …terms}. Terms are yours: nothing " +
      "in the runtime ranks them. Name the request in the BODY as well as in parentIds, since " +
      "that field is how the awarder reads every bid rather than a page of them.",
  },
];

/** The awarded task's addition to whatever `task` already is. Merged, never restated: another
 *  convention's paths survive this declaration (`mergeKind`). */
export const TASK_ADDITION: KindDef = {
  kind: TASK,
  indexedPaths: [{ path: "assignee", type: "keyword" }, { path: "request", type: "keyword" }],
  claimable: true,
};

/** What `task` should SAY where nothing else has said anything. Supplied only then: on a space that
 *  already runs the teams convention, that string is the better one and `mergeKind` keeps it. */
const TASK_USAGE_IF_NEW = "Work for whoever can do it. body: {title, detail?, tags?, assignee?}. " +
  "An AWARDED task also carries `request`, naming the auction it came from, and `assignee`, naming " +
  "the bid that won it; only that agent may claim it. Settle with an ack, never a separate put.";

export async function declareMarketKinds(admin: RadiaClient): Promise<string[]> {
  const live = await liveKinds(admin);
  const task = live.get(TASK)?.def.usage ? TASK_ADDITION : { ...TASK_ADDITION, usage: TASK_USAGE_IF_NEW };
  for (const def of [...MARKET_KINDS, task]) await declareKind(admin, def, live);
  return [REQUEST, BID, TASK];
}

/** A grant record body, including the fields `RadiaClient.grant` has no parameter for. */
type Grant = { principal: string; kind: string; operations: string[]; pattern?: Record<string, unknown>; scope?: Record<string, unknown> };

/**
 * What a REQUESTER holds. Self-scope on `request` is the whole answer to "who may award" (question
 * 7): an agent awards its own auctions and structurally cannot touch anyone else's, so there is no
 * auctioneer role and therefore no principal that routes all work in the space.
 *
 * `bid: query` is UNSCOPED and cannot be otherwise, which is this design's one real cost: several
 * requesters in a space can read each other's bids, so sealing holds against bidders and not
 * against fellow awarders. Without it the awarder reads nothing and every auction looks empty.
 */
export function requesterGrants(agent: string): Grant[] {
  return [
    { principal: agent, kind: REQUEST, operations: ["put", "take", "query", "read_one"], scope: { createdBy: "self" } },
    { principal: agent, kind: BID, operations: ["query", "read_one"] },
    // Self-scoped `query` is also what makes the requester ops-eligible for the envelopes of the
    // records it wrote, which is how a failed winner is noticed at all (question 2).
    { principal: agent, kind: TASK, operations: ["put", "query", "read_one"], scope: { createdBy: "self" } },
  ];
}

/**
 * What a BIDDER holds. It reads requests, writes bids, and claims work addressed to it.
 *
 * The take grant on `task` and the ability to bid are issued TOGETHER on purpose: a bidder that can
 * bid but was never granted `task: take {assignee: self}` wins and can never claim its prize, and
 * that presents as a no-show the awarder cannot tell from a crash (question 2).
 */
export function bidderGrants(agent: string): Grant[] {
  return [
    { principal: agent, kind: REQUEST, operations: ["query", "read_one"] },
    { principal: agent, kind: BID, operations: ["put"] },
    { principal: agent, kind: TASK, operations: ["take"], pattern: { assignee: agent } },
  ];
}

/** Open an auction: one record, readable now, claimable at `closesAt`. */
export async function openAuction(
  client: RadiaClient,
  o: { topic: string; windowSeconds: number; body?: Record<string, unknown>; now?: string },
): Promise<{ id: string; closesAt: string }> {
  // A zero or negative window is an auction NOBODY can win: `availableAt` is clamped forward to
  // now, so it is claimable at once, while every bid necessarily arrives after the close and is
  // therefore ineligible. It would reopen each round until the attempt ceiling dead-lettered it.
  if (!(o.windowSeconds > 0)) {
    throw new Error(`windowSeconds must be positive: a window of ${o.windowSeconds} admits no bid at all`);
  }
  const base = o.now ? Date.parse(o.now) : Date.now();
  const closesAt = new Date(base + o.windowSeconds * 1000).toISOString();
  const { id } = await client.put({
    kind: REQUEST,
    body: { ...(o.body ?? {}), topic: o.topic, closesAt },
    availableAt: closesAt,
  });
  return { id, closesAt };
}

/** Place a bid. The request id goes in the body AND the parents: one is how it is read, the other
 *  is how it is proven to belong to that auction. */
export async function placeBid(
  client: RadiaClient,
  request: string,
  bidder: string,
  terms: Record<string, unknown> = {},
): Promise<{ id: string }> {
  return await client.put({
    kind: BID,
    body: { ...terms, request, bidder },
    parentIds: [request],
  });
}

/**
 * Every bid on one request, EXHAUSTIVELY, filtered to the ones the window admits.
 *
 * Two failures live here and both are silent. `children` is filtered by what the CALLER may read
 * ("reaching a visible record does not make everything hanging off it visible", `handleChildren`),
 * so an awarder reading children gets an empty list and the auction looks unbid. And `getChildren`
 * is a PAGE, so selecting from it drops every bid past the page with the survivors decided by id
 * order, which is this codebase's most repeated defect class (plan-bounded-reads.md).
 *
 * ELIGIBILITY compares two SERVER-ASSIGNED instants, so a bidder cannot backdate and the awarder
 * trusts nothing: a bid's `createdAt` against the request's `availableAt` at the moment of the
 * claim. After a nack that is the CURRENT round's close, so one rule covers every round: earlier
 * rounds' bids stay eligible, and a bid that missed a round competes in the next.
 */
export async function eligibleBids(
  client: RadiaClient,
  request: string,
  closesAt: string,
): Promise<{ all: RadiaRecord<BidBody>[]; eligible: RadiaRecord<BidBody>[] }> {
  const all = await client.queryAll<BidBody>({ kind: BID, match: { request } });
  const eligible = all.filter((b) => b.runtimeMeta.createdAt <= closesAt);
  return { all: [...all], eligible };
}

export type Select = (bids: RadiaRecord<BidBody>[], request: RadiaRecord<RequestBody>) => RadiaRecord<BidBody> | null;
export type Work = (request: RadiaRecord<RequestBody>, winner: RadiaRecord<BidBody>) => Record<string, unknown>;

export type AuctionOutcome =
  | { status: "idle" }
  | { status: "awarded"; request: string; winner: string; task: string; bids: number; considered: number }
  | { status: "reopened"; request: string; bids: number; considered: number }
  /** The settle itself failed, so this awarder is fenced and somebody else holds the auction. NOT
   *  reported as "reopened", which would say this run put it back when it did no such thing. */
  | { status: "lost"; request: string; reason: string };

/**
 * One award cycle: claim a closed request, read its bids, pick, and settle.
 *
 * ZERO BIDS IS A NACK whose backoff is the next window (question 3), which is the same mechanism as
 * opening one, since nack rewrites `available_at`. A nack is right here and a refusal-as-answer is
 * not, by the test that decides every such case: redelivery CAN change the outcome, because a
 * bidder may arrive between rounds. `maxAttempts` rounds later the request dead-letters, which is
 * the escalation and needs no kind of its own. "No acceptable bid" is the same case: return null
 * from `select` and the auction reopens.
 */
export async function runAuction(
  client: RadiaClient,
  o: { select: Select; work: Work; reopenSeconds: number; topic?: string; leaseSeconds?: number },
): Promise<AuctionOutcome> {
  const pattern: Pattern = o.topic ? { kind: REQUEST, match: { topic: o.topic } } : { kind: REQUEST };
  const claimed = await client.take({ pattern }, { leaseSeconds: o.leaseSeconds ?? 60 });
  if (!claimed) return { status: "idle" };
  const request = claimed.record as RadiaRecord<RequestBody>;
  // GIVE THE CLAIM BACK on any failure below. Everything from here on can throw, `select` above
  // all, since it is the caller's own policy; a thrown error would otherwise leave the auction
  // leased until the lease lapsed, which costs it one of its bounded rounds for nothing.
  try {
    // The CURRENT round's close, from the envelope: a nack rewrote it and the body still names
    // round one, so trusting the body would exclude every later round's bids and the auction could
    // never be won. Loud rather than silent when it cannot be read, since that is a grant that was
    // never issued (`requesterGrants` carries the self-scoped query this needs).
    const env = await client.getEnvelope(request.id);
    if (!env?.availableAt) {
      throw new Error(
        `cannot read the window of ${request.id}: an awarder needs a self-scoped 'request: query' grant, ` +
          `or every round after the first would judge bids against the wrong close`,
      );
    }
    const { all, eligible } = await eligibleBids(client, request.id, env.availableAt);
    const winner = eligible.length > 0 ? o.select(eligible, request) : null;
    if (!winner) {
      await client.nack(claimed.lease, { backoffSeconds: o.reopenSeconds });
      return { status: "reopened", request: request.id, bids: all.length, considered: eligible.length };
    }
    const acked = await client.ack(claimed.lease, {
      kind: TASK,
      body: { ...o.work(request, winner), assignee: winner.body.bidder, request: request.id },
      // The request is force-prepended by the settle path; the winning bid is the parent that makes
      // the award auditable, since it names WHAT was accepted and not merely who.
      parentIds: [winner.id],
    });
  // A fenced awarder cannot lose the lease here without the ack saying so, and an award nobody can
  // point at is worse than a refusal. No nack follows: the lease is not ours to give back, and
  // calling this "reopened" would credit this run with a reopening somebody else's fencing did.
    if (acked.status !== "ok" || !acked.resultId) {
      return { status: "lost", request: request.id, reason: acked.status };
    }
    return {
      status: "awarded",
      request: request.id,
      winner: winner.body.bidder,
      task: acked.resultId,
      bids: all.length,
      considered: eligible.length,
    };
  } catch (e) {
    // Best effort, and it must not mask the real error: a lease already lost refuses the release.
    await client.release(claimed.lease).catch(() => {});
    throw e;
  }
}

export type RepairOutcome =
  | { failed: string; request: string; winner: string; task: string }
  | { failed: string; request: string; exhausted: true }
  /** Nothing to do, and saying which is the difference between a quiet pass and a lost repair. */
  | { failed: string; request: string; skipped: "successor-live" | "auction-unreadable" | "successors-unreadable" };

/**
 * Re-award work whose winner failed, from the bids that were preserved.
 *
 * The bid list IS the recovery plan, which is why "all bids preserved unchanged" is an invariant
 * worth stating rather than a restatement of record immutability. A new auction is the LAST resort
 * and this never runs one: it picks the next eligible bid from the same request and assigns to it.
 *
 * `state` selects which failure is being repaired. `dead_letter` is a winner that tried and could
 * not; `available` past a grace period is one that never claimed at all, which the starvation check
 * reports as ORPHANED and which is indistinguishable from a bidder that was never granted
 * `task: take {assignee: self}`.
 */
export async function reawardFailed(
  client: RadiaClient,
  o: { select: Select; work: Work; state?: "dead_letter" | "available"; staleSeconds?: number; limit?: number },
): Promise<RepairOutcome[]> {
  const rows = await client.queryEnvelopes({ state: o.state ?? "dead_letter", kind: TASK, limit: o.limit ?? 100 });
  const out: RepairOutcome[] = [];
  for (const row of rows) {
    const body = row.record?.body as { request?: string; assignee?: string } | undefined;
    if (!body?.request || !body.assignee) continue;
    if (o.staleSeconds && Date.now() - Date.parse(row.record!.runtimeMeta.createdAt) < o.staleSeconds * 1000) continue;

    // ONE REPAIR PER FAILURE. A dead-lettered task stays dead-lettered, so it is found on every
    // later pass; without this the second pass awards the SAME work to a third bidder while the
    // second is still doing it, and the idempotency key then turns that into a thrown
    // `idempotency_conflict` rather than a quiet no-op, because the body differs. The successor is
    // parented on the failure, so its existence is the record of "already repaired".
    // An unreadable children walk is NOT "no successor". Treating it as one is how the
    // double-award comes back: the safe reading of "I cannot tell" is to do nothing.
    const successors = await client.getChildren(row.envelope.recordId).catch(() => null);
    if (!successors) {
      out.push({ failed: row.envelope.recordId, request: body.request, skipped: "successors-unreadable" });
      continue;
    }
    if (successors.some((k) => k.kind === TASK)) {
      out.push({ failed: row.envelope.recordId, request: body.request, skipped: "successor-live" });
      continue;
    }

    // The REAL auction record, by id. Reading it by a body field cannot work: this row is a TASK,
    // so its `topic` is undefined and the match would name some other auction or none, and the
    // caller's `select` and `work` would be handed that instead of the request they are judging.
    const request = await client.getRecord<RequestBody>(body.request).catch(() => null);
    const auctionEnv = await client.getEnvelope(body.request).catch(() => null);
    if (!request || !auctionEnv?.availableAt) {
      out.push({ failed: row.envelope.recordId, request: body.request, skipped: "auction-unreadable" });
      continue;
    }
    // The auction's OWN close, never now: judging by now would let a bid that arrived after the
    // window, and was rightly refused a place in the auction, win the work by attrition instead.
    const { eligible } = await eligibleBids(client, body.request, auctionEnv.availableAt);
    // Everyone already tried is out: the same failing assignee must not win the retry.
    const tried = new Set(
      (await client.queryAll<{ assignee?: string; request?: string }>({ kind: TASK, match: { request: body.request } }))
        .map((t) => t.body.assignee).filter(Boolean) as string[],
    );
    const fresh = eligible.filter((b) => !tried.has(b.body.bidder));
    const next = fresh.length > 0 ? o.select(fresh, request) : null;
    if (!next) {
      out.push({ failed: row.envelope.recordId, request: body.request, exhausted: true });
      continue;
    }
    // NOT fenced: the request is long consumed, so this is an ordinary put. Keyed on the failed
    // task so a second requester repairing the same failure replays instead of awarding twice,
    // for the idempotency window and no longer.
    const { id } = await client.put({
      kind: TASK,
      body: {
        ...o.work(request, next),
        assignee: next.body.bidder,
        request: body.request,
      },
      parentIds: [row.envelope.recordId, next.id],
    }, `reaward:${row.envelope.recordId}`);
    out.push({ failed: row.envelope.recordId, request: body.request, winner: next.body.bidder, task: id });
  }
  return out;
}
