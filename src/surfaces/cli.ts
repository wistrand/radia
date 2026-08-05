// The `radia` CLI (Phase 7). Every command goes through the public `/v0` surface via the TS
// SDK: no privileged backdoor, no direct storage access. If the CLI can do it, so can any
// client. Credentials come from `src/credentials.ts` (RADIA_TOKEN, else the token `radia dev`
// provisioned), so local invocations authenticate exactly like a deployed client would.
//
// Kinds, records, and relationships are DISCOVERED, never hardcoded: `kinds` is a query for
// `kind_def` records, `children`/`lineage` follow the graph, and no verb carries a table of
// known kinds.

import { RadiaClient, RadiaClientError } from "../../sdk/ts/client.ts";
// A SURFACE may import a convention; the runtime may not. See conformance/layering.test.ts.
import { exportWorkspaceGit } from "../../extensions/ts/git.ts";
import { summarizeWorkspaces } from "../../extensions/ts/workspace.ts";
import { defaultBase, resolveDefinitionToken, resolveToken, saveLogin } from "../credentials.ts";
import { flag, flags, has, positional } from "../flags.ts";
import { onShutdown, stdin, UsageError } from "../platform.ts";
import type { Lease } from "../storage/adapter.ts";

const HELP = `radia <command> [options]

Options common to every command:
  --url <base>       space base URL (default: $RADIA_URL, else http://127.0.0.1:7788)
  --json             raw JSON output (default: a compact human table)

Inspect
  health                              backend, DB clock, resolved principal
  stats                               record counts by kind and state
  doctor                              diagnostics: dead-letters, stuck leases, stale work,
                                      erasures that no longer hold
  erasures [--undone]                 every shred, and whether its payload is still gone
  flows [--granularity kind|kind+agent] [--counts bucketed|exact] [--min <n>] [--hub-degree <n>]
                                      recurring shapes of work, mined from lineage
  integrity                           verify the event chain; reports the FIRST divergence
  permissions <principal>             what that principal can actually do (the fold over its grants)
  login <principal> [--grant k:ops]… [--compact]  mint a session token for a person
                                      (--compact prints the token alone, for $(…) capture)
  shred <artifact-id> [--reason <t>] [--shared]  destroy an artifact's bytes, keep the record
  revoke <principal> [--reason <t>]   kill an agent definition's token, permanently
  kinds                               declared kinds (a query for kind_def records)
  get <record-id>                     one record
  lineage <record-id>                 ancestry via parent_ids
  children <record-id>                records descending from it
  events [--after <cursor>] [--limit <n>]
  watch <kind> [--match <json>]       stream wakeups until interrupted

Coordinate
  put <kind> <json-body> [--idempotency-key <k>] [--parent <id>]...
  query <kind> [--match <json>] [--order <json>] [--limit <n>]
  read-one <kind> [--match <json>] [--order <json>]
  take <kind> [--match <json>] [--lease <seconds>] [--untainted | --allow-taint <l,l>]
  ack <lease-json> [--result-kind <k> --result <json>] [--idempotency-key <k>]
  nack <lease-json> [--backoff <seconds>]
  release <lease-json>

Remediate (operator)
  reclaim <record-id>                 un-stick ONE expired lease
  reclaim --all [--limit <n>] [--drain]      every expired lease
  dead-letter <record-id>             give up on ONE record
  dead-letter --all [--stale <secs>] [--limit <n>] [--drain]
  requeue <record-id>                 return ONE dead-lettered record to available
  requeue --all [--limit <n>] [--drain]

Workspaces (a convention, not a runtime concept: see extensions/)
  workspaces [--conversation <id>]    what trees exist, newest version of each
  workspace-git <name> --dir <out> [--conversation <id>] [--branch <n>] [--partial]
                                      a workspace's version history as a git repository
                                      (bare: \`git clone <out>\` for a working copy).
                                      --partial exports what survives an ERASED payload,
                                      naming every omission in the commit that lost it

\`take\` prints the claimed record together with its lease; pass that lease object straight back
to \`ack\`/\`nack\`/\`release\` (as a JSON string, or - to read it from stdin).

The \`--all\` forms take an envelope SELECTOR rather than an id (the same one \`doctor\` reports on),
so draining a backlog is one call per page instead of one per record. \`--drain\` repeats until
nothing matches; without it a single page runs (default 200) and the output says whether more
remain.`;

interface Ctx {
  client: RadiaClient;
  json: boolean;
  /** Whether a credential was found and presented. Used to explain an `anonymous` principal. */
  token: boolean;
}

