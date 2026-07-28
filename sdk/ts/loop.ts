// agentLoop: the take-based worker harness (design §5), event-driven via watches (M1).
// Background watchers turn matching-kind wakeups into a signal; the claim loop drains all
// its patterns on each wakeup, then waits for the next one (with a poll fallback so a
// missed wakeup or a dropped watch can't stall it). Each claim runs the handler under a
// fenced lease with a renewal heartbeat, acks with a per-attempt idempotency key, nacks on
// error, and logs when fenced (at-least-once: duplicate work is possible).

import { RadiaClientError } from "./client.ts";
import type { PutRequest, RadiaClient, RadiaRecord, Pattern } from "./client.ts";

export interface LoopOptions {
  name: string;
  patterns: Pattern[];
  leaseSeconds?: number;
  pollMs?: number; // fallback tick when no wakeup arrives
  signal?: AbortSignal;
  handle: (record: RadiaRecord, client: RadiaClient) => Promise<PutRequest | void>;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function agentLoop(client: RadiaClient, o: LoopOptions): Promise<void> {
  const leaseSeconds = o.leaseSeconds ?? 30;
  const fallbackMs = Math.max(o.pollMs ?? 250, 1000);
  const log = o.log ?? (() => {});
  const kinds = [...new Set(o.patterns.map((t) => t.kind))];

  // Keep this run's credential alive for as long as the loop runs. Run tokens are short (15 min) so
  // a leaked one stops working; without renewal every long-running agent simply stopped claiming
  // when its token lapsed, and said nothing, so the failure looked like an idle worker rather than
  // a dead credential. It belongs here rather than in each agent: any process running this loop is
  // by definition long-lived.
  let credentialLost = false;
  const credential = new AbortController();
  if (o.signal) o.signal.addEventListener("abort", () => credential.abort(), { once: true });
  client.keepAlive(credential.signal, (reason) => {
    // Past its maximum lifetime, or stopped. Neither is retryable, so stop claiming rather than
    // spin against a door that will not open.
    log(`[${o.name}] credential ended: ${reason}`);
    credentialLost = true;
    credential.abort();
  });

  // Declare what this run listens for, so the prospective topology is queryable. Best effort: a
  // worker with no grant to write `interest` records still works, it is just invisible to the
  // routing view. Never fail the loop over it.
  for (const pattern of o.patterns) {
    try {
      await client.publishInterest(pattern);
    } catch (e) {
      log(`[${o.name}] could not publish interest in '${pattern.kind}': ${e}`);
      break; // one failure means no grant; stop trying for the rest
    }
  }
  // Retire on a clean stop. A crash cannot run this, which is why a reader treats an interest as
  // live only while its RUN is: the record is a hint, the run is the fact.
  const retireInterests = async () => {
    for (const pattern of o.patterns) {
      try {
        await client.publishInterest(pattern, { retired: true });
      } catch { /* shutting down: nothing useful to do */ }
    }
  };

  // Background watchers: each matching-kind wakeup resolves a pending idle wait.
  let wake: (() => void) | null = null;
  const doWake = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const watchers = kinds.map(async (kind) => {
    while (!o.signal?.aborted) {
      try {
        for await (const _ of client.watch({ kind }, o.signal)) doWake();
        return; // generator ended (signal aborted): clean stop
      } catch (e) {
        // A 403 on watch is PERMANENT: this run has no grant to watch this kind, and retrying
        // can't change that. Log it loudly ONCE and stop watching; the poll fallback keeps the loop
        // correct, just without wakeups. "Silently slow" becomes "loudly wrong", so fix the grant.
        if (e instanceof RadiaClientError && e.status === 403) {
          log(`[${o.name}] watch on '${kind}' FORBIDDEN (${e.code}): no grant to watch it; using the poll fallback. Grant this run a '${kind}' grant to get wakeups.`);
          return;
        }
        // Transient (network / server hiccup at watch creation): retry after a short backoff rather
        // than killing the watcher for the loop's lifetime.
        log(`[${o.name}] watch on '${kind}' dropped: ${e}. Retrying`);
        await sleep(1000);
      }
    }
  });

  // The loop ends on the caller's signal OR on a credential that cannot be renewed. The second is
  // not an error to retry: a stopped or aged-out run will never resolve again, so continuing would
  // be an infinite series of 401s that looks, from outside, exactly like a busy worker.
  while (!o.signal?.aborted && !credentialLost) {
    let claimed = null;
    try {
      for (const pattern of o.patterns) {
        claimed = await client.take({ pattern }, { leaseSeconds });
        if (claimed) break;
      }
    } catch (e) {
      log(`[${o.name}] take error: ${e}`);
    }

    if (!claimed) {
      // Idle: wait for a wakeup or the fallback tick, whichever comes first.
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(() => {
          if (wake === resolve) {
            wake = null;
            resolve();
          }
        }, fallbackMs);
      });
      continue;
    }

    const hb = startHeartbeat(client, claimed, leaseSeconds);
    try {
      const result = await o.handle(claimed.record, client);
      const key = `ack:${claimed.record.id}:${claimed.lease.epoch}`;
      const res = await client.ack(claimed.lease, result ?? undefined, key);
      if (res.status === "lease_lost") {
        log(`[${o.name}] fenced on ${short(claimed.record.id)}: duplicate work possible (at-least-once)`);
      } else {
        log(`[${o.name}] ${claimed.record.kind} ${short(claimed.record.id)} -> ok`);
      }
    } catch (e) {
      await client.nack(claimed.lease).catch(() => {});
      log(`[${o.name}] ${short(claimed.record.id)} -> nack: ${e}`);
    } finally {
      hb.stop();
    }
  }

  await retireInterests();
  await Promise.allSettled(watchers);
}

function startHeartbeat(client: RadiaClient, claimed: { lease: Parameters<RadiaClient["renew"]>[0] }, leaseSeconds: number) {
  const iv = setInterval(() => {
    client.renew(claimed.lease, { leaseSeconds }).catch(() => {});
  }, Math.max(1000, (leaseSeconds / 3) * 1000));
  return { stop: () => clearInterval(iv) };
}

const short = (id: string) => id.slice(-6);
