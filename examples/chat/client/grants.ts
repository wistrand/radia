// The human's half of the escalation loop.
//
// A scoped session that hits `forbidden` cannot fix it — grants are "assigned, never
// self-declared" — so the assistant writes a `grant_request` record and stops. This is what reads
// those requests, shows them to the person in the conversation, and, if they agree, assigns the
// grant using the OPERATOR credential the REPL already holds for bootstrap.
//
// Two properties worth stating, because they are what make this safe rather than theatre:
//
//   The SUBJECT never comes from the request. The grant is assigned to the agent this process
//   minted for the session, a constant it controls — so nothing the model writes can redirect an
//   approval at another principal.
//
//   The default is the NARROWER grant. Approving gives a self-scoped grant
//   (`scope: {createdBy: "self"}`), which narrows BOTH planes: the ops aggregates and the ordinary
//   `query`/`read_one` the agent actually reads records through. Scoping only one of them was a
//   live bug — the prompt promised "its own records" while `query` returned every record of the
//   kind. `take` is deliberately NOT narrowed (claiming a record and then rejecting it is not a
//   filter), so a self-scoped grant should not be handed out with `take` in it.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { activeByKey, activeSet, grantKey, RESERVED_KINDS } from "../../../sdk/ts/client.ts";
import { dim, write } from "./terminal.ts";

interface RequestBody {
  conversationId?: string;
  kind: string;
  operations: string[];
  why?: string;
  retired?: boolean;
}

/** One key per (kind, operations) ask, so a repeat of the same request is one entry, and a handled
 *  one is retired by a successor — the shared registry projection, applied to requests. */
const keyOf = (b: RequestBody) => `${b.kind}:${[...(b.operations ?? [])].sort().join(",")}`;

/**
 * Show any pending requests from this conversation and act on the answer. Called between turns, so
 * it owns the terminal and can read a line without racing the REPL's own prompt.
 */
export async function reviewGrantRequests(
  session: RadiaClient,
  admin: RadiaClient,
  subject: string,
  conversationId: string,
  ask: () => Promise<string | null>,
): Promise<void> {
  let pending;
  try {
    pending = activeByKey<RequestBody>(
      // Newest-first: requests and their retirements accumulate, and an ascending page would
      // eventually show only old, already-handled asks.
      await session.query({ kind: "grant_request", match: { conversationId } }, 50, { dir: "desc" }),
      (b) => keyOf(b),
    );
  } catch {
    return; // no grant to read requests (admin role never writes them): nothing to review
  }
  if (pending.size === 0) return;

  // The kinds that actually exist. The ASKER usually cannot see these — listing kinds is itself a
  // `kind_def: query` grant it lacks — so it guesses, and a plausible guess like `space_event`
  // (a TOOL name, not a record kind) would otherwise be approved into a grant that opens the ops
  // plane onto a kind holding nothing. The approver holds operator access, so check it here.
  let known: string[] = [];
  try {
    // `listKinds` reads `kind_def` RECORDS, so the kinds defined in code — `artifact`, `kind_def`,
    // `grant`, … — are absent from it. Without them the warning fired on real kinds and told the
    // human that `artifact` did not exist while the assistant was successfully counting artifacts.
    known = [...(await admin.listKinds()).map((k) => k.kind), ...RESERVED_KINDS];
  } catch { /* fall through: warn about nothing rather than block the review */ }

  for (const [, rec] of pending) {
    const b = rec.body as RequestBody;
    const unknown = known.length > 0 && !known.includes(b.kind);
    write(`\n${dim("─".repeat(60))}\n`);
    write(`The assistant is asking for permission it does not have:\n`);
    write(`  kind:       ${b.kind}${unknown ? "   ⚠ NOT a record kind on this space" : ""}\n`);
    write(`  operations: ${b.operations.join(", ")}\n`);
    if (b.why) write(`  why:        ${b.why}\n`);
    write(dim(`  grant to:   ${subject}\n`));
    if (unknown) {
      // Name the alternatives rather than just refusing: the assistant asked for something, and
      // the useful answer is usually a real kind with a similar name.
      const near = known.filter((k) => k.includes(b.kind) || b.kind.includes(k)).slice(0, 6);
      write(`\n  ⚠ No kind '${b.kind}' exists here, so this grant would authorize nothing.\n`);
      write(dim(`    kinds on this space: ${known.slice(0, 12).join(", ")}${known.length > 12 ? ", …" : ""}\n`));
      if (near.length > 0) write(dim(`    did it mean: ${near.join(", ")}?\n`));
    }
    write(`\n  [y] yes, but only its OWN records of that kind — reads only (recommended)\n`);
    write(`  [a] yes, ALL records of that kind in this space\n`);
    write(`  [n] no\n`);
    write("approve? ");
    const answer = ((await ask()) ?? "n").trim().toLowerCase();

    if (answer === "y" || answer === "a") {
      const selfScoped = answer === "y";
      if (selfScoped) {
        // Grants UNION, so adding a narrow grant beside a broad one changes nothing — and the
        // session starts with broad read grants on the conversation kinds. Choosing "own records
        // only" therefore has to WITHDRAW the wider grant, or the choice is theatre.
        //
        // But withdraw only the OPERATIONS being narrowed. The bootstrap grant on `message` is
        // {put, query}: retiring it wholesale to narrow `query` also removed `put`, and the session
        // could no longer write its own messages — the chat died on the next turn with
        // "no 'put' grant for kind 'message'". So a grant carrying other operations is replaced by
        // one that keeps them, rather than dropped.
        const live = activeSet(
          await admin.query({ kind: "grant", match: { principal: subject, kind: b.kind } }, 100, { dir: "desc" }),
          grantKey,
        ).map((r) => r.body as { operations?: string[]; scope?: unknown; retired?: boolean })
          .filter((g) => !g.retired && !g.scope && (g.operations ?? []).some((op) => b.operations.includes(op)));

        const kept = new Set<string>();
        for (const g of live) {
          await admin.put({ kind: "grant", body: { ...g, retired: true } });
          const keep = (g.operations ?? []).filter((op) => !b.operations.includes(op));
          if (keep.length > 0) {
            await admin.put({ kind: "grant", body: { ...g, operations: keep } });
            for (const op of keep) kept.add(op);
          }
        }
        // One line, however many duplicate grant records the space has accumulated.
        if (live.length > 0) {
          write(dim(
            `  withdrew wider ${b.operations.join(",")} on ${b.kind} so "own records only" holds` +
              `${kept.size > 0 ? ` (kept ${[...kept].join(",")})` : ""}\n`,
          ));
        }
      }
      // Assigned by the OPERATOR — the session could not write this record itself, which is the
      // whole point of the split.
      await admin.put({
        kind: "grant",
        body: {
          principal: subject,
          kind: b.kind,
          operations: b.operations,
          ...(selfScoped ? { scope: { createdBy: "self" } } : {}),
        },
      });
      write(dim(`granted: ${b.operations.join(",")} on ${b.kind}${selfScoped ? " (its own records only)" : " (all records)"}\n`));
    } else {
      write(dim("refused\n"));
    }
    // Handled either way — a refusal that stayed pending would re-prompt on every turn. The
    // assistant can ask again; that is a new request, and a new decision.
    await admin.put({
      kind: "grant_request",
      body: { ...b, retired: true, decision: answer === "n" ? "refused" : "granted" },
    });
    write(`${dim("─".repeat(60))}\n`);
  }
}