export async function runCli(cmd: string, argv: string[]): Promise<number> {
  if (cmd === "help") {
    console.log(HELP);
    return 0;
  }
  const base = flag(argv, "--url") ?? defaultBase();
  const token = resolveToken(base);
  // Both halves, when both exist. Every CLI verb is a fresh PROCESS, so it can never renew a token
  // the way a long-running worker does: it either finds a live one or the command fails. With the
  // durable half it mints one instead, which is why `radia query` still works the morning after
  // `radia login` rather than a quarter of an hour later.
  const definitionToken = resolveDefinitionToken(base);
  const ctx: Ctx = {
    client: new RadiaClient(base, { ...(token ? { token } : {}), ...(definitionToken ? { definitionToken } : {}) }),
    json: has(argv, "--json"),
    token: !!token || !!definitionToken,
  };
  try {
    return await dispatch(cmd, argv, ctx);
  } catch (e) {
    if (e instanceof RadiaClientError) {
      console.error(`error: ${e.message}`);
      return 1;
    }
    const msg = (e as Error).message ?? String(e);
    if (/error sending request|connection refused|Fetch failed|ConnectionRefused/i.test(msg)) {
      console.error(`error: cannot reach a space at ${base}. Is \`radia dev\` running? (override with --url or $RADIA_URL)`);
      return 1;
    }
    console.error(`error: ${msg}`);
    return 1;
  }
}

