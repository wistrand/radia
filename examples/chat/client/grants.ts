// The human's half of the escalation loop.
//
// A scoped session that hits `forbidden` cannot fix it. Grants are "assigned, never
// self-declared", so the assistant writes a `grant_request` record and stops. This is what reads
// those requests, shows them to the person in the conversation, and, if they agree, assigns the
// grant using the OPERATOR credential the REPL already holds for bootstrap.
//
// Two properties worth stating, because they are what make this safe rather than theatre:
//
//   The SUBJECT never comes from the request. The grant is assigned to the agent this process
//   minted for the session, a constant it controls. Nothing the model writes can redirect an
//   approval at another principal.
//
//   The default is the NARROWER grant. Approving gives a self-scoped grant
//   (`scope: {createdBy: "self"}`), which narrows BOTH planes: the ops aggregates and the ordinary
//   `query`/`read_one` the agent actually reads records through. Scoping only one of them was a
//   live bug: the prompt promised "its own records" while `query` returned every record of the
//   kind. `take` is deliberately NOT narrowed (claiming a record and then rejecting it is not a
//   filter), so a self-scoped grant should not be handed out with `take` in it.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { activeByKey, activeSet, grantKey, RESERVED_KINDS } from "../../../sdk/ts/client.ts";
import { columns, dim, write } from "./ui.ts";

interface RequestBody {
  conversationId?: string;
  kind: string;
  operations: string[];
  why?: string;
  /** What the ASKER says it needs: its own records, or all of them. A request, never a decision.
   *  The human still chooses, and the subject still comes from this process. Without it the
   *  protocol could not express the difference, so an agent that needed to read a registry written
   *  by others had no way to say so and was handed a grant over its own (nonexistent) records. */
  scope?: "own" | "all";
  retired?: boolean;
}

/**
 * The wider (non-self-scoped) grants a narrowing approval would retire, as operation names.
 *
 * Exactly the read the narrowing itself performs, run before the prompt so the cost arrives with the
 * choice. Paged to exhaustion, because a grant missed here is a warning not shown.
 */
async function widerGrants(admin: RadiaClient, subject: string, kind: string, ops: string[]): Promise<string[]> {
  const live = [...activeSet(
    await admin.queryAll({ kind: "grant", match: { principal: subject, kind } }),
    grantKey,
  )].map((r) => r.body as { operations?: string[]; scope?: unknown; retired?: boolean })
    .filter((g) => !g.retired && !g.scope);
  return [...new Set(live.flatMap((g) => (g.operations ?? []).filter((op) => ops.includes(op))))].sort();
}

/** One key per (kind, operations, scope) ask, so a repeat of the same request is one entry and a
 *  handled one is retired by a successor (the shared registry projection, applied to requests).
 *  Scope is part of the identity: asking for the same reads UNSCOPED after a scoped grant proved
 *  useless is a different request, and folding the two together would hide the second. */
const keyOf = (b: RequestBody) => `${b.kind}:${[...(b.operations ?? [])].sort().join(",")}:${b.scope ?? "own"}`;

/**
 * How much of a kind a SELF-SCOPED read would actually expose, sampled.
 *
 * `created_by` is runtime metadata, not a body field, so it cannot be matched by a pattern. The
 * count is taken over a bounded page and reported as a sample rather than a total. Authorship is
 * resolved the way the runtime resolves it: an agent's records are written by its RUNS, so the
 * `agent_run` records for this subject give the principals to compare against.
 */
async function selfExposure(
  admin: RadiaClient,
  kind: string,
  subject: string,
): Promise<{ mine: number; total: number } | undefined> {
  try {
    // Paged: this decides which principals count as "mine", so a truncated list undercounts the
    // session's own records and reports the exposure as wider than it is.
    const runs = await admin.queryAll<{ run?: string }>({ kind: "agent_run", match: { agent: subject } });
    const principals = new Set([subject, ...runs.map((r) => r.body.run).filter(Boolean) as string[]]);
    const sample = await admin.queryNewest({ kind }, 100);
    return { mine: sample.filter((r) => principals.has(r.runtimeMeta.createdBy)).length, total: sample.length };
  } catch {
    return undefined; // cannot tell: say nothing rather than guess
  }
}

/**
 * Show any pending requests from this conversation and act on the answer. Called between turns, so
 * it owns the terminal and can read a line without racing the REPL's own prompt.
 */
