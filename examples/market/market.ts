// A market of scripted bidders: no models, no orchestrator, a different winner most runs.
//
//   deno task test:market            # a whole market against a space this spawns
//   deno run -A examples/market/market.ts --url … --rounds 8
//
// The convention is `extensions/ts/marketplace.ts` and the design is
// agent_docs/design-marketplace.md. What this example is FOR is watching contention resolve
// without an arbiter: five bidders with different pricing strategies compete for jobs they can all
// do, the requester picks by its own private policy, and who wins is not knowable in advance
// because each strategy reacts to what it has already won.
//
// Nothing here needs a model. The strategies are three lines each, and that is the point: the
// interesting behaviour is the market, not the bidder.

import { RadiaClient } from "../../sdk/ts/client.ts";
import {
  BID,
  bidderGrants,
  declareMarketKinds,
  openAuction,
  placeBid,
  REQUEST,
  requesterGrants,
  runAuction,
  type Select,
  TASK,
  type Work,
} from "../../extensions/ts/marketplace.ts";

export interface Strategy {
  name: string;
  /** What to charge for this job, given what this bidder has already won. `null` declines. */
  price: (job: Job, won: number) => number | null;
}

export interface Job {
  topic: string;
  size: number;
}

/**
 * Five bidders, each a different theory of how to price work, chosen so that NONE dominates.
 *
 * A first draft had `burst` undercut `cheap` by one and `cheap` undercut the rest, so the market
 * resolved identically whatever the jobs were: a demonstration of arithmetic rather than of
 * contention. These cross over instead. `cheap` beats `bulk` below size five and loses above it,
 * they tie exactly at five, and `greedy` is the best bid in the room until it wins a couple. Which
 * strategy leads therefore depends on the sequence of jobs and on what has already been won, which
 * is what makes a run worth watching.
 */
export const STRATEGIES: Strategy[] = [
  // Linear and keen. Cheapest on small jobs, priced out of large ones.
  { name: "cheap", price: (job) => job.size * 4 },
  // A fixed setup cost it spreads over the work: bad at small, hard to beat at large.
  { name: "bulk", price: (job) => 10 + job.size * 2 },
  // Prices by what it already holds, so every win makes the next bid worse. Leads, then fades.
  { name: "greedy", price: (job, won) => job.size * 3 + won * 6 },
  // Declines small work outright rather than bidding badly for it.
  { name: "picky", price: (job) => (job.size >= 6 ? job.size * 3 + 4 : null) },
  // Capacity is finite and it says so: two jobs, then it stops bidding.
  { name: "burst", price: (job, won) => (won < 2 ? job.size * 3 : null) },
];

/** The requester's policy, which the runtime knows nothing about: cheapest eligible bid wins,
 *  ties broken by who has won least, so a market that would otherwise lock up keeps moving. */
export function cheapestFairest(won: Map<string, number>): Select {
  return (bids) =>
    bids.slice().sort((a, b) => {
      const pa = Number(a.body.price ?? 0), pb = Number(b.body.price ?? 0);
      if (pa !== pb) return pa - pb;
      return (won.get(a.body.bidder) ?? 0) - (won.get(b.body.bidder) ?? 0);
    })[0] ?? null;
}

export interface RunReport {
  rounds: number;
  awarded: number;
  reopened: number;
  wonBy: Record<string, number>;
  spend: number;
  log: string[];
}

/**
 * Run a whole market: mint the principals, then auction `rounds` jobs one at a time.
 *
 * Each round is a real auction with a real window, because eligibility compares server clocks:
 * a bid is in the round whose close it precedes, and there is no way to fake being inside one.
 */
