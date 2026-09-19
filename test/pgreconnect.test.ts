// A lost connection must cost at most the request in flight, never the pool slot.
//
// deno-postgres 0.19 kept a connection that died WITHOUT the server's goodbye marked `connected`, so
// the pool handed the dead socket out again forever: after a failover every instance failed until
// restarted, and one abrupt disconnect through a proxy failed 120 of the next 120 requests
// (plan-cluster-bench.md, phase 3). `hardenSocket` in src/storage/postgres.ts turns the broken pipe
// into end-of-stream so the driver's own reset runs, and `ClientPool` replaces the driver's pool,
// which dropped a client whose reconnect failed.
//
// ABRUPTLY is the point. `pg_terminate_backend` sends a FATAL message before closing, and the old
// driver handled that correctly: a test built on it passed against the broken code. So these cases
// sever the connection in a proxy, as a killed or failed-over server, a dropped path or a pooler
// does, and one terminated-backend case stays to show the goodbye path still works.
//
// Skipped unless RADIA_PG_URL points at a real server: the embedded adapters have no socket.

import { assert, assertEquals } from "@std/assert";
import { PostgresAdapter } from "../src/storage/postgres.ts";
import { newUlid } from "../src/core/ids.ts";

const PG_URL = Deno.env.get("RADIA_PG_URL");
const needsPg = { ignore: !PG_URL };

type Raw = { sql: { query<T>(q: string, p?: unknown[]): Promise<{ rows: T[] }> } };
const raw = (a: PostgresAdapter) => (a as unknown as Raw).sql;

/** An adapter with ONE pooled connection, so the broken connection is the only slot there is. */
async function single(url = PG_URL!): Promise<PostgresAdapter> {
  const a = new PostgresAdapter(url, { schema: `radia_reconnect_${newUlid()}`, ephemeral: true, poolSize: 1 });
  await a.init();
  return a;
}

async function terminate(pid: number): Promise<void> {
  const killer = new PostgresAdapter(PG_URL!, { poolSize: 1 });
  await killer.init();
  try {
    await raw(killer).query("select pg_terminate_backend($1)", [pid]);
  } finally {
    await killer.close();
  }
}

/** Run `n` queries, counting the failures, and say whether the LAST one succeeded. */
async function afterwards(a: PostgresAdapter, n: number): Promise<{ failed: number; lastOk: boolean }> {
  let failed = 0, lastOk = false;
  for (let i = 0; i < n; i++) {
    try {
      await raw(a).query("select 1");
      lastOk = true;
    } catch {
      failed++;
      lastOk = false;
    }
  }
  return { failed, lastOk };
}

Deno.test({
  name: "postgres: a terminated backend (the server's goodbye) costs at most one query",
  ...needsPg,
  fn: async () => {
    const a = await single();
    try {
      const [{ pid }] = (await raw(a).query<{ pid: number }>("select pg_backend_pid() as pid")).rows;
      await terminate(pid);
      const r = await afterwards(a, 5);
      assert(r.lastOk, "the slot never recovered: the pool is handing out the dead connection");
      assert(r.failed <= 1, `${r.failed} of 5 queries failed; only the one that found the socket dead may`);
      const [{ pid: again }] = (await raw(a).query<{ pid: number }>("select pg_backend_pid() as pid")).rows;
      assert(again !== pid, "a query succeeded on the terminated backend's pid, so nothing was terminated");
    } finally {
      await a.close();
    }
  },
});

/**
 * A TCP forwarder to the test server with three faults. `down`: accept and close at once, what a
 * client meets between a primary's death and its replacement. `sever()`: drop every open connection.
 * `blackhole`: a host that vanished without a word; every connection open when it starts is LOST
 * (its bytes dropped, forever), and a connection made while it holds is accepted and never
 * forwarded. Clearing it lets NEW connections through, as a database back at its address would.
 */
