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
   * How many claims this worker may hold AT ONCE. Default 1: strictly sequential, the behaviour
   * every existing caller has.
   *
   * Raise it for a worker whose handler is I/O WAIT rather than work. An inference worker holds
   * one `llm_call` for the whole model response (5-60s) and does nothing but await a socket, so
   * one process serialized the fleet's entire throughput at one answer per tier
   * (agent_docs/plan-scaling.md: this, not the substrate, is the first ceiling the chat hits).
   * Leave it at 1 for a handler that is CPU- or process-heavy (the exec worker spawns a jail per
   * call), where overlapping only trades latency for contention.
   *
   * The substrate needs nothing for this: leases are independently fenced, there is no
   * max-leases-per-principal, and every claim already carries its own lease, heartbeat and
   * cancellation. What changes is only how many the harness holds. Records complete OUT OF ORDER
   * above 1, which is already the contract (at-least-once, no ordering guarantee), but a handler
   * that assumed "one at a time" because that is what it always saw must be checked before opting
   * in.
   */
  concurrency?: number;
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
  /**
   * Where the loop narrates itself. Absent means SILENT for routine trace (took, acked, fenced),
   * which is the right default for a library.
   *
   * It is never silent for a FAILURE. A handler that throws, a take that errors, a watch refused
   * and an interest that could not be published all reach `console.error` when no `log` is given,
   * because a swallowed exception is indistinguishable from a hang: the caller sees a record that
   * was claimed, nacked, reclaimed and nacked again, with nothing anywhere saying why. Pass a `log`
   * to route those somewhere else; there is no way to turn them off, deliberately.
   */
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A network-level failure as something a person can act on.
 *
 * Deno's whole story for ANY transport failure is `TypeError: fetch failed` — the same five words
 * for a space that is down, a DNS typo and a TLS mismatch. The part that says WHICH rides on the
 * error's `cause`, and the address is the thing a reader needs first; eight workers printing
 * "fetch failed" named neither. Anything that is not a transport failure passes through untouched.
 */
function describeFailure(e: unknown, base: string): string {
  if (e instanceof TypeError && e.message.includes("fetch failed")) {
    const cause = (e as { cause?: unknown }).cause;
    const raw = cause instanceof Error ? cause.message : cause ? String(cause) : "";
    // The cause is a request trace ("error sending request for url (...): client error (Connect):
    // tcp connect error: Connection refused (os error 111)"); the tail is the part that says why.
    const why = raw.split(": ").pop() ?? "";
    return `cannot reach the space at ${base}${why ? ` (${why})` : ""}`;
  }
  return String(e);
}