export async function reviewGrantRequests(
  session: RadiaClient,
  admin: RadiaClient,
  subject: string,
  conversationId: string,
  ask: (prompt?: string) => Promise<string | null>,
): Promise<void> {
  let pending;
  try {
    pending = activeByKey<RequestBody>(
      // EXHAUSTIVE, not a newest-50 page. Requests and their retirements accumulate per
      // conversation and there is no honest number to bound them with: a page drops the OLDEST
      // keys wholesale, so the request left waiting longest is the first to disappear from review.
      await session.queryAll({ kind: "grant_request", match: { conversationId } }),
      (b) => keyOf(b),
    );
  } catch {
    return; // no grant to read requests (admin role never writes them): nothing to review
  }
  if (pending.size === 0) return;

  // The kinds that actually exist. The ASKER usually cannot see these, because listing kinds is
  // itself a `kind_def: query` grant it lacks. So it guesses, and a plausible guess like
  // `space_event` (a TOOL name, not a record kind) would otherwise be approved into a grant that
  // opens the ops plane onto a kind holding nothing. The approver holds operator access, so check
  // it here.
  let known: string[] = [];
  try {
    // `listKinds` reads `kind_def` RECORDS, so the kinds defined in code (`artifact`, `kind_def`,
    // `grant`, …) are absent from it. Without them the warning fired on real kinds and told the
    // human that `artifact` did not exist while the assistant was successfully counting artifacts.
    // Deduped: a kind can be in BOTH lists. The chat redeclares the reserved `artifact` kind to
    // index its own path, so it appears as a kind_def record and as a reserved name, and the
    // assistant dutifully read "artifact" twice back to the user.
    known = [...new Set([...(await admin.listKinds()).map((k) => k.kind), ...RESERVED_KINDS])];
  } catch { /* fall through: warn about nothing rather than block the review */ }

  for (const [, rec] of pending) {
    const b = rec.body;
    const unknown = known.length > 0 && !known.includes(b.kind);
    write(`\n${dim("─".repeat(Math.min(60, columns())))}\n`);
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
    // What "own records only" would actually expose. Self-scope is the right default for a kind
    // the session WRITES (its messages, its llm_calls) and useless for one it only reads: a
    // registry like `kind_def`, `capability` or `model` is written by the fleet, so scoping it to
    // the session's own records grants a view of nothing. That is not a hypothetical: a session
    // was granted self-scoped `kind_def`, `space_kinds` kept returning `[]`, and it concluded the
    // approval had not gone through. Measured on a bounded page rather than guessed from a list of
    // "registry-ish" kind names, which would be wrong the moment an app adds one.
    const exposure = unknown ? undefined : await selfExposure(admin, b.kind, subject);
    const pointless = exposure !== undefined && exposure.mine === 0 && exposure.total > 0;
    if (pointless) {
      write(`\n  ⚠ '${b.kind}' records here were written by others (0 of ${exposure.total} sampled are this session's),\n`);
      write(dim(`    so "own records only" would show it NOTHING. This kind is a registry it reads, not data it writes.\n`));
    }
    // What the asker said it needs. It is shown rather than obeyed. But not showing it meant an
    // assistant could state "this only helps un-scoped" in its reply, have the human answer the
    // narrower prompt, and get a grant that did not do the job. The two halves of the exchange were
    // talking about different things.
    if (b.scope === "all") {
      write(`\n  the assistant asked for ALL records of this kind, not just its own.\n`);
    }
    // Operations that are NOT reads. "Own records only" is a read filter. `take` CLAIMS a record,
    // and claiming one and then rejecting it is not filtering, so a self-scoped grant must never
    // carry it. The prompt used to offer "only its OWN records, reads only" and then grant
    // `query, read_one, take` verbatim: the label was false, and on a work kind like `llm_call` the
    // grant would let a chat session claim calls the inference fleet is waiting for.
    const writes = b.operations.filter((op) => op !== "query" && op !== "read_one");
    const reads = b.operations.filter((op) => op === "query" || op === "read_one");
    if (writes.length > 0) {
      write(`\n  ⚠ this asks for ${writes.join(", ").toUpperCase()}, which ${writes.length > 1 ? "are" : "is"} not a read.\n`);
      if (writes.includes("take")) {
        write(dim(`    'take' CLAIMS records: on a work kind that means taking work other agents are waiting for.\n`));
      }
      write(dim(`    [own] will grant only ${reads.length > 0 ? reads.join(", ") : "nothing"}; [all] grants everything asked for.\n`));
    }

    // WHAT [own] TAKES AWAY, said BEFORE the choice instead of reported after it.
    //
    // Narrowing withdraws any wider grant carrying the same operations, because grants UNION and
    // leaving the wide one standing would make the narrowing theatre. Correct — and it means [own]
    // can leave a session with LESS access than it had before it asked, which is the opposite of
    // what "grant only its own" sounds like.
    //
    // Live session: a scoped user held `artifact: read_one` patterned to its owner and was reading
    // workspace files with it. The assistant misdiagnosed an unrelated failure as a permissions
    // problem and asked for artifact access; the human chose [own] to be careful; the narrowing
    // retired the working grant in favour of a self-scoped one matching nothing, and reading files
    // stopped working at all. The consequence line already existed — it printed AFTER the decision,
    // as a receipt. A cost disclosed after the choice is not a disclosure.
    const wouldWithdraw = reads.length > 0 ? await widerGrants(admin, subject, b.kind, reads) : [];
    if (wouldWithdraw.length > 0) {
      write(`\n  ⚠ [own] REMOVES access this session already has: ${wouldWithdraw.join(", ")} on ${b.kind}\n`);
      write(dim(
        `    Narrowing retires the wider grant, so [own] can leave it worse off than refusing.\n` +
          `    [no] changes nothing; [own] revokes the above and replaces it with a self-scoped one.\n`,
      ));
    }

    // Never recommend an option for a kind that does not exist: neither answer can grant anything,
    // and "(recommended here)" beside a warning that the grant authorizes nothing reads as advice
    // to approve it.
    // …and do not recommend the option that takes access away. Recommending [own] beside a warning
    // that [own] revokes a working grant is advice to break the session.
    const recommend = unknown
      ? "none"
      : (pointless || b.scope === "all" || wouldWithdraw.length > 0)
      ? "all"
      : "own";
    // Named options rather than y/n. `y` read as plain "yes" and meant the NARROW one, so a person
    // answering "yes" to "can I see more of the space?" got the opposite and the assistant spent
    // its next turns discovering the grant did nothing. Nothing here means "yes" any more, and
    // `yes` is not accepted as an answer at all.
    if (reads.length > 0) {
      write(`\n  [own] its OWN records of that kind, reads only${recommend === "own" ? " (recommended)" : ""}\n`);
    }
    write(`${reads.length > 0 ? "" : "\n"}  [all] ALL records of that kind in this space${recommend === "all" ? " (recommended here)" : ""}\n`);
    write(`  [no] refuse\n`);

    let answer = "";
    // The PROMPT goes to the reader rather than being written first. The line editor redraws the
    // whole row on every keystroke, starting with an erase, so anything printed ahead of it is wiped
    // the moment a key is pressed: the question would vanish as soon as you started answering it.
    let question = "approve? ";
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = ((await ask(question)) ?? "no").trim().toLowerCase();
      if (raw === "own" || raw === "o") answer = "own";
      else if (raw === "all" || raw === "a") answer = "all";
      else if (raw === "no" || raw === "n" || raw === "") answer = "no";
      if (answer) break;
      // An ambiguous "yes" is the whole reason these are words: it must not silently become either
      // a refusal (which the old code did) or the narrow grant.
      question = `  '${raw}' is not one of them. Answer own, all or no: `;
    }
    if (!answer) answer = "no";
    if (answer === "own" && reads.length === 0) {
      write(dim(`  nothing to grant: 'own records only' is a read filter and this asks for no reads.\n`));
      answer = "no";
    }
    // Answering the narrow way against a measured-empty exposure is allowed (it is the human's
    // call), but it must not look like it worked. Three turns of "the grant landed and changed
    // nothing" started here.
    if (answer === "own" && pointless) {
      write(dim(`  note: this grant authorizes reads of ${b.kind} records this session created, and there are none.\n`));
    }

    let inheritedPattern: Record<string, unknown> | undefined;
    // Self-scoping is a read filter, so the narrow answer grants the READS only, never the
    // operation the label said it was excluding. Declared out here because the decision record
    // reports it too: "granted" without saying WHAT is how a caller retries an operation it still
    // cannot perform.
    const granting = answer === "own" ? reads : b.operations;
    // A kind that does not exist cannot be granted. The warning above said this grant "would
    // authorize nothing", and the requester is told `no_such_kind`, so writing the record anyway
    // and printing "granted" left three answers disagreeing: the human read success, the assistant
    // read failure, and the space kept a grant naming a kind nobody can hold records of. An
    // approval here is honoured as a REFUSAL with the real kind names attached, which is the answer
    // that closes the loop in the same turn.
    if (unknown && answer !== "no") {
      write(dim(
        `not granted: no kind '${b.kind}' exists here, so the grant would authorize nothing.\n` +
          `  the assistant was given the real kind names and can ask again for one of them.\n`,
      ));
      answer = "no";
    }
    if (answer === "own" || answer === "all") {
      const selfScoped = answer === "own";
      if (selfScoped) {
        // Grants UNION, so adding a narrow grant beside a broad one changes nothing, and the
        // session starts with broad read grants on the conversation kinds. Choosing "own records
        // only" therefore has to WITHDRAW the wider grant, or the choice is theatre.
        //
        // But withdraw only the OPERATIONS being narrowed. The bootstrap grant on `message` is
        // {put, query}: retiring it wholesale to narrow `query` also removed `put`, and the session
        // could no longer write its own messages. The chat died on the next turn with
        // "no 'put' grant for kind 'message'". So a grant carrying other operations is replaced by
        // one that keeps them, rather than dropped.
        const live = [...activeSet(
          // Paged: a grant missed here is a wider grant left standing beside the narrow one,
          // and grants union, so the narrowing would be theatre.
          await admin.queryAll({ kind: "grant", match: { principal: subject, kind: b.kind } }),
          grantKey,
        )].map((r) => r.body as { operations?: string[]; scope?: unknown; pattern?: Record<string, unknown>; retired?: boolean })
          .filter((g) => !g.retired && !g.scope && (g.operations ?? []).some((op) => granting.includes(op)));

        // Carry the PATTERN of what is being narrowed onto the narrowed grant. The session's base
        // grants are pattern-scoped to its conversation, and grant patterns UNION, so writing an
        // unpatterned self-scoped grant beside them would replace "this conversation" with "every
        // conversation this agent ever wrote", which is a widening performed by the act of
        // narrowing. Only adopted when the grants being replaced agree on one pattern; otherwise
        // there is no single right answer and the explicit ask wins.
        const patterns = new Set(live.filter((g) => g.pattern).map((g) => JSON.stringify(g.pattern)));
        inheritedPattern = patterns.size === 1 ? JSON.parse([...patterns][0]) : undefined;

        const kept = new Set<string>();
        for (const g of live) {
          await admin.put({ kind: "grant", body: { ...g, retired: true } });
          const keep = (g.operations ?? []).filter((op) => !granting.includes(op));
          if (keep.length > 0) {
            await admin.put({ kind: "grant", body: { ...g, operations: keep } });
            for (const op of keep) kept.add(op);
          }
        }
        // One line, however many duplicate grant records the space has accumulated.
        if (live.length > 0) {
          write(dim(
            `  withdrew wider ${granting.join(",")} on ${b.kind} so "own records only" holds` +
              `${kept.size > 0 ? ` (kept ${[...kept].join(",")})` : ""}\n`,
          ));
        }
      }
      // Assigned by the OPERATOR. The session could not write this record itself, which is the
      // whole point of the split.
      await admin.put({
        kind: "grant",
        body: {
          principal: subject,
          kind: b.kind,
          operations: granting,
          ...(selfScoped ? { scope: { createdBy: "self" } } : {}),
          ...(inheritedPattern ? { pattern: inheritedPattern } : {}),
        },
      });
      write(dim(
        `granted: ${granting.join(",")} on ${b.kind}${selfScoped ? " (its own records only)" : " (all records)"}` +
          `${inheritedPattern ? `, still limited to ${JSON.stringify(inheritedPattern)}` : ""}` +
          // Say what was withheld, or "granted" reads as "granted everything I asked for" and the
          // caller retries the operation it still cannot perform.
          `${selfScoped && writes.length > 0 ? `; withheld ${writes.join(",")} (not a read)` : ""}\n`,
      ));
    } else {
      write(dim("refused\n"));
    }
    // Handled either way: a refusal that stayed pending would re-prompt on every turn. The
    // assistant can ask again; that is a new request, and a new decision.
    //
    // This record is also the ANSWER CHANNEL: `request_grant` blocks on it, because the session can
    // read its own requests and has no grant on `grant` itself. So it carries what was actually
    // granted, not merely that something was. The requester asked for one scope and may have been
    // given another, and finding that out by retrying and failing is the loop this removes.
    await admin.put({
      kind: "grant_request",
      body: {
        ...b,
        retired: true,
        // The record is the audit trail, so it says WHY rather than flattening an impossible grant
        // into a plain refusal. `request_grant` keys off `noSuchKind` before it reads this, so the
        // requester's answer is unchanged.
        decision: unknown ? "no_such_kind" : answer === "no" ? "refused" : "granted",
        // A requester that cannot list kinds guesses one, and the guess is usually a TOOL name.
        // Telling it the real names HERE closes the loop in the same turn; otherwise it learns
        // only that the grant it was given authorizes nothing, and guesses again. (Seen twice, in
        // consecutive sessions, both times `space_event` for the `space_events` tool.)
        ...(unknown ? { noSuchKind: b.kind, kindsOnThisSpace: known.slice(0, 40) } : {}),
        ...(answer === "no" ? {} : {
          granted: {
            kind: b.kind,
            operations: granting,
            ...(writes.length > 0 && answer === "own" ? { withheld: writes, why: "not a read; 'own records only' is a read filter" } : {}),
            scope: answer === "own" ? "own records only" : "all records",
            ...(inheritedPattern ? { limitedTo: inheritedPattern } : {}),
          },
        }),
      },
    });
    write(`${dim("─".repeat(Math.min(60, columns())))}\n`);
  }
}