function flakyProxy(): { url: string; down: boolean; blackhole: boolean; sever(): void; close(): void } {
  const target = new URL(PG_URL!);
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const open = new Set<Deno.Conn>();
  const lost = new Set<Deno.Conn>();
  let blackhole = false;
  const state = {
    url: "",
    down: false,
    get blackhole() {
      return blackhole;
    },
    set blackhole(on: boolean) {
      if (on) for (const c of open) lost.add(c);
      blackhole = on;
    },
    /** Drop every open connection, as the death of the server at the other end would. */
    sever() {
      for (const c of open) {
        try {
          c.close();
        } catch { /* already */ }
      }
      open.clear();
    },
    close() {
      listener.close();
      state.sever();
      for (const c of lost) {
        try {
          c.close();
        } catch { /* already */ }
      }
    },
  };
  /** Copy one way; a connection marked lost swallows what it reads. */
  const pump = async (from: Deno.Conn, to: Deno.Conn) => {
    const buf = new Uint8Array(64 * 1024);
    try {
      for (;;) {
        const n = await from.read(buf);
        if (n === null) return;
        if (lost.has(from) || lost.has(to)) continue;
        for (let off = 0; off < n;) off += await to.write(buf.subarray(off, n));
      }
    } catch { /* closed */ }
  };
  (async () => {
    for await (const client of listener) {
      if (state.down) {
        client.close();
        continue;
      }
      if (blackhole) {
        // Accepted and never answered: a connect to a host that is not there.
        lost.add(client);
        open.add(client);
        pump(client, client);
        continue;
      }
      const upstream = await Deno.connect({ hostname: target.hostname, port: Number(target.port || 5432) });
      open.add(client).add(upstream);
      Promise.race([pump(client, upstream), pump(upstream, client)]).finally(() => {
        for (const c of [client, upstream]) {
          open.delete(c);
          try {
            c.close();
          } catch { /* already */ }
        }
      });
    }
  })().catch(() => {});
  const via = new URL(PG_URL!);
  via.hostname = "127.0.0.1";
  via.port = String((listener.addr as Deno.NetAddr).port);
  state.url = via.toString();
  return state;
}

/** How a query ended, within `ms`: "ok", its error code, or "hung". */
async function within(ms: number, p: Promise<unknown>): Promise<string> {
  return await Promise.race([
    p.then(() => "ok", (e) => (e as { code?: string }).code ?? String(e)),
    new Promise<string>((r) => setTimeout(() => r("hung"), ms)),
  ]);
}

Deno.test({
  name: "postgres: a black-holed connection fails its operation within the deadline, and the pool recovers",
  ...needsPg,
  fn: async () => {
    // Nothing in the driver times out, so before the deadline a vanished host held every query, and
    // every request queued behind the pool, until the kernel gave up (plan-audit-remediation.md AC1).
    const proxy = flakyProxy();
    const a = new PostgresAdapter(proxy.url, { schema: `radia_reconnect_${newUlid()}`, ephemeral: true, poolSize: 2, operationTimeoutMs: 800 });
    await a.init();
    try {
      await raw(a).query("select 1");
      proxy.blackhole = true;
      const t0 = performance.now();
      assertEquals(await within(5_000, raw(a).query("select 1")), "database_unavailable", "a black-holed query must fail, not hang");
      assert(performance.now() - t0 < 3_000, `it took ${(performance.now() - t0).toFixed(0)}ms against a deadline of 800ms`);
      proxy.blackhole = false;
      // Every slot that still holds a lost connection costs one more deadline, then is replaced.
      const r = await afterwards(a, 5);
      assert(r.lastOk, "the pool never recovered from the black hole");
      assert(r.failed <= 2, `${r.failed} of 5 failed after the black hole cleared; at most one per slot may`);
    } finally {
      proxy.blackhole = false;
      await a.close().catch(() => {});
      proxy.close();
    }
  },
});

Deno.test({
  name: "postgres: a connect into a black hole fails within the deadline, and the next one works",
  ...needsPg,
  fn: async () => {
    const proxy = flakyProxy();
    const a = new PostgresAdapter(proxy.url, { poolSize: 1, operationTimeoutMs: 800 });
    try {
      await a.init();
      proxy.blackhole = true;
      assertEquals(await within(5_000, raw(a).query("select 1")), "database_unavailable", "a connect that is never answered must fail, not hang");
      proxy.blackhole = false;
      assertEquals(await within(5_000, raw(a).query("select 1")), "ok");
    } finally {
      proxy.blackhole = false;
      await a.close().catch(() => {});
      proxy.close();
    }
  },
});

