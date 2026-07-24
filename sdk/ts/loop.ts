// agentLoop — the take-based worker harness (design §5). Polls `take` across templates,
// runs a handler under a fenced lease with a renewal heartbeat, acks the result (with a
// per-attempt idempotency key so a dropped response is safe), nacks on error, and logs
// when a lease is fenced (at-least-once: duplicate work is possible). M0 polls because
// watches (SSE) and long-poll land in M1.

import type { PutRequest, RadiaClient, RadiaRecord, Template } from "./client.ts";

export interface LoopOptions {
  name: string;
  templates: Template[];
  leaseSeconds?: number;
  pollMs?: number;
  signal?: AbortSignal;
  /** Run the work. Return a result record to emit on ack, or void to ack empty. Throw to nack. */
  handle: (record: RadiaRecord, client: RadiaClient) => Promise<PutRequest | void>;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function agentLoop(client: RadiaClient, o: LoopOptions): Promise<void> {
  const leaseSeconds = o.leaseSeconds ?? 30;
  const pollMs = o.pollMs ?? 250;
  const log = o.log ?? (() => {});

  while (!o.signal?.aborted) {
    let claimed = null;
    try {
      for (const template of o.templates) {
        claimed = await client.take({ template }, { leaseSeconds });
        if (claimed) break;
      }
    } catch (e) {
      log(`[${o.name}] take error: ${e}`); // transient (e.g. space restarting) — back off and retry
    }
    if (!claimed) {
      await sleep(pollMs);
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
}

function startHeartbeat(client: RadiaClient, claimed: { lease: Parameters<RadiaClient["renew"]>[0] }, leaseSeconds: number) {
  const iv = setInterval(() => {
    client.renew(claimed.lease, { leaseSeconds }).catch(() => {});
  }, Math.max(1000, (leaseSeconds / 3) * 1000));
  return { stop: () => clearInterval(iv) };
}

const short = (id: string) => id.slice(-6);