async function dispatch(cmd: string, argv: string[], ctx: Ctx): Promise<number> {
  const { client } = ctx;
  switch (cmd) {
    case "health": {
      const h = await client.health();
      return out(ctx, h, () => {
        let line = `${h.storage}  principal=${h.principal}  now=${h.now}  v${h.version}`;
        // `GET /v0/health` is public, so a REJECTED token still returns 200, as `anonymous`.
        // Without this note that reads as "no credential" rather than "bad credential".
        if (ctx.token && h.principal === "anonymous") {
          line += `\nwarning: a credential was presented but the space rejected it (stale or wrong token).`;
        } else if (!ctx.token) {
          line += `\nnote: no credential presented. Relying on this space's open-mode operator default.`;
        }
        return line;
      });
    }

    case "stats": {
      const rows = await client.getStats();
      return out(ctx, rows, () =>
        rows.length
          ? table(["KIND", "STATE", "COUNT"], rows.map((r) => [r.kind, r.state, String(r.count)]))
          : "(empty space)"
      );
    }

    case "login": {
      // Log a PERSON in as themselves, with the grants an operator chooses.
      //
      // There was no way to do this: a definition principal had to be `agent:`, and every
      // `human:*` was an operator by name shape, so the only human credential available was
      // god-mode. Now a person is an ordinary principal unless the space names them an operator,
      // and this mints their session through the same bootstrap chain every agent uses.
      // `positional`, not `argv[0]`: a flag written before the principal would otherwise BE the
      // principal. Silent rather than loud, since a principal is just a string — `permissions
      // --json alice` cheerfully reported on a principal named "--json".
      const [who] = positional(argv, 1);
      if (!who) return usage("login <principal> [--grant <kind>:<op,op>]… [--compact]");
      if (!who.startsWith("human:")) return usage("login <principal>  (principal must start with 'human:')");
      const grants = flags(argv, "--grant").map((g) => {
        const [kind, ops] = String(g).split(":");
        if (!kind || !ops) throw new UsageError(`--grant wants <kind>:<op,op>, got '${g}'`);
        return { principal: who, kind, operations: ops.split(",").map((o) => o.trim()).filter(Boolean) };
      });
      const def = await client.createAgentDefinition(who, grants as never);
      const run = await client.createRun(def.definitionToken);
      // KEEP THE DURABLE HALF. It was created and thrown away, so a session lasted 15 minutes and
      // could be stretched to 12 hours by renewing, after which the only remedy was to run this
      // command again. The definition token cannot read or write anything — the space refuses it
      // for coordination — so what is stored is a mint-only credential, and `radia revoke` is its
      // off switch. Written to the same per-user file the CLI already reads, owner-only.
      const stored = saveLogin(client.base, {
        principal: who,
        token: run.runToken,
        definitionToken: def.definitionToken,
        mintedAt: new Date().toISOString(),
      });
      // Report what the person can ACTUALLY do, not what this command just added. A `--grant`-less
      // login is not necessarily a powerless one: grants are assigned by whoever holds the ops
      // plane, so an app (the chat) or an earlier login may already have given this principal its
      // set. Saying "nothing yet" on the strength of an empty argv is the promise-vs-enforcement
      // gap this codebase keeps rediscovering; ask the space instead.
      // `--compact`: the token and nothing else, for `TOK=$(radia login human:me --compact)`.
      // Deliberately not `--json`, which is the machine-readable form of the WHOLE answer; this is
      // the one field a shell almost always wants, on stdout with no decoration to strip.
      if (has(argv, "--compact")) {
        console.log(run.runToken);
        return 0;
      }
      const held = await client.permissions(who) as { kinds: { kind: string; operations: string[] }[] };
      return out(ctx, { principal: who, run: run.run, token: run.runToken, expiresAt: run.expiresAt, kinds: held.kinds }, () =>
        [
          `${who} signed in as ${run.run} (expires ${run.expiresAt})`,
          held.kinds.length > 0
            ? `  can: ${held.kinds.map((k) => `${k.kind}:${k.operations.join(",")}`).join("  ")}`
            : "  can: nothing. This session authenticates but cannot read or write until someone grants it something (--grant, or an app that assigns its own).",
          "",
          `  ${run.runToken}`,
          "",
          "  Paste that into the console's principal pill, or send it as Authorization: Bearer.",
          "  It expires in minutes; the CLI does not need it, and mints its own from the credential",
          "  below whenever the short one lapses.",
          "",
          stored.ok
            ? `  kept at ${stored.path} — \`radia\` now signs in as ${who} without asking again.\n` +
              `  Revoke it with \`radia revoke ${who}\`; nothing else takes it away.`
            : `  could not store the durable credential (${stored.error}); this session ends when the token above does.`,
        ].join("\n"));
    }

    // The off switch the bootstrap chain was missing. A run token expires and can be stopped; a
    // DEFINITION token minted fresh runs forever, so a leak had no remedy short of rebuilding the
    // space. Operator-only, and it leaves running work alone: revoke, then stop the runs that matter.
    case "revoke": {
      const [who] = positional(argv, 1);
      if (!who) return usage("revoke <principal> [--reason <text>]");
      const r = await client.revokeDefinition(who, { reason: flag(argv, "--reason") }) as {
        agent: string;
        applied: boolean;
        alreadyRevoked: boolean;
      };
      return out(ctx, r, () =>
        r.alreadyRevoked
          ? `${r.agent}: already revoked, nothing to do`
          : `revoked the definition token for ${r.agent}\n` +
            `  it can mint no further runs. Runs already minted keep their own tokens until they\n` +
            `  expire or are stopped: radia doctor, then stop the ones that matter.`);
    }

    case "shred": {
      // Erasure is irreversible and by CONTENT, so the verb says both out loud before doing it.
      const [id] = positional(argv, 1);
      if (!id) return usage("shred <artifact-record-id> [--reason <text>] [--shared]");
      const r = await client.shredArtifact(id, {
        reason: flag(argv, "--reason"),
        acknowledgeShared: has(argv, "--shared"),
      }) as { digest: string; references: number; encrypted: boolean; alreadyGone: boolean; note: string };
      return out(ctx, r, () =>
        [
          `erased the content of ${id}`,
          `  digest:     ${r.digest}${r.references > 1 ? `  (shared by ${r.references} records, all of which lose it)` : ""}`,
          `  method:     ${r.note}`,
          r.alreadyGone ? `  note:       the bytes were already absent; the erasure is now recorded` : "",
          `  the record, its lineage and the event log survive: only the payload is gone.`,
        ].filter(Boolean).join("\n"));
    }

    case "permissions": {
      // "What can this principal do?" is the question behind every grant bug in this codebase,
      // asked directly instead of inferred from a denial.
      const [who] = positional(argv, 1);
      if (!who) return usage("permissions <principal>");
      const p = await client.permissions(who) as {
        privileged: boolean;
        subject: string;
        complete: boolean;
        ops: { reachable: boolean; kinds: string[] };
        kinds: { kind: string; operations: string[]; readsScopedToSelf: boolean; patterns: unknown[] }[];
      };
      return out(ctx, p, () => {
        if (p.privileged) return `${who} is PRIVILEGED (operator): every kind, every operation, full ops plane.`;
        const lines = [`${who}${p.subject !== who ? `  (grants held by ${p.subject})` : ""}`];
        if (p.kinds.length === 0) lines.push("  no grants");
        for (const k of p.kinds) {
          const scope = k.readsScopedToSelf ? "   reads: own records only" : "";
          const pat = k.patterns.length > 0 ? `   scoped to ${JSON.stringify(k.patterns)}` : "";
          lines.push(`  ${k.kind.padEnd(20)} ${k.operations.join(",")}${scope}${pat}`);
        }
        lines.push(`  ops plane: ${p.ops.reachable ? `readable for ${p.ops.kinds.join(", ")}` : "no"}`);
        if (!p.complete) lines.push("  WARNING: the grant scan could not be exhausted; this view may be incomplete");
        return lines.join("\n");
      });
    }

    // A shred destroys the runtime's COPY, never the ability to store those bytes: the content
    // address stays valid, so anyone holding the payload can write it back and every record that
    // referenced it reads again. Nothing noticed until this existed. See the erasure invariant in
    // CLAUDE.md for why neither refusing the write nor refusing the read is the fix.
    case "erasures": {
      const undoneOnly = has(argv, "--undone");
      const r = await client.erasures({ undone: undoneOnly }) as {
        erasures: { artifactId: string; digest: string; reason: string; at: string; method: string; holds: boolean }[];
        checked: number;
        complete: boolean;
      };
      return out(ctx, r, () => {
        if (r.erasures.length === 0) {
          return r.complete
            ? `no ${undoneOnly ? "undone " : ""}erasures (${r.checked} shred records checked)`
            : `none found, but the scan stopped after ${r.checked} records: this is a PREFIX`;
        }
        const lines = r.erasures.map((e) =>
          `${e.holds ? "held " : "UNDONE"}  ${e.artifactId}  ${e.digest.slice(0, 12)}…  ${e.method}  ${e.at}${e.reason ? `  ${e.reason}` : ""}`
        );
        if (!r.complete) lines.push(`(INCOMPLETE after ${r.checked} records; more may exist)`);
        return lines.join("\n");
      });
    }

    case "integrity": {
      const r = await client.integrity();
      return out(ctx, r, () => {
        const lines = [
          r.ok
            ? `chain OK: ${r.checked} of ${r.sealed} links verified${r.signed ? ", signed" : ""}`
            : `chain BROKEN at link ${r.failure?.idx}: ${r.failure?.reason} (${r.failure?.detail})`,
        ];
        if (r.head) lines.push(`head ${r.head.idx} ${r.head.hash.slice(0, 16)}…`);
        if (r.unsealed > 0) lines.push(`${r.unsealed}+ events not yet sealed (sealing follows the finality watermark)`);
        // Never let an unsigned chain be quoted as tamper-detection. It is not, and the difference
        // is the entire value of the feature.
        if (!r.signed) lines.push("UNSIGNED: detects corruption and careless edits, NOT a rewrite. Set RADIA_SEAL_KEY.");
        return lines.join("\n");
      });
    }

    case "flows": {
      const granularity = flag(argv, "--granularity");
      const counts = flag(argv, "--counts");
      const min = flag(argv, "--min");
      const hub = flag(argv, "--hub-degree");
      const r = await client.flows({
        ...(granularity ? { granularity: granularity as "kind" | "kind+agent" } : {}),
        ...(counts ? { counts: counts as "bucketed" | "exact" } : {}),
        ...(min ? { minOccurrences: Number(min) } : {}),
        ...(hub !== undefined ? { hubDegree: Number(hub) } : {}),
      });
      return out(ctx, r, () => {
        if (r.flows.length === 0) return r.note ?? "no shapes mined";
        // Display only. The signature is the GROUP KEY, so truncating it upstream would merge
        // shapes that differ past the cut and report a count for a thing that does not exist;
        // `--json` carries every one in full.
        const lines = r.flows.map((f) =>
          `${String(f.occurrences).padStart(4)}x  ${String(Math.round(f.successRate * 100)).padStart(3)}%  ` +
          `n=${String(f.medianRecords).padStart(3)}  ${humanMs(f.medianDurationMs).padStart(7)}  ` +
          truncate(f.signature, 140)
        );
        lines.push(
          `\n${r.scanned.records} records over ${r.scanned.kinds.length} kinds, ${r.scanned.subgraphs} subgraphs` +
            (r.hubs ? `, ${r.hubs} cut as hubs (--hub-degree 0 to leave them whole)` : "") +
            (r.singletons ? `, ${r.singletons} linked to nothing (--json for the whole shape)` : "") +
            (r.fragments ? `, ${r.fragments} fragment${r.fragments === 1 ? "" : "s"} (a parent was outside the scan)` : ""),
        );
        // Never let a mined diagram read as the whole story. It looks equally complete either way,
        // which is exactly why the caveat has to be printed rather than inferable.
        for (const n of r.notes ?? []) lines.push(`INCOMPLETE: ${n}`);
        return lines.join("\n");
      });
    }

    case "doctor": {
      const d = await client.diagnostics() as Diagnostics;
      return out(ctx, d, () => {
        const c = d.counts ?? {};
        const lines = [Object.entries(c).map(([k, v]) => `${k}=${v}`).join("  ")];
        if (d.deadLetter?.count) lines.push(`dead-letter: ${d.deadLetter.count}`);
        if (d.stuckLeases?.count) lines.push(`stuck leases: ${d.stuckLeases.count} (expired but still held)`);
        if (d.staleAvailable?.count) {
          const sp = d.staleAvailable.split;
          // The split is the actionable half: the two causes call for opposite responses, and the
          // old single number left an operator to guess which one they had.
          lines.push(
            `stale available: ${d.staleAvailable.count}` +
              (sp ? ` (${sp.orphaned.count} orphaned: nothing is listening; ${sp.starving.count} starving: a listener is not claiming)` : ""),
          );
          for (const o of (sp?.orphaned.sample ?? []).slice(0, 3)) {
            const x = o as { recordId?: string; kind?: string };
            lines.push(`  orphaned ${x.kind} ${x.recordId}`);
          }
          if (sp && !sp.complete) lines.push("  interest scan INCOMPLETE: 'orphaned' may be overstated");
          if (sp) lines.push(`  ${sp.caveat}`);
        }
        // FIRST among the findings when there is one, and worded as the security event it is. An
        // erasure that stopped holding outranks a stuck lease: somebody destroyed a payload and it
        // is readable again, and until this existed nothing in the system would ever have said so.
        // Ahead of the operational findings, for the same reason the erasure line is: a broken
        // chain means the history this report is computed FROM cannot be trusted, so a clean bill
        // of health below it would be worse than no report.
        const chain = d.integrity;
        if (chain && !chain.ok) {
          lines.push(
            `EVENT CHAIN BROKEN at link ${chain.failure?.idx}: ${chain.failure?.reason} — ${chain.failure?.detail}`,
          );
          lines.push(`  radia integrity for the full report; the log below link ${chain.failure?.idx} is unverified`);
        } else if (chain && !chain.signed && chain.sealed > 0) {
          lines.push(`event chain: ${chain.sealed} links, UNSIGNED (detects corruption, not a rewrite; set RADIA_SEAL_KEY)`);
        }
        const undone = d.undoneErasures;
        if (undone?.count) {
          lines.push(
            `ERASURES NO LONGER HOLDING: ${undone.count} of ${undone.checked} — the payload is back ` +
              `at the same content address and every record referencing it reads again`,
          );
          for (const e of (undone.sample ?? []).slice(0, 5)) {
            const x = e as { artifactId?: string; reason?: string; at?: string };
            lines.push(`  ${x.artifactId}${x.reason ? ` (${x.reason})` : ""} shredded ${x.at}`);
          }
          if ((undone.sample ?? []).length > 5) lines.push(`  …and ${(undone.sample ?? []).length - 5} more in the sample`);
          lines.push("  radia erasures --undone for the full list");
          // The remedy AND its cost together. A finding that names a problem and not the fix gets
          // read as unfixable; a fix named without its cost gets run without the decision. Erasing
          // is by CONTENT, so re-shredding destroys the bytes for the later record that legitimately
          // stored them too — `shred` refuses without `--shared` precisely to force that choice, so
          // saying it here only moves the surprise earlier.
          const first = (undone.sample ?? [])[0] as { artifactId?: string } | undefined;
          lines.push(
            `  to re-erase: radia shred ${first?.artifactId ?? "<artifact-id>"} --shared` +
              " — this destroys those bytes for EVERY record holding them, including whoever stored" +
              " them again, and the finding clears once the payload is gone",
          );
        }
        if (undone && !undone.complete) lines.push(`erasure scan INCOMPLETE after ${undone.checked} records: more may not hold`);
        // Name the chain even when it is fine. An all-clear that silently omits a check it ran
        // reads as a broader guarantee than it is, and this is the check whose absence nobody
        // notices until it matters.
        if (chain?.ok && chain.signed && chain.sealed > 0) {
          lines.push(`event chain: ${chain.sealed} links verified, signed`);
        }
        if (lines.length === 1) lines.push("no dead-letters, stuck leases, stale work, or undone erasures");
        return lines.join("\n");
      });
    }

    // Remediation. Each verb takes EITHER one record id or `--all` with a selector. The selector
    // is the same shape `doctor` reports on, so "what is wrong" and "fix it" share a vocabulary;
    // per-id stays for surgical cases. Every transition is state-guarded, so re-running is safe
    // and a worker that comes back mid-drain simply keeps its record.
    case "reclaim":
    case "dead-letter":
    case "requeue": {
      const action = cmd as "reclaim" | "dead-letter" | "requeue";
      const [recordId] = positional(argv, 1);
      if (recordId && !has(argv, "--all")) {
        const r = await client.admin(action, recordId);
        return out(ctx, r, () => `${action} ${recordId}: ${r.applied ? "applied" : "no change (already moved on)"}`);
      }
      if (!has(argv, "--all")) {
        console.error(`error: ${action} needs a <record-id>, or --all to remediate by selector`);
        return 2;
      }
      // Defaults chosen so the common intent is the short command: reclaiming and dead-lettering
      // target lapsed leases, requeue targets the dead-letter queue.
      const stale = flag(argv, "--stale");
      const selector = {
        state: action === "requeue" ? "dead_letter" : stale !== undefined ? "available" : "leased",
        expired: action !== "requeue" && stale === undefined,
        ...(stale !== undefined ? { stale: Number(stale) } : {}),
        ...(flag(argv, "--limit") ? { limit: Number(flag(argv, "--limit")) } : {}),
      };
      const pages: { matched: number; applied: number; more: boolean }[] = [];
      for (;;) {
        const page = await client.remediate(action, selector);
        pages.push(page);
        if (!page.more || !has(argv, "--drain")) break;
      }
      const applied = pages.reduce((n, p) => n + p.applied, 0);
      const matched = pages.reduce((n, p) => n + p.matched, 0);
      const more = pages[pages.length - 1].more;
      return out(ctx, { action, selector, pages: pages.length, matched, applied, more }, () => {
        const head = `${action}: ${applied} applied of ${matched} matched, in ${pages.length} call${pages.length === 1 ? "" : "s"}`;
        return more ? `${head}\nmore remain: re-run with --drain (or a larger --limit)` : head;
      });
    }

    case "kinds": {
      const defs = await client.listKinds();
      return out(ctx, defs, () =>
        defs.length
          ? table(["KIND", "INDEXED", "SORTABLE", "CLAIMABLE"], defs.map((d) => [
            d.kind,
            (d.indexedPaths ?? []).map((p) => p.path).join(",") || "-",
            (d.sortablePaths ?? []).join(",") || "-",
            String(d.claimable ?? true),
          ]))
          : "(no kinds declared)"
      );
    }

    case "put": {
      const [kind, bodyArg] = positional(argv, 2);
      if (!kind || bodyArg === undefined) return usage("put <kind> <json-body>");
      const parents = flags(argv, "--parent");
      const req = { kind, body: json(bodyArg, "body"), ...(parents.length ? { parentIds: parents } : {}) };
      const r = await client.put(req, flag(argv, "--idempotency-key"));
      return out(ctx, r, () => r.id);
    }

    case "query": {
      const [kind] = positional(argv, 1);
      if (!kind) return usage("query <kind> [--match <json>]");
      const recs = await client.query(pattern(kind, argv), Number(flag(argv, "--limit") ?? "50"));
      return out(ctx, recs, () => recordTable(recs));
    }

    case "read-one": {
      const [kind] = positional(argv, 1);
      if (!kind) return usage("read-one <kind> [--match <json>]");
      const rec = await client.readOne(pattern(kind, argv));
      return out(ctx, rec, () => (rec ? JSON.stringify(rec.body) : "(no match)"));
    }

    case "get": {
      const [id] = positional(argv, 1);
      if (!id) return usage("get <record-id>");
      const rec = await client.getRecord(id);
      if (!rec) {
        console.error(`error: no record ${id}`);
        return 1;
      }
      return out(ctx, rec, () => JSON.stringify(rec, null, 2));
    }

    case "lineage": {
      const [id] = positional(argv, 1);
      if (!id) return usage("lineage <record-id>");
      const lin = await client.getLineage(id);
      return out(ctx, lin, () => lin.map((n) => `${"  ".repeat(n.depth)}${n.depth ? "└ " : "● "}${n.record.id}  ${n.record.kind}`).join("\n"));
    }

    case "children": {
      const [id] = positional(argv, 1);
      if (!id) return usage("children <record-id>");
      const kids = await client.getChildren(id);
      return out(ctx, kids, () => recordTable(kids));
    }

    case "events": {
      const evs = await client.getEvents(flag(argv, "--after") ?? "0", Number(flag(argv, "--limit") ?? "50"));
      return out(ctx, evs, () =>
        evs.length
          ? table(["SEQ", "OP", "KIND", "RECORD", "STATE"], evs.map((e) => [
            String(e.seq),
            e.operation,
            e.kind ?? "-",
            (e.recordId ?? "-").slice(-8),
            e.state ?? "-",
          ]))
          : "(no events)"
      );
    }

    case "watch": {
      const [kind] = positional(argv, 1);
      if (!kind) return usage("watch <kind> [--match <json>]");
      const ac = new AbortController();
      // Ctrl-C ends the stream cleanly rather than killing mid-frame.
      onShutdown(() => ac.abort());
      for await (const w of client.watch(pattern(kind, argv), ac.signal)) {
        console.log(ctx.json ? JSON.stringify(w) : `${w.seq}  ${w.kind}  ${w.recordId}`);
      }
      return 0;
    }

    case "take": {
      const [kind] = positional(argv, 1);
      if (!kind) return usage("take <kind> [--lease <seconds>]");
      const claimed = await client.take({ pattern: pattern(kind, argv) }, {
        leaseSeconds: flag(argv, "--lease") ? Number(flag(argv, "--lease")) : undefined,
        // `--untainted` is the empty allowlist; `--allow-taint file,net` states one.
        allowTaint: has(argv, "--untainted") ? [] : (flag(argv, "--allow-taint")?.split(",").map((t) => t.trim()).filter(Boolean)),
      });
      if (!claimed) {
        // Nothing claimable is a normal outcome, not a failure, so exit 0 and let scripts loop.
        if (ctx.json) console.log("null");
        else console.log("(nothing available)");
        return 0;
      }
      return out(ctx, claimed, () =>
        `claimed ${claimed.record.id} (${claimed.record.kind}) until ${claimed.lease.expiresAt}\n` +
        `body:  ${JSON.stringify(claimed.record.body)}\n` +
        `lease: ${JSON.stringify(claimed.lease)}`);
    }

    case "ack": {
      const lease = await leaseArg(argv);
      if (!lease) return usage("ack <lease-json>");
      const kind = flag(argv, "--result-kind");
      const body = flag(argv, "--result");
      const result = kind ? { kind, body: body ? json(body, "result") : {} } : undefined;
      const r = await client.ack(lease, result, flag(argv, "--idempotency-key"));
      return out(ctx, r, () => (r.status === "ok" ? `ok${r.resultId ? ` -> ${r.resultId}` : ""}` : r.status));
    }

    case "nack": {
      const lease = await leaseArg(argv);
      if (!lease) return usage("nack <lease-json>");
      const backoff = flag(argv, "--backoff");
      const r = await client.nack(lease, backoff ? { backoffSeconds: Number(backoff) } : {});
      return out(ctx, r, () => r.status);
    }

    case "release": {
      const lease = await leaseArg(argv);
      if (!lease) return usage("release <lease-json>");
      const r = await client.release(lease);
      return out(ctx, r, () => r.status);
    }

    // The ONE verb that reaches outside the runtime, and the reason the surfaces layer exists as a
    // directory rather than an argument. A workspace is a CONVENTION (`extensions/`), not something
    // the substrate knows about, so the runtime must not import it; the CLI is a `/v0` client and
    // may. `conformance/layering.test.ts` holds that line in both directions.
    // `query workspace` cannot answer this: every VERSION is a record, so three rows for one tree
    // read as three trees. The projection is latest-wins-minus-retired, the same rule every registry
    // here uses, and it is shared with the chat's tool so the two never disagree.
    case "workspaces": {
      const r = await summarizeWorkspaces(client, { conversationId: flag(argv, "--conversation") });
      return out(ctx, r, () => {
        if (r.workspaces.length === 0) return "no workspaces";
        const rows = r.workspaces.map((w) => [
          w.name + (w.forked ? " (FORKED)" : ""),
          String(w.files),
          String(w.versions),
          w.treeDigest.slice(0, 14) + "…",
          w.owner,
        ]);
        const head = ["NAME", "FILES", "VERSIONS", "TREE", "OWNER"];
        const width = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
        const line = (cells: string[]) => cells.map((c, i) => c.padEnd(width[i])).join("  ").trimEnd();
        const body = [line(head), ...rows.map(line)];
        // A truncated list must never read as a complete one, which is the whole reason
        // `summarizeWorkspaces` reports this instead of returning a plausible prefix.
        if (!r.complete) body.push(`(INCOMPLETE: stopped after ${r.scanned} records; raise the page budget)`);
        const forked = r.workspaces.filter((w) => w.forked);
        for (const w of forked) {
          body.push(`${w.name}: ${w.heads.length} heads, none merged — radia workspace-git ${w.name} --dir <out>, then git log --graph --all`);
        }
        return body.join("\n");
      });
    }

    case "workspace-git": {
      const [name] = positional(argv, 1);
      const dir = flag(argv, "--dir");
      if (!name || !dir) return usage("workspace-git <name> --dir <out> [--conversation <id>] [--branch <n>] [--partial]");
      const r = await exportWorkspaceGit(client, name, dir, {
        conversationId: flag(argv, "--conversation"),
        branch: flag(argv, "--branch"),
        partial: has(argv, "--partial"),
      });
      const heads = Object.entries(r.branches);
      return out(ctx, r, () => {
        const lines = [
          `${name}: ${r.versions.length} version${r.versions.length === 1 ? "" : "s"}, ${r.objects} objects -> ${r.dir}`,
          ...heads.map(([b, c]) => `  ${b === r.head ? "*" : " "} ${b} ${c.slice(0, 12)}`),
        ];
        // A fork is the one line a reader must not skim: two heads mean somebody wrote a successor
        // to the same version, and neither side was merged or lost.
        if (heads.length > 1) lines.push(`  FORKED: ${heads.length} heads, none merged. git log --graph --all`);
        // Loud, and listed. "Exported successfully" over a repository missing files is one step away
        // from here, so the omissions get their own lines rather than a count.
        if (r.partial) {
          lines.push(`  PARTIAL: ${r.erased.length} file version(s) omitted, payload ERASED:`);
          for (const path of [...new Set(r.erased.map((e) => e.path))].sort()) lines.push(`    ${path}`);
          lines.push(`  each commit that lost one says so; see the repo's description file`);
        }
        lines.push(`  git clone ${r.dir} my-checkout`);
        return lines.join("\n");
      });
    }

    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

// ---- argument helpers ----

function json(text: string, what: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`--${what} is not valid JSON: ${text}`);
  }
}

