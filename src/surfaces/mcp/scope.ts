// Filling in the body fields a caller's own grants require, so a model does not have to know them.
//
// A pattern-scoped grant (`{kind: "task", pattern: {team: "alpha"}}`) bounds reads AND writes: the
// runtime refuses a put whose body is outside the pattern. Reads need nothing from the caller,
// because a read is `grant ∧ request`. Writes do, and the runtime will not supply it: a body is the
// client's claim and the server-assigned fields are a closed set, so nothing stamps an app's own
// field into it. That leaves the caller, and for the MCP surface the caller is a model that would
// have to remember `team: "alpha"` on every single write.
//
// LEARN ON REFUSAL, THEN CACHE. The obvious design is to read your own grants up front and stamp
// every write, and it is wrong: `EffectivePermissions.kinds[].patterns` unions the patterns of ALL
// grants on a kind whatever operation they permit, so a scoped READ grant beside an unscoped write
// grant would make this add a label the record need not carry, narrowing who can see it afterwards.
// Refusal is the only signal that says the label is REQUIRED. So a write goes out as written; only
// one the runtime rejects for scope is retried with the fields filled in, and the scope it learned
// is remembered for the rest of the process.
//
// AMBIGUITY IS AN ERROR, never a guess. A member of two teams has two patterns and nothing here
// knows which one this write belongs in, so it says both names and asks.

import type { RadiaClient } from "../../../sdk/ts/client.ts";

/** The refusal this module exists to answer. Matched on the runtime's own wording; a rename there
 *  turns the fill off rather than misfiring, and `test/team.test.ts` holds the string. */
const SCOPE_REFUSAL = /outside the pattern scope/i;

export function isScopeRefusal(e: unknown): boolean {
  return SCOPE_REFUSAL.test((e as Error)?.message ?? "");
}

/** Flat field -> scalar only. A pattern carrying an operator (`{team: {$in: […]}}`) states a set,
 *  not a value to write, so there is nothing to fill in from it. */
function flat(pattern: Record<string, unknown>): Record<string, string | number | boolean> | undefined {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(pattern)) {
    if (k.startsWith("$")) return undefined;
    if (v === null || typeof v === "object") return undefined;
    out[k] = v as string | number | boolean;
  }
  return Object.keys(out).length ? out : undefined;
}

export class ScopeFiller {
  /** kind -> the fields its grants require, learned from a refusal. */
  private learned = new Map<string, Record<string, string | number | boolean>>();
  /** kind -> the distinct scopes its grants state. Memoized for the process, like `learned`: a
   *  grant added mid-session is not seen until the next one. */
  private scopes = new Map<string, Promise<Record<string, string | number | boolean>[]>>();

  constructor(private client: RadiaClient) {}

  /**
   * The distinct scopes this caller's grants on `kind` state, in the order they were found.
   *
   * More than one means nothing can choose for the caller, which is a REFUSAL on a write (see
   * `discover`) and a question on a read: a lookup by name spans every compartment the caller can
   * reach, so the record it lands on may belong to the wrong one. Empty means the grants scope this
   * kind no way, and nothing should be narrowed.
   */
  candidates(kind: string): Promise<Record<string, string | number | boolean>[]> {
    const memo = this.scopes.get(kind);
    if (memo) return memo;
    const p = (async () => {
      // RESOLVE THE CREDENTIAL FIRST, or `health` answers `anonymous` while the request still
      // arrives as the run behind the token: the self carve-out in `http.ts` (`asksAboutSelf`)
      // then misses and `permissions` refuses with a message about the ops plane. Reachable only
      // before the first authenticated call, which is exactly when a lookup by name asks.
      //
      // The RUN is the principal to ask about, not the agent behind it: a delegated run carries
      // its own materialized authority, which is what its writes are checked against. Any
      // principal may read its OWN permissions, so this needs no ops power.
      await this.client.ensureCredential();
      const me = (await this.client.health()).principal;
      const perms = await this.client.permissions(me);
      const row = perms.kinds.find((k) => k.kind === kind);
      const found = (row?.patterns ?? []).map(flat).filter((p): p is Record<string, string | number | boolean> => !!p);
      return [...new Map(found.map((c) => [JSON.stringify(c), c])).values()];
    })();
    // A failed lookup is not an answer: drop it so the next call asks again rather than replaying
    // one unreachable moment for the rest of the process.
    p.catch(() => this.scopes.delete(kind));
    this.scopes.set(kind, p);
    return p;
  }

