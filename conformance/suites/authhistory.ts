// Authorization over a GENERATED HISTORY.
//
// Every authorization bug found so far came from the shape of accumulated state, not from a bad
// call: a revocation that fell off a bounded page, a narrow grant beside a broad one, a grant
// rewritten on every restart until the set outgrew its read. Example-based tests reach those only
// if someone imagines the exact sequence first.
//
// So this generates sequences instead (grant, revoke, re-bootstrap, narrow) and after EVERY step
// checks the runtime against an independent model of what the rules say. The model is written out
// longhand below rather than sharing code with the implementation, because a model that calls the
// thing it is checking proves nothing.
//
// Deterministic by construction: a seeded PRNG, no wall clock, no Math.random. A property test that
// cannot be replayed is a flake generator.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import { Space } from "../../src/core/space.ts";
import type { GrantOp } from "../../src/core/kinds.ts";

/** xorshift32: small, seeded, and identical on every run and every adapter. */
function prng(seed: number) {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
}

const KINDS = ["task", "note"];
const OPS: GrantOp[] = ["put", "query", "take", "read_one"];

interface ModelGrant {
  kind: string;
  operations: GrantOp[];
  scoped: boolean;
  retired: boolean;
}

/** The rules, restated independently of the implementation. */
class Model {
  /** grantKey -> latest state. Latest-wins per key is the projection under test. */
  readonly entries = new Map<string, ModelGrant>();

  /**
   * A grant's identity is what it PERMITS (principal, kind, operations, pattern) and pointedly
   * NOT its scope. So writing a scoped successor with the same operations narrows that grant in
   * place rather than coexisting with the unscoped one, which is the behaviour you want from
   * "restrict this to its own records": the alternative is two grants whose union is the wider of
   * the two, i.e. a narrowing that narrows nothing.
   */
  private key(g: { kind: string; operations: GrantOp[] }): string {
    return `${g.kind}|${[...g.operations].sort().join(",")}`;
  }
  write(g: ModelGrant) {
    this.entries.set(this.key(g), { ...g });
  }
  active(): ModelGrant[] {
    return [...this.entries.values()].filter((g) => !g.retired);
  }
  /** A union: permitted if ANY active grant on the kind carries the operation. */
  permits(kind: string, op: GrantOp): boolean {
    return this.active().some((g) => g.kind === kind && g.operations.includes(op));
  }
  /** Reads narrow to the principal's own records only when EVERY grant permitting that read is
   *  scoped. One unscoped grant already permits other authors. */
  readsScoped(kind: string, op: GrantOp): boolean {
    const relevant = this.active().filter((g) => g.kind === kind && g.operations.includes(op));
    return relevant.length > 0 && relevant.every((g) => g.scoped);
  }
}

async function denied(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

export const authHistorySuites: Suite[] = [
  {
    name: "authorization matches the rules after every step of a generated history",
    run: async (adapter) => {
      const space = new Space(adapter);
      for (const k of KINDS) space.registerKind({ kind: k, indexedPaths: [{ path: "tag", type: "keyword" }] });
      const rand = prng(20260726);
      const model = new Model();
      const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length) % xs.length];

      for (let step = 0; step < 45; step++) {
        const roll = rand();
        if (roll < 0.45 || model.entries.size === 0) {
          // GRANT: a fresh grant, sometimes self-scoped.
          const g: ModelGrant = {
            kind: pick(KINDS),
            operations: [pick(OPS)],
            scoped: rand() < 0.35,
            retired: false,
          };
          await space.put({
            kind: "grant",
            body: {
              principal: "agent:w",
              kind: g.kind,
              operations: g.operations,
              ...(g.scoped ? { scope: { createdBy: "self" } } : {}),
            },
          });
          model.write(g);
        } else if (roll < 0.7) {
          // REVOKE one existing entry: the operation that used to be lost off the end of a page.
          const live = model.active();
          if (live.length === 0) continue;
          const g = pick(live);
          await space.put({
            kind: "grant",
            body: {
              principal: "agent:w",
              kind: g.kind,
              operations: g.operations,
              ...(g.scoped ? { scope: { createdBy: "self" } } : {}),
              retired: true,
            },
          });
          model.write({ ...g, retired: true });
        } else {
          // RE-BOOTSTRAP: rewrite every live grant, exactly as restarting a fleet does. This is the
          // accumulation driver, and the reason a bounded read was the wrong shape.
          for (const g of model.active()) {
            await space.put({
              kind: "grant",
              body: {
                principal: "agent:w",
                kind: g.kind,
                operations: g.operations,
                ...(g.scoped ? { scope: { createdBy: "self" } } : {}),
              },
            });
          }
        }

        // ---- the invariants, checked against the model after EVERY step ----
        for (const kind of KINDS) {
          for (const op of OPS) {
            const allowed = !(await denied(() => space.authorize("agent:w", op, kind)));
            assertEquals(
              allowed,
              model.permits(kind, op),
              `step ${step}: authorize(${op}, ${kind}) disagrees with the rules`,
            );
            if (op === "query" || op === "read_one") {
              const scope = await space.authorScope("agent:w", op, kind);
              assertEquals(
                scope !== undefined,
                model.readsScoped(kind, op),
                `step ${step}: read scoping on ${kind}/${op} disagrees with the rules`,
              );
            }
          }
        }

        // The published view must agree with the decisions. The two drifted before, and the
        // divergence is exactly what made a human approve something that did not hold.
        const view = await space.effectivePermissions("agent:w");
        assert(view.complete, `step ${step}: the grant scan could not be exhausted`);
        for (const kind of KINDS) {
          const row = view.kinds.find((k) => k.kind === kind);
          for (const op of OPS) {
            assertEquals(
              row?.operations.includes(op) ?? false,
              model.permits(kind, op),
              `step ${step}: effectivePermissions disagrees with authorize on ${kind}/${op}`,
            );
          }
          if (row) {
            assertEquals(
              row.readsScopedToSelf,
              model.readsScoped(kind, "query"),
              `step ${step}: reported read scoping on ${kind} is wrong`,
            );
          }
        }
      }
    },
  },
  {
    name: "a registry view reports itself incomplete rather than returning a plausible prefix",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [] });
      // Well past any single page: the point is that the read pages to exhaustion rather than
      // stopping at a limit someone guessed, and says so if it cannot.
      for (let i = 0; i < 1200; i++) {
        await space.put({ kind: "grant", body: { principal: "agent:w", kind: "task", operations: ["put"] } });
      }
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "task", operations: ["query"] } });

      const view = await space.effectivePermissions("agent:w");
      assert(view.complete, "the scan exhausted the kind");
      assertEquals(view.kinds[0].operations.sort(), ["put", "query"], "both grants are visible past the page size");
      assertEquals(await space.authorize("agent:w", "query", "task"), null);
    },
  },
];