Deno.test({
  name: "postgres: connections idle past the timeout are closed, down to one",
  ...needsPg,
  fn: async () => {
    // A connection opened for a burst stayed open for the life of the process, so every instance of
    // a busy cluster held its whole pool (plan-cluster-bench.md phase 1). Four concurrent sleeps open
    // four; once idle past the timeout, one stays.
    // Counted by application_name, so connections other cases are still closing do not count.
    const name = `radia_reap_${newUlid().toLowerCase()}`;
    const url = new URL(PG_URL!);
    url.searchParams.set("application_name", name);
    const probe = new PostgresAdapter(PG_URL!, { poolSize: 1, idleTimeoutMs: 0 });
    await probe.init();
    const backends = async () =>
      (await raw(probe).query<{ n: number }>("select count(*)::int as n from pg_stat_activity where application_name = $1", [name])).rows[0].n;
    const a = new PostgresAdapter(url.toString(), { poolSize: 4, idleTimeoutMs: 300 });
    await a.init();
    try {
      await Promise.all([0, 1, 2, 3].map(() => raw(a).query("select pg_sleep(0.2)")));
      assertEquals(await backends(), 4, "the burst should have opened every slot");
      let open = 4;
      for (let i = 0; i < 40 && open > 1; i++) {
        await new Promise((r) => setTimeout(r, 100));
        open = await backends();
      }
      assertEquals(open, 1, "idle connections past the timeout should close, down to one");
      assertEquals((await raw(a).query<{ ok: number }>("select 1 as ok")).rows[0].ok, 1, "and the pool still answers");
    } finally {
      await a.close();
      await probe.close();
    }
  },
});

Deno.test({
  name: "postgres: more failed reconnects than the pool has slots still leave a working pool",
  ...needsPg,
  fn: async () => {
    // The driver's own pool dropped a client whose reconnect threw, so an outage longer than the
    // pool was wide left it EMPTY and every later query waited forever. Two slots, then more failed
    // connects than that, then the database comes back.
    const proxy = flakyProxy();
    const a = new PostgresAdapter(proxy.url, { schema: `radia_reconnect_${newUlid()}`, ephemeral: true, poolSize: 2 });
    await a.init();
    try {
      await raw(a).query("select 1");
      // The outage: every open connection dies and every reconnect is refused, for more attempts
      // than there are slots.
      proxy.down = true;
      proxy.sever();
      for (let i = 0; i < 6; i++) await raw(a).query("select 1").catch(() => {});
      proxy.down = false;
      const answered = await Promise.race([
        raw(a).query<{ ok: number }>("select 1 as ok").then((r) => r.rows[0].ok === 1),
        new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
      ]);
      assert(answered, "no answer within 5s after the database came back: the pool lost its slots");
    } finally {
      proxy.down = false;
      await a.close().catch(() => {});
      proxy.close();
    }
  },
});

Deno.test({
  name: "postgres: a connection severed without the server's goodbye costs at most one query",
  ...needsPg,
  fn: async () => {
    // The failover case: the socket just dies. Before the fix, every later query on the slot failed.
    const proxy = flakyProxy();
    const a = await single(proxy.url);
    try {
      await raw(a).query("select 1");
      proxy.sever();
      const r = await afterwards(a, 5);
      assert(r.lastOk, "the slot never recovered: the pool is handing out the dead connection");
      assert(r.failed <= 1, `${r.failed} of 5 queries failed; only the one that found the socket dead may`);
    } finally {
      await a.close().catch(() => {});
      proxy.close();
    }
  },
});

Deno.test({
  name: "postgres: a connection severed mid-transaction fails that transaction, not the next one",
  ...needsPg,
  fn: async () => {
    const proxy = flakyProxy();
    const a = await single(proxy.url);
    try {
      // The transaction path acquires, begins and settles on one connection: sever between the
      // first statement and the second.
      const backend = (a as unknown as { sql: { transaction<T>(fn: (tx: Raw["sql"]) => Promise<T>): Promise<T> } }).sql;
      const inTx = await backend.transaction(async (tx) => {
        await tx.query("select 1");
        proxy.sever();
        await tx.query("select 2");
      }).then(() => "committed", () => "failed");
      assertEquals(inTx, "failed", "a transaction whose connection died cannot have committed");
      const r = await afterwards(a, 5);
      assert(r.lastOk && r.failed <= 1, `after a mid-transaction sever: ${r.failed} of 5 failed, last ok ${r.lastOk}`);
    } finally {
      await a.close().catch(() => {});
      proxy.close();
    }
  },
});