  /**
   * WHICH of this caller's scopes a call means, for an operation that must decide BEFORE it can be
   * refused: a lookup by name, where the grant says what is reachable and not which one was meant.
   *
   * ONE SCOPE OR NONE NARROWS NOTHING, and applying the single candidate anyway is wrong: an
   * unscoped grant contributes no entry to `patterns`, so one beside a scoped grant is invisible
   * here and narrowing would hide records this caller may read. SEVERAL is a refusal naming them,
   * for the reason `discover` gives. A named scope is checked against what the caller holds, so a
   * wrong name is refused rather than answered with a confident empty.
   */
  async choose(
    kind: string,
    named: Record<string, string | number | boolean> | undefined,
  ): Promise<Record<string, string | number | boolean> | undefined> {
    const candidates = await this.candidates(kind);
    if (candidates.length < 2) return named;
    const choices = candidates.map((c) => JSON.stringify(c)).join(" or ");
    if (!named) {
      throw new Error(
        `your grants scope '${kind}' several ways and this call names none of them: ${choices}. ` +
          `A ${kind} is found by NAME, so one name in two of them is two different records: pass ` +
          `'scope' to say which, once per scope if you want them all.`,
      );
    }
    const hit = candidates.filter((c) => Object.entries(named).every(([k, v]) => c[k] === v));
    if (hit.length !== 1) {
      throw new Error(`'scope' matches ${hit.length} of your '${kind}' scopes; it must name one of: ${choices}`);
    }
    return named;
  }

  /** What this kind is known to require, for a body about to be written. Empty until a refusal
   *  taught it, which is the point: nothing is added to a write that would have succeeded. */
  known(kind: string): Record<string, string | number | boolean> {
    return this.learned.get(kind) ?? {};
  }

  /**
   * Run a write, and if the runtime refuses it for scope, fill in the caller's own scope and retry
   * ONCE.
   *
   * `write` takes the fields to merge so the caller decides WHERE they go: a record body, an ack's
   * result body, an artifact's meta. Merged under the body, never over it, so a value the model
   * stated explicitly is left to be refused on its own terms rather than silently corrected.
   */
  async fill<T>(kind: string, write: (extra: Record<string, string | number | boolean>) => Promise<T>): Promise<T> {
    try {
      return await write(this.known(kind));
    } catch (e) {
      if (!isScopeRefusal(e) ) throw e;
      const scope = await this.discover(kind);
      const merged = { ...this.known(kind), ...scope };
      if (Object.keys(merged).length === 0) throw e;
      const r = await write(merged);
      this.learned.set(kind, merged);
      return r;
    }
  }

  /**
   * The one scope this caller's grants on `kind` agree on.
   *
   * Throws with both names when there is more than one candidate: a guess would put the work in
   * the wrong team, which is exactly the thing the scoping exists to prevent.
   */
  private async discover(kind: string): Promise<Record<string, string | number | boolean>> {
    const distinct = await this.candidates(kind);
    if (distinct.length === 0) return {};
    if (distinct.length > 1) {
      throw new Error(
        `your grants scope '${kind}' several ways and this write names none of them: ${
          distinct.map((d) => JSON.stringify(d)).join(" or ")
        }. Put one of those fields in the body to say which this belongs to.`,
      );
    }
    return distinct[0];
  }
}
