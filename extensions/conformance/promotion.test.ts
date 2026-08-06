// The promotion contract (agent_docs/architecture-workspace-agents.md phase 2).
//
//   deno task extensions
//
// Against a REAL space, because the property under test is enforcement: a pin holds only if the
// runtime refuses an unpromoted digest on both the write and the claim, and only a running space
// can be asked. The rotation's two footguns are what the interesting cases are about, since both
// fail by REPORTING SUCCESS and granting nothing:
//
//   - retire-first leaves a window where the tier can claim nothing;
//   - rolling back to a digest that was retired replays the retirement unless the write anchors
//     on it, so `radia permissions` would show the rollback as done while prod ran nothing.
//
// A pin cannot be tested by reading grant records back. It is tested by trying to submit and
// claim work at a digest that was not promoted, which is what these do.

import { assert, assertEquals } from "@std/assert";
import { RadiaClient, RadiaClientError } from "../../sdk/ts/client.ts";
import { operatorToken } from "../../examples/operator.ts";
import { declareExecRequest, EXEC_REQUEST, pinnedDigests, promote, rollback } from "../ts/promotion.ts";

const PORT = 7817;
const url = `http://127.0.0.1:${PORT}`;
const RUNNER = "agent:prod-runner";
const SUBMITTER = "agent:submitter";
const D1 = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const D2 = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

/** One space for the file: these are contract checks, and a space per test would spend more time
 *  booting than asserting (the shape `workspace.test.ts` uses). */
async function withSpace<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const space = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  const probe = new RadiaClient(url);
  for (let i = 0; i < 100; i++) {
    try {
      await probe.health();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const operator = new RadiaClient(url, { token: operatorToken(url) });
  await declareExecRequest(operator);
  try {
    return await fn({ operator, as: (agent: string) => asAgent(operator, agent) });
  } finally {
    space.kill("SIGTERM");
    await space.status;
  }
}

interface Ctx {
  operator: RadiaClient;
  as: (agent: string) => Promise<RadiaClient>;
}

/** A client acting as `agent`, through the ordinary bootstrap chain. Grants come from promotion,
 *  never from the definition, so a run minted here holds exactly what the pins say. */
async function asAgent(operator: RadiaClient, agent: string): Promise<RadiaClient> {
  const { definitionToken } = await operator.createAgentDefinition(agent, []);
  return new RadiaClient(url, { definitionToken });
}

/** The status a refused call answered with; `undefined` when it succeeded. */
async function refused(fn: () => Promise<unknown>): Promise<number | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e instanceof RadiaClientError ? e.status : -1;
  }
}

const pins = [{ principal: RUNNER, operations: ["take"] }, { principal: SUBMITTER, operations: ["put"] }];
const request = (workspace: string, tier = "prod") => ({ kind: EXEC_REQUEST, body: { workspace, tier, job: "x" } });

Deno.test("[promotion] a pin refuses an unpromoted digest on BOTH the write and the claim", async () => {
  await withSpace(async ({ operator, as }) => {
    const submitter = await as(SUBMITTER);
    const runner = await as(RUNNER);
    await promote(operator, { digest: D1, tier: "prod", pins });

    // The promoted digest works end to end.
    await submitter.put(request(D1));
    const claimed = await runner.take({ pattern: { kind: EXEC_REQUEST } });
    assert(claimed, "the runner must claim work at the promoted digest");
    assertEquals((claimed.record.body as { workspace: string }).workspace, D1);

    // An unpromoted digest is refused at the WRITE: the submitter's grant is pattern-scoped, so
    // `bodyMatchesGrant` rejects the body before anything is stored.
    assertEquals(await refused(() => submitter.put(request(D2))), 403);

    // …and would be refused at the CLAIM too. Written by the operator (who bypasses grants), so
    // the record exists and the only thing that can hide it is the runner's own pin.
    await operator.put(request(D2));
    const second = await runner.take({ pattern: { kind: EXEC_REQUEST } });
    assertEquals(second, null, "a runner pinned to D1 must not claim a D2 request that exists");
    // The operator sees it, so the test cannot pass because the record was never written.
    const all = await operator.query({ kind: EXEC_REQUEST, match: { workspace: D2 } }, 10);
    assertEquals(all.length, 1);
  });
});