export async function agentLoop(client: RadiaClient, o: LoopOptions): Promise<void> {
  const leaseSeconds = o.leaseSeconds ?? 30;
  // 1 by default: strictly sequential, every existing caller's behaviour. See LoopOptions.
  const concurrency = Math.max(1, Math.floor(o.concurrency ?? 1));
  const fallbackMs = Math.max(o.pollMs ?? 250, 1000);
  const log = o.log ?? (() => {});
  // Failures go to the caller's `log` when it gave one, and to stderr when it did not. Never
  // nowhere: this loop swallowed handler exceptions by default, and three separate defects in one
  // afternoon each presented as "the tool call timed out" with an empty log.
  const report = o.log ?? ((msg: string) => console.error(msg));
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
  // routing view. Never fail the loop over it — and NEVER GATE CLAIMING ON IT: these are
  // decoration, and 31 sequential publishes once held a tool worker deaf for 49 seconds on a
  // lived-in space before its first claim. The loop below starts immediately; the announcement
  // lands when it lands. Batches chain on `announced`, so a re-announcement never interleaves
  // with the one before it.
  let announced: Promise<void> = Promise.resolve();
  let announcedUnder: string | undefined;
  const announce = () => {
    // Claimed SYNCHRONOUSLY at queue time, or every idle tick before the first batch completed
    // would compare against undefined and queue another. Corrected inside the task once the
    // credential is ensured, to the token the publishes actually ran under.
    announcedUnder = client.bearerToken;
    announced = announced.then(async () => {
      await client.ensureCredential().catch(() => {});
      announcedUnder = client.bearerToken;
      for (const pattern of o.patterns) {
        try {
          await client.publishInterest(pattern);
        } catch (e) {
          report(`[${o.name}] could not publish interest in '${pattern.kind}': ${describeFailure(e, client.base)}`);
          break; // one failure means no grant; stop trying for the rest
        }
      }
    });
  };
  announce();
  // Retire on a clean stop. A crash cannot run this, which is why a reader treats an interest as
  // live only while its RUN is: the record is a hint, the run is the fact. Awaits the announcement
  // first, or an instant shutdown retires BEFORE it publishes and the late publish, being newer,
  // would leave a stopped worker looking subscribed.
  const retireInterests = async () => {
    await announced.catch(() => {});
    for (const pattern of o.patterns) {
      try {
        await client.publishInterest(pattern, { retired: true });
      } catch { /* shutting down: nothing useful to do */ }
    }
  };

  /**
   * One claim, start to settle: heartbeat, handler, ack or nack, cleanup.
   *
   * A function rather than the loop body it used to be, so several can be in flight at once. Every
   * piece of per-claim state that used to be a loop variable is a local here, which is exactly why
   * concurrency needs no new machinery: the fenced lease, its heartbeat and its cancellation were
   * always per claim. It never throws — a handler's failure is nacked and reported inside — so a
   * caller can hold it in a set and only await it for its timing.
   */
  const runClaim = async (claimed: NonNullable<Awaited<ReturnType<RadiaClient["take"]>>>): Promise<void> => {
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
      log(`[${o.name}] lease lost on ${short(claimed.record.id)} (${reason}): cancelling the handler`);
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
        report(`[${o.name}] ${short(claimed.record.id)} -> nack: ${e}`);
      }
    } finally {
      hb.stop();
      o.signal?.removeEventListener("abort", cancelClaim);
    }
  };

  /** Claims running right now. Size is the only slot bookkeeping the loop needs. */
  const inFlight = new Set<Promise<void>>();

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
    // The same streak suppression the take loop uses, for the same reason: a dead space drops the
    // watch once per reconnect attempt, and "dropped ... Retrying" once a second is a flood that
    // says nothing the first line did not. Repeats of one error are counted; a change is news.
    let drops: { message: string; count: number } | null = null;
    while (!credential.signal.aborted) {
      try {
        for await (const _ of client.watch({ kind }, credential.signal)) {
          drops = null; // frames are flowing: the next drop is a new streak
          doWake();
        }
        return; // generator ended (signal aborted): clean stop
      } catch (e) {
        // A run that ENDED is not a missing grant. The watch is revoked either way, but a client
        // holding the durable half mints another run and watches again, so this retries rather than
        // degrading. Told apart by the revocation's reason: reported as `forbidden`, a worker whose
        // credential simply turned over was told to fix a grant it already had, and polled from
        // then on.
        if (e instanceof RadiaClientError && e.code === "credential_invalid") {
          log(`[${o.name}] watch on '${kind}' outlived its run; re-watching under a fresh one`);
          continue;
        }
        // Any other 403 IS permanent: this run has no grant to watch this kind, and retrying can't
        // change that. Log it loudly ONCE and stop watching; the poll fallback keeps the loop
        // correct, just without wakeups. "Silently slow" becomes "loudly wrong", so fix the grant.
        if (e instanceof RadiaClientError && e.status === 403) {
          report(`[${o.name}] watch on '${kind}' FORBIDDEN (${e.code}): no grant to watch it; using the poll fallback. Grant this run a '${kind}' grant to get wakeups.`);
          return;
        }
        // Transient (network / server hiccup at watch creation): retry after a backoff rather
        // than killing the watcher for the loop's lifetime. Reported once per streak.
        const message = describeFailure(e, client.base);
        if (drops === null || drops.message !== message) {
          drops = { message, count: 1 };
          log(`[${o.name}] watch on '${kind}' dropped: ${message}. Retrying`);
        } else drops.count++;
        await sleep(Math.min(1000 * 2 ** Math.min(drops.count, 4), 15_000));
      }
    }
  });

  // The loop ends on the caller's signal OR on a credential that cannot be renewed. The second is
  // not an error to retry: a stopped or aged-out run will never resolve again, so continuing would
  // be an infinite series of 401s that looks, from outside, exactly like a busy worker.
  // The current take-failure streak: same error repeating, counted rather than re-reported.
  let failing: { message: string; since: number; count: number; remindedAt: number } | null = null;

  while (!o.signal?.aborted && !credentialLost) {
    // A NEW RUN must re-announce. Interests are live only while their author-run is, and renewal
    // keeps one run alive for its whole lifetime — so the token string changes exactly when the
    // run does (a lapse, a stop, the lifetime ceiling), and a worker that kept its old interests
    // would be listening invisibly from then on. The dead run's records need no retirement here:
    // liveness already drops them.
    if (client.bearerToken !== announcedUnder) announce();
    let claimed = null;
    let takeFailed = false;
    try {
      for (const pattern of o.patterns) {
        claimed = await client.take({ pattern }, { leaseSeconds });
        if (claimed) break;
      }
    } catch (e) {
      // ONE line per failure, not one per tick. A space being down errors every take, and eight
      // workers at the 1s floor printed the same "fetch failed" ~500 times a minute — a flood that
      // says nothing the first line did not, and buries anything else. Repeats of the SAME error
      // are counted silently with a once-a-minute reminder; a DIFFERENT error is news and prints.
      takeFailed = true;
      const message = describeFailure(e, client.base);
      const now = Date.now();
      if (failing === null || failing.message !== message) {
        failing = { message, since: now, count: 1, remindedAt: now };
        report(`[${o.name}] ${message}; claiming paused, retrying with backoff`);
      } else if (now - failing.remindedAt >= 60_000) {
        failing.count++;
        failing.remindedAt = now;
        report(`[${o.name}] still down: ${message} (${failing.count} attempts over ${Math.round((now - failing.since) / 1000)}s)`);
      } else {
        failing.count++;
      }
    }
    if (!takeFailed && failing) {
      // Say so, or the silence between "take error" and normal operation reads as a hang.
      report(`[${o.name}] recovered after ${failing.count} failed attempt${failing.count === 1 ? "" : "s"} over ${Math.round((Date.now() - failing.since) / 1000)}s`);
      failing = null;
      // Re-announce too: a worker that BOOTED during the outage published into the void, and a
      // plain-token client's bearer never changes, so the token-turnover trigger above cannot
      // cover it (an exchange-capable client's first success changes the token and would). For
      // everyone else this is a batch of idempotent replays.
      announce();
    }

    if (!claimed) {
      // Idle: wait for a wakeup or the fallback tick, whichever comes first. While the space is
      // UNREACHABLE, back off instead: a wakeup cannot arrive (the watchers are down too), and the
      // tight tick is what turned an outage into a retry storm. Capped low enough that recovery is
      // never more than 15s late.
      const waitMs = failing ? Math.min(fallbackMs * 2 ** Math.min(failing.count, 4), 15_000) : fallbackMs;
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(() => {
          if (wake === resolve) {
            wake = null;
            resolve();
          }
        }, waitMs);
      });
      continue;
    }

    // Start it, and (at concurrency 1) wait for it right here, which is the behaviour every
    // existing caller has. Above 1 the slot bookkeeping below is what waits.
    const running = runClaim(claimed);
    inFlight.add(running);
    running.finally(() => inFlight.delete(running));
    // Fill the remaining slots from the same wakeup before parking: a burst of claimable records
    // should not need one wakeup each. When every slot is busy, wait for the first to free.
    if (inFlight.size >= concurrency) await Promise.race([...inFlight]);
  }

  // Drain: the handlers were aborted with the loop's signal, but they still own leases until they
  // settle, and `retireInterests` must not race the settles it would otherwise interleave with.
  await Promise.allSettled([...inFlight]);
  await retireInterests();
  await Promise.allSettled(watchers);
}

/** Why a heartbeat gave up on a claim. Both mean "you no longer hold this"; they differ in what
 *  the loop should do next, so they are not collapsed into one. */
type LostReason = "lease_lost" | "credential";

/**
 * Renew the lease at lease/3 until stopped, and REPORT the verdict rather than discarding it.
 *
 * Two outcomes are authoritative and stop the heartbeat: `{status: "lease_lost"}`, the fence; and
 * 401/403, where a stopped or quarantined run lands, since revoking it kills the token before
 * anything answers `lease_lost`. Everything else (a blip, a 5xx) is transient and ignored — the
 * lease has until its expiry, and guessing "lost" would cancel work that is still ours.
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