export async function runMarket(
  operator: RadiaClient,
  o: { rounds: number; windowMs?: number; seed?: number; log?: (line: string) => void },
): Promise<RunReport> {
  const say = o.log ?? (() => {});
  const stamp = Date.now().toString(36);
  await declareMarketKinds(operator);

  const rq = `agent:buyer-${stamp}`;
  const rdef = await operator.createAgentDefinition(rq, requesterGrants(rq) as { principal: string; kind: string; operations: string[] }[]);
  const requester = new RadiaClient(operator.base, { definitionToken: rdef.definitionToken });

  const bidders: { strategy: Strategy; agent: string; client: RadiaClient }[] = [];
  for (const strategy of STRATEGIES) {
    const agent = `agent:${strategy.name}-${stamp}`;
    const d = await operator.createAgentDefinition(agent, bidderGrants(agent) as { principal: string; kind: string; operations: string[] }[]);
    bidders.push({ strategy, agent, client: new RadiaClient(operator.base, { definitionToken: d.definitionToken }) });
  }

  const won = new Map<string, number>();
  const report: RunReport = { rounds: o.rounds, awarded: 0, reopened: 0, wonBy: {}, spend: 0, log: [] };
  const windowMs = o.windowMs ?? 400;
  // A tiny deterministic generator, so a seeded run repeats exactly and an unseeded one does not.
  let s = (o.seed ?? Date.now()) >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  for (let round = 1; round <= o.rounds; round++) {
    const job: Job = { topic: `job-${stamp}-${round}`, size: 2 + Math.floor(rnd() * 7) };
    const { id } = await openAuction(requester, {
      topic: job.topic,
      windowSeconds: windowMs / 1000,
      body: { size: job.size },
    });

    const offers: string[] = [];
    for (const b of bidders) {
      const price = b.strategy.price(job, won.get(b.agent) ?? 0);
      if (price === null) continue;
      await placeBid(b.client, id, b.agent, { price });
      offers.push(`${b.strategy.name} ${price}`);
    }
    await new Promise((r) => setTimeout(r, windowMs + 120));

    const out = await runAuction(requester, {
      select: cheapestFairest(won),
      work: ((request) => ({ title: `job ${request.body.topic}`, size: job.size })) as Work,
      reopenSeconds: 1,
      topic: job.topic,
    });

    if (out.status === "awarded") {
      const name = out.winner.replace(/^agent:/, "").replace(`-${stamp}`, "");
      won.set(out.winner, (won.get(out.winner) ?? 0) + 1);
      report.wonBy[name] = (report.wonBy[name] ?? 0) + 1;
      const price = Number(
        (await requester.queryAll<{ bidder: string; price: number }>({ kind: BID, match: { request: id } }))
          .find((b) => b.body.bidder === out.winner)?.body.price ?? 0,
      );
      report.spend += price;
      report.awarded++;
      const line = `round ${round}  size ${job.size}  offers [${offers.join(", ")}]  ->  ${name} at ${price}`;
      report.log.push(line);
      say(line);
    } else {
      report.reopened++;
      const line = `round ${round}  size ${job.size}  offers [${offers.join(", ") || "none"}]  ->  nobody bid, reopened`;
      report.log.push(line);
      say(line);
    }
  }
  return report;
}

if (import.meta.main) {
  const arg = (n: string) => {
    const i = Deno.args.indexOf(n);
    return i >= 0 ? Deno.args[i + 1] : undefined;
  };
  const url = arg("--url") ?? "http://127.0.0.1:7788";
  const { operatorToken } = await import("../operator.ts");
  const operator = new RadiaClient(url, { token: operatorToken(url) });
  const report = await runMarket(operator, {
    rounds: Number(arg("--rounds") ?? 8),
    ...(arg("--seed") ? { seed: Number(arg("--seed")) } : {}),
    log: (l) => console.log(l),
  });
  console.log(`\n${report.awarded} awarded, ${report.reopened} reopened, spend ${report.spend}`);
  console.log(`won by: ${Object.entries(report.wonBy).map(([k, v]) => `${k} ${v}`).join(", ") || "nobody"}`);
  console.log(`\nread it back:  radia query ${TASK} --url ${url}   |   radia query ${REQUEST} --url ${url}`);
}
