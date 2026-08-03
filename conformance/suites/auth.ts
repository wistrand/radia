// Authorization (M1 slice): kind-scoped grants as records, enforced by Space.authorize.
// A privileged principal (human:* or the supervisor) has operator access; any other principal
// needs a matching grant record (kind + op); reserved control kinds (grant/signal) are
// write-protected. Grants are records, so this runs on every adapter: authorize reads them
// through the normal query path. Enforcement WIRING lives at the HTTP boundary; this exercises
// the policy directly.

import { assert, assertEquals, assertRejects } from "@std/assert";
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
      // leaving the token working. The operator was told the stop did nothing, and it did nothing.
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
    name: "a definition token can be revoked, and stops minting everywhere",
    run: async (adapter) => {
      const minter = newSpace(adapter);
      const { definitionToken } = await minter.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "task", operations: ["query"] },
      ]);
      assert((await minter.mintRun(definitionToken)).runToken, "the definition mints before revocation");

      // Revoked from a DIFFERENT Space over the same adapter, like the run-stop case above: an
      // operator responding to a leak is rarely on the process that minted the credential.
      const other = newSpace(adapter);
      const first = await other.revokeDefinition("agent:w", { reason: "leaked" });
      assert(first.applied && !first.alreadyRevoked, "the revocation applies");

      // The symmetry that was missing. `agent_run` has carried a `stopped` status since the chain
      // shipped and `resolveCredential` checked it; the definition branch two lines away returned
      // ok on the mere EXISTENCE of a record, so this token minted fresh runs forever.
      for (const sp of [minter, other, newSpace(adapter)]) {
        const r = await sp.resolveToken(definitionToken);
        assert(!r.ok, "a revoked definition resolves nowhere");
        assertEquals((r as { reason: string }).reason, "definition_revoked");
      }
      await assertRejects(() => minter.mintRun(definitionToken), Error);

      // Idempotent, and it says which it was: re-running a revocation during an incident must
      // neither fail nor read as a second leak.
      const again = await other.revokeDefinition("agent:w");
      assert(again.applied && again.alreadyRevoked, "a second revocation is a no-op that says so");

      // Revoking a definition that never existed is a miss, not a silent success.
      assertEquals((await other.revokeDefinition("agent:nobody")).applied, false);
    },
  },
  {
    name: "revoking a definition leaves running work alone, because those are different decisions",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { definitionToken } = await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "task", operations: ["query"] },
      ]);
      const { run, runToken } = await space.mintRun(definitionToken);
      await space.revokeDefinition("agent:w");

      // Conflating the two would make "stop handing out new authority" mean "kill the work in
      // flight", which are different blast radii and belong to different moments. The run keeps its
      // own token until it expires or is stopped; `stopRun` is still the way to end it.
      assert((await space.resolveToken(runToken)).ok, "an already-minted run keeps working");
      await space.stopRun(run);
      assert(!(await space.resolveToken(runToken)).ok, "…and is still separately stoppable");
    },
  },
  {
    name: "a definition cannot name a privileged principal",
    run: async (adapter) => {
      // A definition mints runs for its subject, so one naming an operator is a permanent way to
      // mint privileged runs — and until it could be revoked at all, a permanent one.
      const space = new Space(adapter, { operators: ["human:root"] });
      await assertRejects(() => space.createAgentDefinition("human:root"), Error, "privileged");
      // An ordinary principal in the same namespace is unaffected: `human:` is a namespace, not a
      // privilege, and a person holding scoped grants must still be able to log in.
      assert((await space.createAgentDefinition("human:alice")).definitionToken);
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
      // restart, which is fail-open on revocation. Resolution now reads the records per request,
      // and this pins that the answer does not depend on how much history sits in front of it.
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
    name: "operator access is a NAMED SET, so a person can be an ordinary principal",
    run: async (adapter) => {
      const space = newSpace(adapter);
      assert(space.isPrivileged("human:local"), "the no-header dev identity is an operator");
      assert(space.isPrivileged("agent:supervisor"));
      assert(!space.isPrivileged("agent:worker"));
      assert(!space.isPrivileged("run:123"));
      // No grants exist, yet operators pass every op.
      await space.authorize("human:local", "put", "task");
      await space.authorize("agent:supervisor", "take", "task");

      // The point of the set: `human:*` used to confer operator authority by NAME SHAPE, so there
      // was no way to have a person who was merely a user, and logging someone in handed them
      // everything. An unlisted person is now ordinary however they are named.
      assert(!space.isPrivileged("human:ceo"), "being called human: is not authority");
      assertEquals(await denied(() => space.authorize("human:ceo", "query", "task")), "forbidden");

      // …and they can hold ordinary scoped grants, like any other principal.
      await space.createAgentDefinition("human:ceo", [
        { principal: "human:ceo", kind: "task", operations: ["query"] },
      ]);
      assertEquals(await space.authorize("human:ceo", "query", "task"), null, "granted, still not an operator");
      assertEquals(await denied(() => space.authorize("human:ceo", "take", "task")), "forbidden");
    },
  },
  {
    name: "a named operator keeps operator access",
    run: async (adapter) => {
      // The set is configuration: a space can name whoever it trusts.
      const space = new Space(adapter, { operators: ["human:local", "human:ada"] });
      space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
      assert(space.isPrivileged("human:ada"));
      await space.authorize("human:ada", "put", "task");
      assert(!space.isPrivileged("human:grace"), "…and only whoever it names");
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

      // the run authorizes as its agent: grants flow down the chain
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
      const claimed = await space.take({ pattern: { kind: "task" } }, {}, "run:a"); // owned by run:a
      assert(claimed);
      // a DIFFERENT run presenting the same VALID lease is fenced out on EVERY settle verb: ack
      // (impersonation) and also nack/release/renew (DoS on someone else's task).
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
    name: "renewal extends a live run, and the SAME token keeps working",
    run: async (adapter) => {
      // Short tokens are right for a leaked credential and wrong for a session someone is sitting
      // in front of: the chat died mid-conversation and took the fleet with it. Renewal writes a
      // successor `agent_run` with the SAME tokenHash, so the token already in a process's hand
      // keeps resolving through the one indexed lookup resolution already does.
      const space = new Space(adapter, { runTokenSeconds: 1 });
      const { definitionToken } = await space.createAgentDefinition("agent:w");
      const { run, runToken, expiresAt } = await space.mintRun(definitionToken);

      const renewed = await space.renewRun(run);
      assertEquals(renewed.run, run);
      assert(renewed.expiresAt >= expiresAt, `renewal must not move expiry backwards: ${renewed.expiresAt} < ${expiresAt}`);
      const r = await space.resolveToken(runToken);
      assert(r.ok && r.kind === "run" && r.principal === run, "the original token still resolves");
    },
  },
  {
    name: "renewal cannot revive a stopped run, and cannot outlive the ceiling",
    run: async (adapter) => {
      // The two bounds that keep renewal from being a long-lived token with extra steps.
      const space = newSpace(adapter);
      const { definitionToken } = await space.createAgentDefinition("agent:w");
      const { run } = await space.mintRun(definitionToken);
      assert((await space.stopRun(run)).applied);
      assertEquals(await denied(() => space.renewRun(run)), "run_stopped", "a revocation must win over renewal");

      // Past the absolute lifetime, renewal is refused however live the run is, so a LEAKED token
      // still dies on a fixed schedule: getting past it needs authentication, which a leak cannot do.
      const capped = new Space(adapter, { runMaxLifetimeSeconds: -1 });
      const d2 = await capped.createAgentDefinition("agent:w2");
      const { run: run2 } = await capped.mintRun(d2.definitionToken);
      assertEquals(await denied(() => capped.renewRun(run2)), "run_lifetime_exceeded");
    },
  },
  {
    name: "renewal never pushes expiry past the run's ceiling",
    run: async (adapter) => {
      // The last renewal before the ceiling lands exactly on it rather than stepping over.
      const space = new Space(adapter, { runTokenSeconds: 3600, runMaxLifetimeSeconds: 60 });
      const { definitionToken } = await space.createAgentDefinition("agent:w");
      const { run } = await space.mintRun(definitionToken);
      const { expiresAt, maxLifetimeAt } = await space.renewRun(run);
      assertEquals(expiresAt, maxLifetimeAt, "a window longer than what remains is clamped to the ceiling");
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
      const claimed = await space.take({ pattern: { kind: "task", match: { tag: "q" } } }, {}, run);
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
    name: "pattern-scoped grant: authorize returns the constraint; unrestricted returns null",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "op", type: "keyword" }] });
      // a pattern-scoped grant → authorize hands back the pattern to AND into the request
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "task", operations: ["query"], pattern: { op: "upper" } } });
      assertEquals(await space.authorize("agent:w", "query", "task"), [{ op: "upper" }]);
      // a privileged principal is unrestricted (null)
      assertEquals(await space.authorize("human:local", "query", "task"), null);
      // a second, UNRESTRICTED grant widens back to the whole kind (null wins)
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "task", operations: ["query"] } });
      assertEquals(await space.authorize("agent:w", "query", "task"), null);
    },
  },
  {
    name: "pattern-scoped PUT grant: a principal may only write records inside its pattern",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "note", indexedPaths: [{ path: "team", type: "keyword" }] });
      // agent:w may put notes only for team=blue
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "note", operations: ["put"], pattern: { team: "blue" } } });
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
    name: "pattern-scoped grant enforced end-to-end: query returns only grant ∧ request",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "op", type: "keyword" }] });
      await space.put({ kind: "task", body: { op: "upper", n: 1 } });
      await space.put({ kind: "task", body: { op: "lower", n: 2 } });
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "task", operations: ["query"], pattern: { op: "upper" } } });

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
      const claimed = await space.take({ pattern: { kind: "task" } }, {}, run);
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
      const t = await space.take({ pattern: { kind: "task" } }, {}, runA);
      const subAck = await space.ack(t!.lease, { kind: "subtask", body: { n: 1 } });
      assert(subAck.status === "ok" && subAck.resultId);
      assertEquals((await space.getRecord(subAck.resultId!))!.runtimeMeta.delegationContext!.chain, ["agent:a"]);

      const s = await space.take({ pattern: { kind: "subtask" } }, {}, runB);
      const resAck = await space.ack(s!.lease, { kind: "result", body: { n: 1 } });
      assert(resAck.status === "ok" && resAck.resultId);
      // the chain accumulates the whole delegation path; b's grant alone suffices for b's own put
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
      const claimed = await space.take({ pattern: { kind: "task" } }, {}, run);

      // emitting the result is blocked: agent:a lacks a put grant for `result`
      assertEquals(await denied(() => space.ack(claimed!.lease, { kind: "result", body: {} })), "forbidden");
      // and nothing was consumed: the record is still leased
      assertEquals((await space.getEnvelope(claimed!.record.id))!.state, "leased");
    },
  },
  {
    name: "watch authorization: any grant on the kind allows a watch; none is forbidden; pattern scopes it",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "op", type: "keyword" }] });
      // no grant → forbidden (the last unguarded coordination verb is now guarded)
      assertEquals(await denied(() => space.authorizeWatch("agent:w", "task")), "forbidden");
      // a take-only grant (like the agentLoop) is enough: watch is participation, not tied to query
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "task", operations: ["take"], pattern: { op: "up" } } });
      assertEquals((await space.authorizeWatch("agent:w", "task")).constraint, [{ op: "up" }]); // scopes the watch
      // privileged → unrestricted
      assertEquals((await space.authorizeWatch("human:local", "task")).constraint, null);
      // a second, unrestricted grant widens back to the whole kind (null wins)
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "task", operations: ["read_one"] } });
      assertEquals((await space.authorizeWatch("agent:w", "task")).constraint, null);
    },
  },
  {
    name: "credentials resolve from the records themselves; stopped/bad/expired tokens rejected",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { definitionToken } = await space.createAgentDefinition("agent:w");
      const { runToken } = await space.mintRun(definitionToken);

      // A fresh Space has an empty in-memory index, but the durable records are the authority:
      // Resolution reads the records directly. There is no index to prime and none to go stale.
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
    name: "a grant pattern that could never compile is rejected when the grant is written",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });

      // A pattern is otherwise checked only when it COMPILES AT USE, so a path the kind does not
      // declare produced a grant that looked assigned in every listing and then denied at the first
      // read. Authorization that appears granted and does nothing is the failure to avoid.
      assertEquals(
        await denied(() =>
          space.put({
            kind: "grant",
            body: { principal: "agent:w", kind: "task", operations: ["query"], pattern: { nope: "x" } },
          })
        ),
        "invalid_grant",
        "an undeclared path in a grant pattern is caught at write time",
      );

      // The declared path is fine, and still scopes reads.
      await space.put({
        kind: "grant",
        body: { principal: "agent:w", kind: "task", operations: ["query"], pattern: { tag: "a" } },
      });
      assertEquals(await space.authorize("agent:w", "query", "task"), [{ tag: "a" }]);
    },
  },
  {
    name: "a grant may still be assigned before the kind it scopes exists",
    run: async (adapter) => {
      const space = new Space(adapter);
      // Bootstrapping an agent before its fleet has declared its kinds is normal, so an UNKNOWN
      // kind must not be an error. The check catches what it can and leaves the rest to use.
      await space.put({
        kind: "grant",
        body: { principal: "agent:w", kind: "later", operations: ["query"], pattern: { whatever: 1 } },
      });
      assertEquals((await space.authorize("agent:w", "query", "later"))?.length, 1);
    },
  },
  {
    name: "a self scope covers EVERY run of the agent, past the first page of them",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "task", operations: ["query"], scope: { createdBy: "self" } },
      ]);

      // `agent_run` grows by one record per mint plus one per stop, and a live run re-mints before
      // expiry, so a long-lived agent passes any fixed limit. The read that builds a self scope
      // used to take ONE bounded page, and a newest-first page drops the agent's OLDEST runs.
      // That is not merely lost history: this list is what `take`, lineage, graph, artifact bytes
      // and watch wakeups narrow to, so the agent's own older records become unreachable, and a
      // claim just skips them, which is indistinguishable from an empty queue.
      const OLDEST = "run:00000000000000000000000001";
      await space.put({
        kind: "agent_run",
        body: { run: OLDEST, agent: "agent:w", tokenHash: "x".repeat(64), status: "active", expiresAt: "2099-01-01T00:00:00.000Z" },
      });
      for (let i = 0; i < 1200; i++) {
        await space.put({
          kind: "agent_run",
          body: { run: `run:filler-${i}`, agent: "agent:w", tokenHash: "y".repeat(64), status: "active", expiresAt: "2099-01-01T00:00:00.000Z" },
        });
      }

      const scope = await space.authorScope("agent:w", "query", "task");
      assert(scope !== undefined, "a self-scoped grant must produce an author scope");
      assert(
        scope!.includes(OLDEST),
        `the agent's OLDEST run fell off the scope (${scope!.length} principals); the read is not paging to exhaustion`,
      );
      assertEquals(scope!.includes("agent:w"), true, "the agent itself is always in its own scope");
    },
  },
];
