// Authorization (M1 slice): kind-scoped grants as records, enforced by Space.authorize.
// A privileged principal (human:* or the supervisor) has operator access; any other principal
// needs a matching grant record (kind + op); reserved control kinds (grant/signal) are
// write-protected. Grants are records, so this runs on every adapter — authorize reads them
// through the normal query path. Enforcement WIRING lives at the HTTP boundary; this exercises
// the policy directly.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import { Space } from "../../src/core/space.ts";
import { handleQuery } from "../../src/server/handlers/records.ts";

function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter); // default supervisor = agent:supervisor
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  return space;
}

async function denied(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

export const authSuites: Suite[] = [
  {
    name: "a run stops from a process that never saw it minted",
    run: async (adapter) => {
      const minter = newSpace(adapter);
      const { definitionToken } = await minter.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "task", operations: ["query"] },
      ]);
      const { run, runToken } = await minter.mintRun(definitionToken);

      // A DIFFERENT Space over the same adapter: another instance, or this one after a restart.
      // Stopping used to consult an in-memory index first and silently report `applied: false`,
      // leaving the token working — the operator was told the stop did nothing, and it did nothing.
      const other = newSpace(adapter);
      const stop = await other.stopRun(run);
      assert(stop.applied, "the stop applies without having minted the run");

      // …and it takes effect for everyone, because the successor carries the same token hash.
      for (const s of [minter, other, newSpace(adapter)]) {
        const r = await s.resolveToken(runToken);
        assert(!r.ok, "a stopped run's token resolves nowhere");
      }
    },
  },
  {
    name: "a run minted on one instance authenticates on another immediately",
    run: async (adapter) => {
      const a = newSpace(adapter);
      const { definitionToken } = await a.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "task", operations: ["query"] },
      ]);
      const { runToken } = await a.mintRun(definitionToken);
      // No replay, no hydration step: the record IS the credential.
      const b = newSpace(adapter);
      const r = await b.resolveToken(runToken);
      assert(r.ok && r.kind === "run", "the token resolves on an instance that never minted it");
    },
  },
  {
    name: "a stopped run stays stopped after a restart, however busy the space",
    run: async (adapter) => {
      const space = newSpace(adapter);
      space.registerKind({ kind: "task", indexedPaths: [] });
      const { definitionToken } = await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "task", operations: ["query"] },
      ]);
      const { run, runToken } = await space.mintRun(definitionToken);

      // Runs accumulate: one per mint, and a live run re-mints on a timer. This history used to be
      // replayed into a cache from a BOUNDED page, so a stopped token kept resolving across a
      // restart — fail-open on revocation. Resolution now reads the records per request, and this
      // pins that the answer does not depend on how much history sits in front of it.
      for (let i = 0; i < 600; i++) {
        await space.put({
          kind: "agent_run",
          body: { run: `run:filler${i}`, agent: "agent:other", tokenHash: `h${i}`, expiresAt: "2099-01-01T00:00:00Z" },
        });
      }
      await space.stopRun(run);

      // No credential replay: a restarted process resolves from the records themselves, so there
      // is no rebuilt index to be stale, capped, or missing this run.
      const restarted = newSpace(adapter);
      await restarted.loadKinds();
      const resolved = await restarted.resolveToken(runToken);
      assert(!resolved.ok, "a stopped run's token must not resolve after a restart");
    },
  },

  {
    name: "privileged principals (human:* and the supervisor) have operator access",
    run: async (adapter) => {
      const space = newSpace(adapter);
      assert(space.isPrivileged("human:local"));
      assert(space.isPrivileged("agent:supervisor"));
      assert(!space.isPrivileged("agent:worker"));
      assert(!space.isPrivileged("run:123"));
      // no grants exist, yet privileged principals pass every op
      await space.authorize("human:local", "put", "task");
      await space.authorize("agent:supervisor", "take", "task");
      await space.authorize("human:ceo", "query", "anything");
    },
  },
  {
    name: "a non-privileged principal is denied without a grant, allowed with one (kind + op scoped)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // denied before any grant
      assertEquals(await denied(() => space.authorize("agent:worker", "take", "task")), "forbidden");

      // supervisor assigns a take grant for `task` (grants are records)
      await space.put({ kind: "grant", body: { principal: "agent:worker", kind: "task", operations: ["take"] } });

      // now the granted op on the granted kind passes
      await space.authorize("agent:worker", "take", "task");
      // but a different op is still denied (op-scoped)
      assertEquals(await denied(() => space.authorize("agent:worker", "put", "task")), "forbidden");
      // and a different kind is still denied (kind-scoped)
      assertEquals(await denied(() => space.authorize("agent:worker", "take", "job")), "forbidden");
      // and a different principal is unaffected
      assertEquals(await denied(() => space.authorize("agent:other", "take", "task")), "forbidden");
    },
  },
  {
    name: "grant bodies are validated; wildcard kinds are rejected",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // wildcard kind rejected (grants are kind-scoped, never wildcard)
      assertEquals(
        await denied(() => space.put({ kind: "grant", body: { principal: "agent:w", kind: "*", operations: ["put"] } })),
        "wildcard_grant",
      );
      // unknown operation rejected
      assertEquals(
        await denied(() => space.put({ kind: "grant", body: { principal: "agent:w", kind: "task", operations: ["delete"] } })),
        "invalid_grant",
      );
      // empty operations rejected
      assertEquals(
        await denied(() => space.put({ kind: "grant", body: { principal: "agent:w", kind: "task", operations: [] } })),
        "invalid_grant",
      );
    },
  },
  {
    name: "a grant does not authorize writing reserved control kinds (assigned, never self-declared)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // even with a put grant for `grant`, a non-privileged principal cannot write grants/signal
      await space.put({ kind: "grant", body: { principal: "agent:worker", kind: "grant", operations: ["put"] } });
      assertEquals(await denied(() => space.authorize("agent:worker", "put", "grant")), "forbidden");
      assertEquals(await denied(() => space.authorize("agent:worker", "put", "signal")), "forbidden");
      // a human/supervisor still may
      await space.authorize("human:local", "put", "grant");
      await space.authorize("agent:supervisor", "put", "signal");
    },
  },
  {
    name: "bootstrap chain: definition token mints a run; the run inherits its agent's grants",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // operator defines an agent and assigns it a take grant on `task`
      const { definitionToken } = await space.createAgentDefinition("agent:summarizer", [
        { principal: "agent:summarizer", kind: "task", operations: ["take"] },
      ]);
      // the definition token mints a short-lived run
      const { run, runToken } = await space.mintRun(definitionToken);
      assert(run.startsWith("run:"));
      assert(runToken.length > 0);

      // the run token resolves to the run principal
      const resolved = await space.resolveToken(runToken);
      assert(resolved.ok && resolved.kind === "run" && resolved.principal === run);

      // the run authorizes as its agent — grants flow down the chain
      await space.authorize(run, "take", "task");
      // but only for what the agent was granted
      assertEquals(await denied(() => space.authorize(run, "put", "task")), "forbidden");
    },
  },
  {
    name: "lease settlement is bound to its owner: another principal's ack/nack/release/renew fences out",
    run: async (adapter) => {
      const space = newSpace(adapter); // task
      await space.put({ kind: "task", body: { tag: "t" } });
      const claimed = await space.take({ template: { kind: "task" } }, {}, "run:a"); // owned by run:a
      assert(claimed);
      // a DIFFERENT run presenting the same VALID lease is fenced out on EVERY settle verb — not
      // just ack (impersonation) but nack/release/renew (DoS on someone else's task).
      assertEquals((await space.ack(claimed!.lease, undefined, undefined, "run:b")).status, "lease_lost");
      assertEquals((await space.nack(claimed!.lease, {}, undefined, "run:b")).status, "lease_lost");
      assertEquals((await space.release(claimed!.lease, undefined, "run:b")).status, "lease_lost");
      assertEquals((await space.renew(claimed!.lease, {}, undefined, "run:b")).status, "lease_lost");
      assertEquals((await space.getEnvelope(claimed!.record.id))!.state, "leased"); // still owned by run:a
      // the owner may settle its own lease
      assertEquals((await space.ack(claimed!.lease, undefined, undefined, "run:a")).status, "ok");
    },
  },
  {
    name: "an expired run token stops resolving (short-lived tokens)",
    run: async (adapter) => {
      const space = new Space(adapter, { runTokenSeconds: -1 }); // mint already-expired tokens
      const { definitionToken } = await space.createAgentDefinition("agent:w");
      const { runToken } = await space.mintRun(definitionToken);
      const r = await space.resolveToken(runToken);
      assert(!r.ok && r.reason === "token_expired");
    },
  },
  {
    name: "a stopped run's token stops resolving (no new operations)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { definitionToken } = await space.createAgentDefinition("agent:w");
      const { run, runToken } = await space.mintRun(definitionToken);
      assert((await space.resolveToken(runToken)).ok);

      assert((await space.stopRun(run)).applied);
      const after = await space.resolveToken(runToken);
      assert(!after.ok && after.reason === "run_stopped");
    },
  },
  {
    name: "quarantine invalidates a run's in-flight leases (late ack fences out as lease_lost)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { definitionToken } = await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "task", operations: ["take"] },
      ]);
      const { run } = await space.mintRun(definitionToken);

      // seed a task and have the RUN claim it (lease owned by run:*)
      await space.put({ kind: "task", body: { tag: "q" } });
      const claimed = await space.take({ template: { kind: "task", match: { tag: "q" } } }, {}, run);
      assert(claimed);

      // graceful stop leaves the lease alone; quarantine force-invalidates it
      const { quarantined } = await space.stopRun(run, { quarantine: true });
      assertEquals(quarantined, 1);

      // the record is available again, and the old lease fences out
      const env = await space.getEnvelope(claimed!.record.id);
      assertEquals(env!.state, "available");
      assertEquals(await space.ack(claimed!.lease), { status: "lease_lost" });
    },
  },
  {
    name: "template-scoped grant: authorize returns the constraint; unrestricted returns null",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "op", type: "keyword" }] });
      // a template-scoped grant → authorize hands back the template to AND into the request
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "task", operations: ["query"], template: { op: "upper" } } });
      assertEquals(await space.authorize("agent:w", "query", "task"), [{ op: "upper" }]);
      // a privileged principal is unrestricted (null)
      assertEquals(await space.authorize("human:local", "query", "task"), null);
      // a second, UNRESTRICTED grant widens back to the whole kind (null wins)
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "task", operations: ["query"] } });
      assertEquals(await space.authorize("agent:w", "query", "task"), null);
    },
  },
  {
    name: "template-scoped PUT grant: a principal may only write records inside its template",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "note", indexedPaths: [{ path: "team", type: "keyword" }] });
      // agent:w may put notes only for team=blue
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "note", operations: ["put"], template: { team: "blue" } } });
      const c = await space.authorize("agent:w", "put", "note");
      assert(c); // constrained (not null)
      assertEquals(space.bodyMatchesGrant("note", { team: "blue", text: "x" }, c!), true); // in scope
      assertEquals(space.bodyMatchesGrant("note", { team: "red", text: "x" }, c!), false); // out of scope
      assertEquals(space.bodyMatchesGrant("note", { text: "x" }, c!), false); // missing the scoped field
      // an additional UNRESTRICTED put grant widens back to the whole kind
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "note", operations: ["put"] } });
      assertEquals(await space.authorize("agent:w", "put", "note"), null);
    },
  },
  {
    name: "template-scoped grant enforced end-to-end: query returns only grant ∧ request",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "op", type: "keyword" }] });
      await space.put({ kind: "task", body: { op: "upper", n: 1 } });
      await space.put({ kind: "task", body: { op: "lower", n: 2 } });
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "task", operations: ["query"], template: { op: "upper" } } });

      const query = (principal: string) =>
        handleQuery(space, new Request("http://x/v0/records/query", { method: "POST", body: JSON.stringify({ kind: "task" }) }), principal)
          .then((r) => r.json()).then((j) => j.records as { body: { op: string } }[]);

      // the scoped agent sees ONLY upper tasks (grant ∧ request), even asking for all
      const scoped = await query("agent:w");
      assertEquals(scoped.map((r) => r.body.op), ["upper"]);
      // the operator sees everything
      const all = await query("human:local");
      assertEquals(all.length, 2);
    },
  },
  {
    name: "delegation_context: work acked under a run carries the authority chain (from the lease, not data parents)",
    run: async (adapter) => {
      const space = newSpace(adapter); // task indexed on tag
      space.registerKind({ kind: "result", indexedPaths: [] });
      const { definitionToken } = await space.createAgentDefinition("agent:a", [
        { principal: "agent:a", kind: "task", operations: ["take"] },
        { principal: "agent:a", kind: "result", operations: ["put"] },
      ]);
      const { run } = await space.mintRun(definitionToken);
      await space.put({ kind: "task", body: { tag: "t" } });
      const claimed = await space.take({ template: { kind: "task" } }, {}, run);
      assert(claimed);

      const acked = await space.ack(claimed!.lease, { kind: "result", body: { ok: true } });
      assert(acked.status === "ok" && acked.resultId);
      const result = await space.getRecord(acked.resultId!);
      // authority chain is the agent behind the lease; origin is the leased (authorization) parent
      assertEquals(result!.runtimeMeta.delegationContext, { chain: ["agent:a"], origin: claimed!.record.id });

      // a directly-put (root) record carries NO delegation context
      const rootId = (await space.put({ kind: "task", body: { tag: "root" } })).id;
      assertEquals((await space.getRecord(rootId))!.runtimeMeta.delegationContext, undefined);
    },
  },
  {
    name: "delegation_context: the chain accumulates across hops (a → b), each agent using its own grant",
    run: async (adapter) => {
      const space = newSpace(adapter);
      space.registerKind({ kind: "subtask", indexedPaths: [] });
      space.registerKind({ kind: "result", indexedPaths: [] });
      const { definitionToken: da } = await space.createAgentDefinition("agent:a", [
        { principal: "agent:a", kind: "task", operations: ["take"] },
        { principal: "agent:a", kind: "subtask", operations: ["put"] },
      ]);
      const { definitionToken: db } = await space.createAgentDefinition("agent:b", [
        { principal: "agent:b", kind: "subtask", operations: ["take"] },
        { principal: "agent:b", kind: "result", operations: ["put"] },
      ]);
      const { run: runA } = await space.mintRun(da);
      const { run: runB } = await space.mintRun(db);

      await space.put({ kind: "task", body: { n: 1 } });
      const t = await space.take({ template: { kind: "task" } }, {}, runA);
      const subAck = await space.ack(t!.lease, { kind: "subtask", body: { n: 1 } });
      assert(subAck.status === "ok" && subAck.resultId);
      assertEquals((await space.getRecord(subAck.resultId!))!.runtimeMeta.delegationContext!.chain, ["agent:a"]);

      const s = await space.take({ template: { kind: "subtask" } }, {}, runB);
      const resAck = await space.ack(s!.lease, { kind: "result", body: { n: 1 } });
      assert(resAck.status === "ok" && resAck.resultId);
      // the chain accumulates the whole delegation path — b's grant alone suffices for b's own put
      assertEquals((await space.getRecord(resAck.resultId!))!.runtimeMeta.delegationContext!.chain, ["agent:a", "agent:b"]);
    },
  },
  {
    name: "delegation_context: an agent cannot ack a result kind it has no put grant for (closes the ack-emit gap)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      space.registerKind({ kind: "result", indexedPaths: [] });
      // agent:a may TAKE task but has NO put grant for result
      const { definitionToken } = await space.createAgentDefinition("agent:a", [
        { principal: "agent:a", kind: "task", operations: ["take"] },
      ]);
      const { run } = await space.mintRun(definitionToken);
      await space.put({ kind: "task", body: { tag: "t" } });
      const claimed = await space.take({ template: { kind: "task" } }, {}, run);

      // emitting the result is blocked: agent:a lacks a put grant for `result`
      assertEquals(await denied(() => space.ack(claimed!.lease, { kind: "result", body: {} })), "forbidden");
      // and nothing was consumed — the record is still leased
      assertEquals((await space.getEnvelope(claimed!.record.id))!.state, "leased");
    },
  },
  {
    name: "watch authorization: any grant on the kind allows a watch; none is forbidden; template scopes it",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "op", type: "keyword" }] });
      // no grant → forbidden (the last unguarded coordination verb is now guarded)
      assertEquals(await denied(() => space.authorizeWatch("agent:w", "task")), "forbidden");
      // a take-only grant (like the agentLoop) is enough — watch is participation, not tied to query
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "task", operations: ["take"], template: { op: "up" } } });
      assertEquals(await space.authorizeWatch("agent:w", "task"), [{ op: "up" }]); // scopes the watch
      // privileged → unrestricted
      assertEquals(await space.authorizeWatch("human:local", "task"), null);
      // a second, unrestricted grant widens back to the whole kind (null wins)
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "task", operations: ["read_one"] } });
      assertEquals(await space.authorizeWatch("agent:w", "task"), null);
    },
  },
  {
    name: "credentials resolve from the records themselves; stopped/bad/expired tokens rejected",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { definitionToken } = await space.createAgentDefinition("agent:w");
      const { runToken } = await space.mintRun(definitionToken);

      // A fresh Space has an empty in-memory index, but the durable records are the authority:
      // Resolution reads the records directly — there is no index to prime and none to go stale.
      const viaFallback = await (new Space(adapter)).resolveToken(runToken);
      assert(viaFallback.ok && viaFallback.kind === "run", "fallback should resolve a minted run token");
      const runPrincipal = viaFallback.ok && viaFallback.kind === "run" ? viaFallback.principal : "";

      // Bulk rebuild also resolves it.
      const reloaded = new Space(adapter);

      const after = await reloaded.resolveToken(runToken);
      assert(after.ok && after.kind === "run");

      // A stop on one Space is honored by a fresh Space via the fallback (the stop successor record).
      await space.stopRun(runPrincipal);
      const afterStop = await (new Space(adapter)).resolveToken(runToken);
      assert(!afterStop.ok && afterStop.reason === "run_stopped", "fallback must honor a stop successor");

      // A token that was never minted is invalid.
      const bogus = await space.resolveToken("deadbeef");
      assert(!bogus.ok && bogus.reason === "invalid_token");
    },
  },
  {
    name: "a grant template that could never compile is rejected when the grant is written",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });

      // A template is otherwise checked only when it COMPILES AT USE — so a path the kind does not
      // declare produced a grant that looked assigned in every listing and then denied at the first
      // read. Authorization that appears granted and does nothing is the failure to avoid.
      assertEquals(
        await denied(() =>
          space.put({
            kind: "grant",
            body: { principal: "agent:w", kind: "task", operations: ["query"], template: { nope: "x" } },
          })
        ),
        "invalid_grant",
        "an undeclared path in a grant template is caught at write time",
      );

      // The declared path is fine, and still scopes reads.
      await space.put({
        kind: "grant",
        body: { principal: "agent:w", kind: "task", operations: ["query"], template: { tag: "a" } },
      });
      assertEquals(await space.authorize("agent:w", "query", "task"), [{ tag: "a" }]);
    },
  },
  {
    name: "a grant may still be assigned before the kind it scopes exists",
    run: async (adapter) => {
      const space = new Space(adapter);
      // Bootstrapping an agent before its fleet has declared its kinds is normal, so an UNKNOWN
      // kind must not be an error — the check catches what it can and leaves the rest to use.
      await space.put({
        kind: "grant",
        body: { principal: "agent:w", kind: "later", operations: ["query"], template: { whatever: 1 } },
      });
      assertEquals((await space.authorize("agent:w", "query", "later"))?.length, 1);
    },
  },
];