Deno.test("[promotion] rotation leaves no gap, and the old digest stops working", async () => {
  await withSpace(async ({ operator, as }) => {
    const submitter = await as(SUBMITTER);
    const runner = await as(RUNNER);
    await promote(operator, { digest: D1, tier: "prod", pins });

    const rotation = await promote(operator, { digest: D2, tier: "prod", pins });
    assertEquals(rotation.granted.length, 2);
    assertEquals(rotation.retired.map((r) => r.digest), [D1, D1], "both pins retire the digest they replaced");
    assertEquals(await pinnedDigests(operator, { principal: RUNNER, tier: "prod" }), [D2]);

    // NO GAP: the new digest is claimable immediately after the call returns.
    await submitter.put(request(D2));
    const claimed = await runner.take({ pattern: { kind: EXEC_REQUEST } });
    assert(claimed, "the new digest must be claimable the moment promotion returns");
    assertEquals((claimed.record.body as { workspace: string }).workspace, D2);

    // …and the replaced digest is closed, on both sides.
    assertEquals(await refused(() => submitter.put(request(D1))), 403);
    await operator.put(request(D1));
    assertEquals(await runner.take({ pattern: { kind: EXEC_REQUEST, match: { workspace: D1 } } }), null);
  });
});

Deno.test("[promotion] rollback to a RETIRED digest actually grants, and repeating it is a no-op", async () => {
  await withSpace(async ({ operator, as }) => {
    const submitter = await as(SUBMITTER);
    const runner = await as(RUNNER);
    await promote(operator, { digest: D1, tier: "prod", pins });
    await promote(operator, { digest: D2, tier: "prod", pins });

    // The revive case. Without the `:after:` anchor this write replays the retirement of D1:
    // reports success, grants nothing, and prod runs nothing while the registry says otherwise.
    await rollback(operator, { digest: D1, tier: "prod", pins });
    assertEquals(await pinnedDigests(operator, { principal: RUNNER, tier: "prod" }), [D1]);

    await submitter.put(request(D1));
    const claimed = await runner.take({ pattern: { kind: EXEC_REQUEST } });
    assert(claimed, "a rolled-back digest must be claimable, which is the whole point of the revive key");
    assertEquals((claimed.record.body as { workspace: string }).workspace, D1);
    assertEquals(await refused(() => submitter.put(request(D2))), 403, "the digest rolled back FROM is closed");

    // Promotion is idempotent: calling again writes no new grant and retires nothing.
    const again = await promote(operator, { digest: D1, tier: "prod", pins });
    assertEquals(again.retired, []);
    assertEquals(await pinnedDigests(operator, { principal: RUNNER, tier: "prod" }), [D1]);
  });
});

Deno.test("[promotion] the rotation GRANTS before it retires", async () => {
  // Ordering is a property of the window INSIDE the call, so no amount of asserting on the state
  // afterwards can see it: retire-first ends up in the same place, having been briefly unable to
  // claim anything. (Written the obvious way first, this suite passed with the order reversed.)
  // So the order of writes is what gets asserted, through a client that records them.
  await withSpace(async ({ operator }) => {
    await promote(operator, { digest: D1, tier: "prod", pins });

    const calls: string[] = [];
    const recorder = new Proxy(operator, {
      get(target, prop, receiver) {
        if (prop === "grant") {
          return (...args: Parameters<RadiaClient["grant"]>) => {
            calls.push("grant");
            return target.grant(...args);
          };
        }
        if (prop === "put") {
          return (...args: Parameters<RadiaClient["put"]>) => {
            if ((args[0] as { body?: { retired?: unknown } }).body?.retired === true) calls.push("retire");
            return target.put(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await promote(recorder, { digest: D2, tier: "prod", pins });
    assertEquals(calls, ["grant", "retire", "grant", "retire"], "each pin must grant the new digest before retiring the old");
  });
});

Deno.test("[promotion] a tier is rotated alone, and other work the principal holds is untouched", async () => {
  await withSpace(async ({ operator, as }) => {
    const runner = await as(RUNNER);
    // The same principal serves two tiers and also holds an unrelated grant. A rotation that
    // retired by (principal, kind) rather than by (principal, kind, operations, tier) would take
    // all of it with it, which is a silent outage rather than a promotion.
    await promote(operator, { digest: D1, tier: "prod", pins: [{ principal: RUNNER, operations: ["take"] }] });
    await promote(operator, { digest: D2, tier: "experiment", pins: [{ principal: RUNNER, operations: ["take"] }] });
    await operator.grant(RUNNER, "note", ["query"]);

    const D3 = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
    await promote(operator, { digest: D3, tier: "prod", pins: [{ principal: RUNNER, operations: ["take"] }] });

    assertEquals(await pinnedDigests(operator, { principal: RUNNER, tier: "prod" }), [D3]);
    assertEquals(
      await pinnedDigests(operator, { principal: RUNNER, tier: "experiment" }),
      [D2],
      "the experiment tier must survive a prod promotion",
    );
    const perms = await operator.permissions(RUNNER) as { kinds: { kind: string }[] };
    assert(perms.kinds.some((k) => k.kind === "note"), "unrelated grants must survive a rotation");
    // What prod is running, answered from the enforcement path: the audit an operator runs.
    assertEquals(await runner.health().then(() => pinnedDigests(operator, { principal: RUNNER, tier: "prod" })), [D3]);
  });
});
