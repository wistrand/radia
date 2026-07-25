// agentLoop — the take-based worker harness (design §5), event-driven via watches (M1).
// Background watchers turn matching-kind wakeups into a signal; the claim loop drains all
// its templates on each wakeup, then waits for the next one (with a poll fallback so a
// missed wakeup or a dropped watch can't stall it). Each claim runs the handler under a
// fenced lease with a renewal heartbeat, acks with a per-attempt idempotency key, nacks on
// error, and logs when fenced (at-least-once: duplicate work is possible).

import { RadiaClientError } from "./client.ts";
import type { PutRequest, RadiaClient, RadiaRecord, Template } from "./client.ts";

export interface LoopOptions {
  name: string;
  templates: Template[];
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
  const kinds = [...new Set(o.templates.map((t) => t.kind))];

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
        return; // generator ended (signal aborted) — clean stop
      } catch (e) {
        // A 403 on watch is PERMANENT — this run has no grant to watch this kind, and retrying
        // can't change that. Log it loudly ONCE and stop watching; the poll fallback keeps the loop
        // correct, just without wakeups. "Silently slow" becomes "loudly wrong" — fix the grant.
        if (e instanceof RadiaClientError && e.status === 403) {
          log(`[${o.name}] watch on '${kind}' FORBIDDEN (${e.code}) — no grant to watch it; using the poll fallback. Grant this run a '${kind}' grant to get wakeups.`);
          return;
        }
        // Transient (network / server hiccup at watch creation): retry after a short backoff rather
        // than killing the watcher for the loop's lifetime.
        log(`[${o.name}] watch on '${kind}' dropped: ${e} — retrying`);
        await sleep(1000);
      }
    }
  });

  while (!o.signal?.aborted) {
    let claimed = null;
    try {
      for (const template of o.templates) {
        claimed = await client.take({ template }, { leaseSeconds });
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
        log(`[${o.name}] fenced on ${short(claimed.record.id)} — duplicate work possible (at-least-once)`);
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

  await Promise.allSettled(watchers);
}

function startHeartbeat(client: RadiaClient, claimed: { lease: Parameters<RadiaClient["renew"]>[0] }, leaseSeconds: number) {
  const iv = setInterval(() => {
    client.renew(claimed.lease, { leaseSeconds }).catch(() => {});
  }, Math.max(1000, (leaseSeconds / 3) * 1000));
  return { stop: () => clearInterval(iv) };
}

const short = (id: string) => id.slice(-6);
