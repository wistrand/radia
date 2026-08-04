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
  /**
   * Run one claimed record.
   *
   * `signal` aborts when this claim's lease STOPS BEING THIS WORKER'S: the heartbeat saw
   * `lease_lost` (reclaimed, reassigned, force-transitioned) or lost the credential itself. It also
   * aborts when the loop's own `signal` does. A handler with side effects should thread it into
   * whatever it calls — the design contract is that a fenced worker runs until it OBSERVES
   * `lease_lost`, and before this parameter existed the only observation point was the final ack,
   * i.e. after all the work was already done. Ignoring it is safe but keeps the old behaviour:
   * delivery is at-least-once either way, so effects still need idempotency at their boundary.
   */
  handle: (record: RadiaRecord, client: RadiaClient, signal: AbortSignal) => Promise<PutRequest | void>;
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
  // Watchers stop on the CREDENTIAL's signal, not the caller's. It aborts on both: the caller's
  // signal is forwarded to it above, and a credential that ended aborts it directly. Watching
  // `o.signal` alone meant a stopped run's watchers retried a 401 connect every second forever,
  // and since the loop awaits them on the way out, it could never finish.
  const watchers = kinds.map(async (kind) => {
    while (!credential.signal.aborted) {
      try {
        for await (const _ of client.watch({ kind }, credential.signal)) doWake();
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

    // This claim's cancellation channel: the loop's own signal, plus the heartbeat's verdict.
    const claim = new AbortController();
    const cancelClaim = () => claim.abort();
    o.signal?.addEventListener("abort", cancelClaim, { once: true });
    let fenced = false;
    const hb = startHeartbeat(client, claimed, leaseSeconds, (reason) => {
      fenced = true;
      if (reason === "credential") {
        // The run is stopped or aged out: nothing it holds can be settled, so stop claiming too.
        // `keepAlive` would reach the same conclusion at its own cadence, which is half of a
        // 15-minute token: minutes of a handler running against a credential that is already dead.
        credentialLost = true;
        credential.abort();
      }
      log(`[${o.name}] lease lost on ${short(claimed!.record.id)} (${reason}): cancelling the handler`);
      claim.abort(new Error(`lease_lost: ${reason}`));
    });
    try {
      const result = await o.handle(claimed.record, client, claim.signal);
      if (fenced) {
        // Settling is pointless and the log line has to say which of the two happened: the work
        // ran to completion but somebody else owns the record now.
        log(`[${o.name}] ${short(claimed.record.id)} finished after being fenced: not settled, duplicate work possible`);
      } else {
        const key = `ack:${claimed.record.id}:${claimed.lease.epoch}`;
        const res = await client.ack(claimed.lease, result ?? undefined, key);
        if (res.status === "lease_lost") {
          log(`[${o.name}] fenced on ${short(claimed.record.id)}: duplicate work possible (at-least-once)`);
        } else {
          log(`[${o.name}] ${claimed.record.kind} ${short(claimed.record.id)} -> ok`);
        }
      }
    } catch (e) {
      // A handler that threw BECAUSE it was cancelled must not be nacked: the lease is not ours, so
      // the nack fences out anyway, and calling it invites a stray attempt bump on the next owner.
      if (fenced) {
        log(`[${o.name}] ${short(claimed.record.id)} stopped on the fence: ${e}`);
      } else {
        await client.nack(claimed.lease).catch(() => {});
        log(`[${o.name}] ${short(claimed.record.id)} -> nack: ${e}`);
      }
    } finally {
      hb.stop();
      o.signal?.removeEventListener("abort", cancelClaim);
    }
  }

  await retireInterests();
  await Promise.allSettled(watchers);
}

/** Why a heartbeat gave up on a claim. Both mean "you no longer hold this"; they differ in what
 *  the loop should do next, so they are not collapsed into one. */
type LostReason = "lease_lost" | "credential";

/**
 * Renew the lease at lease/3 until stopped, and REPORT the verdict rather than discarding it.
 *
 * The renew result was thrown away here (`.catch(() => {})` over a call whose success value was
 * ignored), so a reclaimed or quarantined worker went on renewing a dead lease for the life of the
 * process while its handler kept producing side effects. Two outcomes are authoritative and stop
 * the heartbeat:
 *
 *   - `{status: "lease_lost"}` — the fence. Somebody else owns the record.
 *   - 401/403 — this credential cannot renew anything, so it cannot settle this work either. A
 *     quarantined run arrives here rather than at `lease_lost`, because stopping the run kills the
 *     token first.
 *
 * Everything else (a network blip, a 5xx, a slow proxy) is transient and ignored: the lease has
 * until its expiry, and guessing "lost" on a hiccup would cancel work that is still legitimately
 * this worker's.
 */
function startHeartbeat(
  client: RadiaClient,
  claimed: { lease: Parameters<RadiaClient["renew"]>[0] },
  leaseSeconds: number,
  onLost: (reason: LostReason) => void,
) {
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(iv);
  };
  const iv = setInterval(async () => {
    try {
      const res = await client.renew(claimed.lease, { leaseSeconds });
      if (stopped) return;
      if (res.status === "lease_lost") {
        stop();
        onLost("lease_lost");
      }
    } catch (e) {
      if (stopped) return;
      if (e instanceof RadiaClientError && (e.status === 401 || e.status === 403)) {
        stop();
        onLost("credential");
      }
    }
  }, Math.max(1000, (leaseSeconds / 3) * 1000));
  return { stop };
}

const short = (id: string) => id.slice(-6);