function pattern(kind: string, argv: string[]) {
  const match = flag(argv, "--match");
  const order = flag(argv, "--order");
  return {
    kind,
    match: match ? json(match, "match") : undefined,
    orderBy: order ? JSON.parse(order) : undefined,
  };
}

/** A lease from the first positional argument, or from stdin when it is `-`. */
async function leaseArg(argv: string[]): Promise<Lease | undefined> {
  const [arg] = positional(argv, 1);
  if (!arg) return undefined;
  const text = arg === "-" ? new TextDecoder().decode(await readAll(stdin())) : arg;
  const parsed = JSON.parse(text);
  // Accept either a bare lease or the whole `take` output, so a pipeline can pass either.
  return (parsed.lease ?? parsed) as Lease;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of stream) chunks.push(c);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }
  return buf;
}

// ---- output ----

function out(ctx: Ctx, data: unknown, human: () => string): number {
  console.log(ctx.json ? JSON.stringify(data, null, 2) : human());
  return 0;
}

function usage(line: string): number {
  console.error(`usage: radia ${line}`);
  return 2;
}

function recordTable(recs: { id: string; kind: string; body: unknown }[]): string {
  if (!recs.length) return "(no records)";
  return table(["ID", "KIND", "BODY"], recs.map((r) => [r.id.slice(-8), r.kind, truncate(JSON.stringify(r.body), 60)]));
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** A duration a reader can compare at a glance. Flow durations span milliseconds to days. */
function humanMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function table(headers: string[], rows: string[][]): string {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(w[i])).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

interface Diagnostics {
  counts?: Record<string, number>;
  deadLetter?: { count: number };
  stuckLeases?: { count: number };
  staleAvailable?: {
    count: number;
    split?: {
      orphaned: { count: number; sample: unknown[] };
      starving: { count: number };
      complete: boolean;
      caveat: string;
    };
  };
  undoneErasures?: { count: number; checked: number; complete: boolean; sample: unknown[] };
  integrity?: { ok: boolean; sealed: number; signed: boolean; failure?: { idx: number; reason: string; detail: string } };
}
