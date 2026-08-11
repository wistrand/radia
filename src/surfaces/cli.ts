// The `radia` CLI (Phase 7). Every command goes through the public `/v0` surface via the TS
// SDK: no privileged backdoor, no direct storage access. If the CLI can do it, so can any
// client. Credentials come from `src/credentials.ts` (RADIA_TOKEN, else the token `radia dev`
// provisioned), so local invocations authenticate exactly like a deployed client would.
//
// Kinds, records, and relationships are DISCOVERED, never hardcoded: `kinds` is a query for
// `kind_def` records, `children`/`lineage` follow the graph, and no verb carries a table of
// known kinds.

import { RadiaClient, RadiaClientError } from "../../sdk/ts/client.ts";
// TYPE ONLY, which the layering guard exempts because it is erased: a surface may not hold a
// runtime VALUE from `src/core`, and a shape is not one. Restating it here instead is what let the
// two drift, and the drift compiled: `doctor` grew a `spotCheckedFrom` the CLI's private copy did
// not have, and only `deno task compile` noticed.
import type { Diagnostics } from "../core/inspection.ts";
// A SURFACE may import a convention; the runtime may not. See conformance/layering.test.ts.
import { exportWorkspaceGit } from "../../extensions/ts/git.ts";
import { buildThreadSpans, postTraces, recordSpans, toResourceSpans, traceIdOf } from "../../extensions/ts/otlp.ts";
import { basicPassword, gitHandler } from "../../extensions/ts/git-http.ts";
import { summarizeWorkspaces } from "../../extensions/ts/workspace.ts";
import { declareExecRequest, pinnedDigests, promote } from "../../extensions/ts/promotion.ts";
import { BINDING, type Binding, declareBinding, type Outcome, readBindings, sandboxInvoker, WorkspaceHost } from "../../extensions/ts/host.ts";
import { brokeredInvoker } from "../../extensions/ts/broker.ts";
import { auditCompartment } from "../../extensions/ts/compartment.ts";
import { defaultBase, resolveDefinitionToken, resolveToken, saveLogin, storedObserver } from "../credentials.ts";
import { flag, flags, has, positional } from "../flags.ts";
import { env, onShutdown, serve, stdin, UsageError } from "../platform.ts";
import type { Lease } from "../storage/adapter.ts";

const HELP = `radia <command> [options]

Options common to every command:
  --url <base>       space base URL (default: $RADIA_URL, else http://127.0.0.1:7788)
  --json             raw JSON output (default: a compact human table)

Inspect
  health                              backend, DB clock, resolved principal
  stats                               record counts by kind and state
  doctor                              diagnostics: dead-letters, stuck leases, stale work,
                                      erasures that no longer hold, sweepable retention backlog
  gc [--run] [--limit <n>]            the retention sweep. Prints what would go; --run deletes it
  erasures [--undone]                 every shred, and whether its payload is still gone
  flows [--granularity kind|kind+agent] [--counts bucketed|exact] [--min <n>] [--hub-degree <n>]
                                      recurring shapes of work, mined from lineage
  integrity                           verify the event chain; reports the FIRST divergence
  permissions <principal>             what that principal can actually do (the fold over its grants)
  login <principal> [--grant k:ops]… [--compact | --compact-definition]  (--console prints a sign-in LINK for the web console)
  login --sso [--sso-port <n>]     sign in through the space's OIDC issuer (browser click; no operator, no durable credential)
                                      mint a session for a person, and keep the durable half so
                                      the CLI signs in again by itself. --compact prints the
                                      session token alone; --compact-definition prints the
                                      durable one, for a tool that cannot re-authenticate
  shred <artifact-id> [--reason <t>] [--shared]  destroy an artifact's bytes, keep the record
  revoke <principal> [--reason <t>]   kill an agent definition's token, permanently
  kinds                               declared kinds (a query for kind_def records)
  get <record-id>                     one record
  lineage <record-id>                 ancestry via parent_ids
  children <record-id>                records descending from it
  events [--after <cursor> | --tail <n>] [--limit <n>]
  otlp --to <collector> (--thread <recordId> | --follow) [--trace-root <kind>]
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
  git-serve [--port <n>] [--host <h>] [--conversation <id>] [--partial] [--anonymous]
                                      serve every workspace at /<name>.git for \`git clone\`.
                                      Read-only; push is refused. Authenticate with a
                                      definition token as the HTTP password, so a clone reads
                                      what that principal can and \`radia revoke\` stops it

Workspace agents (a workspace digest as a principal's code; also a convention, see extensions/)
  promote <digest> --tier <t> --pin <principal>:<op,op>…  [--kind <k>]
                                      what a tier may run, as a grant rotation pinned to the
                                      digest. Grants the new one, then retires the old
  rollback <digest> --tier <t> --pin <principal>:<op,op>…  promotion pointed backwards
  pins <principal> --tier <t>         what that principal is pinned to, read from the grants
                                      that enforce it: "what is prod running"
  bind <agent> --digest <d> --entrypoint <p> [--sandbox <json>]
  bind <agent> --retire               which code an agent runs. THE ESCALATION ROOT, and inert
                                      without a matching pin: both locks must agree
  bindings                            every live binding
  host --agent <principal>=<token>… [--agents -] [--once] [--interval <ms>]
       [--no-broker] [--timeout <ms>] [--lease <s>] [--request-kind <k>]
                                      run bound agents' code AS them: holds each definition
                                      token, mints each run, claims under it. Brokered by
                                      default, so the jailed code reaches the space only
                                      through the host. \`--agents -\` takes a JSON map on
                                      stdin, which keeps tokens out of \`ps\`
  compartment --inside <kind,kind> [--field <f>] [--expect <p,p>]
                                      who can get data OUT: crossers granted both sides, plus
                                      the two doors that are not grants (unscoped artifact
                                      access, and \`observe\`). Run it at promotion

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

/** Verbs that only READ the ops plane ride the OBSERVER credential when one exists (architecture-ops-tiers.md
 *  phase 5): the operator token stays for coordination verbs and everything destructive, so a
 *  routine `radia doctor` is not a process holding the whole operator bit. An explicit
 *  `RADIA_TOKEN` still wins for every verb (resolveToken precedence). */
const OBSERVER_VERBS = new Set(["stats", "events", "doctor", "erasures", "flows", "integrity", "permissions", "get", "lineage", "children", "otlp"]);

/**
 * The CLI leg of OIDC sign-in (plan-oidc.md): the native-app LOOPBACK flow, RFC 8252. Discover
 * the issuer from the space's health, run code+PKCE through a one-shot listener on 127.0.0.1,
 * verify the nonce (only this process ever saw it), trade the id_token for a run token. No
 * operator involved and no durable half stored: sign-in authority stays with the IdP, so
 * deprovisioning there ends terminal access within one run ceiling.
 *
 * The PORT is part of the IdP's registration (`http://127.0.0.1:8253/*` must be a redirect URI
 * on the client), which is why it is fixed rather than ephemeral; `--sso-port` exists for a
 * space whose IdP registered a different one. Exported for the conformance dance, where `onUrl`
 * plays the browser.
 */
export async function ssoLogin(
  base: string,
  opts: { port?: number; onUrl?: (url: string) => void; timeoutMs?: number } = {},
): Promise<{ run: string; agent: string; runToken: string; expiresAt: string }> {
  const port = opts.port ?? 8253;
  const health = await fetch(`${base}/v0/health`).then((r) => r.json()).catch(() => null) as
    | { oidc?: { issuer: string; clientId: string } }
    | null;
  if (!health?.oidc) throw new UsageError("this space has no OIDC issuer configured (dev: --oidc-issuer + --oidc-audience)");
  const { issuer, clientId } = health.oidc;
  const disco = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`).then((r) => r.json()).catch(() => null) as
    | { authorization_endpoint?: string; token_endpoint?: string }
    | null;
  if (!disco?.authorization_endpoint || !disco?.token_endpoint) {
    throw new UsageError(`the issuer's discovery document is unreachable (${issuer}/.well-known/openid-configuration)`);
  }

  const rand = (n: number) => {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  };
  const b64url = (bytes: Uint8Array) => {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const verifier = rand(32), state = rand(16), nonce = rand(16), linkCode = rand(6);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier) as BufferSource)));
  const redirect = `http://127.0.0.1:${port}/`;

  // The one-shot listener: resolves on the first callback carrying OUR state; anything else
  // (favicon probes, stray tabs) gets a page and changes nothing.
  const stopping = new AbortController();
  let settle!: (v: string) => void, fail!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => {
    settle = res;
    fail = rej;
  });
  const page = (msg: string) =>
    new Response(`<!doctype html><meta charset="utf-8"><title>radia</title><body style="font:16px system-ui;padding:2em">${msg}</body>`, {
      headers: { "content-type": "text/html" },
    });
  const auth = new URL(disco.authorization_endpoint);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("client_id", clientId);
  auth.searchParams.set("redirect_uri", redirect);
  auth.searchParams.set("scope", "openid profile email"); // profile+email feed the enrollment record
  auth.searchParams.set("state", state);
  auth.searchParams.set("nonce", nonce);
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("code_challenge_method", "S256");

  try {
    serve({ port, hostname: "127.0.0.1", signal: stopping.signal }, (req) => {
      const u = new URL(req.url);
      // The SHORT url: `/<random path>` 302s to the full authorize URL, so what the terminal
      // prints is ~40 characters instead of a PKCE query string that wraps three lines and
      // breaks on click. The random path is what makes it deliberate: a probe of `/`, a
      // favicon fetch or a link preview cannot spend an authorize round trip by accident.
      if (u.pathname === `/${linkCode}`) {
        return new Response(null, { status: 302, headers: { location: auth.href } });
      }
      const err = u.searchParams.get("error");
      if (err) {
        fail(new UsageError(`the identity provider refused: ${err}${u.searchParams.get("error_description") ? " — " + u.searchParams.get("error_description") : ""}`));
        return page("Sign-in refused; you can close this tab.");
      }
      const got = u.searchParams.get("code");
      if (!got || u.searchParams.get("state") !== state) return page("Waiting for the sign-in to complete…");
      settle(got);
      return page("Signed in. You can close this tab and return to the terminal.");
    });
  } catch (e) {
    throw new UsageError(
      `cannot listen on 127.0.0.1:${port} (${(e as Error).message}); another sign-in running? --sso-port picks another, but the IdP must have that redirect URI registered`,
    );
  }

  (opts.onUrl ?? ((u: string) => {
    console.log("Open this in your browser to sign in:");
    console.log(`  ${u}`);
  }))(`${redirect}${linkCode}`);

  const timer = setTimeout(() => fail(new UsageError("timed out waiting for the browser sign-in (5 minutes)")), opts.timeoutMs ?? 300_000);
  let authCode: string;
  try {
    authCode = await code;
  } finally {
    clearTimeout(timer);
    stopping.abort();
  }

  const tr = await fetch(disco.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
  const tj = await tr.json().catch(() => ({})) as { id_token?: string; error?: string; error_description?: string };
  if (!tr.ok || !tj.id_token) throw new UsageError(`the token exchange failed: ${tj.error_description || tj.error || `HTTP ${tr.status}`}`);
  const seg = tj.id_token.split(".")[1] ?? "";
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  let payload: { nonce?: string } = {};
  try {
    payload = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
  } catch { /* refused below */ }
  if (payload.nonce !== nonce) throw new UsageError("nonce mismatch: the id_token is not from this sign-in");

  const sr = await fetch(`${base}/v0/sessions/oidc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id_token: tj.id_token }),
  });
  const sj = await sr.json().catch(() => ({})) as { run?: string; agent?: string; runToken?: string; expiresAt?: string; detail?: string };
  if (!sr.ok || !sj.runToken) throw new UsageError(`the space refused the id_token: ${sj.detail ?? `HTTP ${sr.status}`}`);
  return sj as { run: string; agent: string; runToken: string; expiresAt: string };
}

export async function runCli(cmd: string, argv: string[]): Promise<number> {
  if (cmd === "help") {
    console.log(HELP);
    return 0;
  }
  const base = flag(argv, "--url") ?? defaultBase();
  const observer = OBSERVER_VERBS.has(cmd) && !env("RADIA_TOKEN") ? storedObserver(base)?.definitionToken : undefined;
  const token = observer ? undefined : resolveToken(base);
  // Both halves, when both exist. Every CLI verb is a fresh PROCESS, so it can never renew a token
  // the way a long-running worker does: it either finds a live one or the command fails. With the
  // durable half it mints one instead, which is why `radia query` still works the morning after
  // `radia login` rather than a quarter of an hour later. The observer credential IS a durable
  // half, so it rides the same exchange.
  const definitionToken = observer ?? resolveDefinitionToken(base);
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
      // SSO (plan-oidc.md, the CLI leg): no principal argument, because the IdP says who you
      // are and the space's mapping registry names the principal. Nothing durable is stored;
      // past the run ceiling this command is one browser click again.
      if (has(argv, "--sso")) {
        const portFlag = flag(argv, "--sso-port");
        const sso = await ssoLogin(client.base, portFlag ? { port: Number(portFlag) } : {});
        const kept = saveLogin(client.base, { principal: sso.agent, token: sso.runToken, mintedAt: new Date().toISOString() });
        return out(ctx, { principal: sso.agent, run: sso.run, token: sso.runToken, expiresAt: sso.expiresAt }, () =>
          [
            `${sso.agent} signed in as ${sso.run} (expires ${sso.expiresAt}; clients renew it to the run ceiling)`,
            kept.ok
              ? `  kept at ${kept.path} — the chat and CLI verbs now run as ${sso.agent}.`
              : `  could not store the session (${kept.error}); it ends when the token does.`,
            `  No durable credential exists for an SSO session: when it ends, run this again.`,
          ].join("\n"));
      }
      const [who] = positional(argv, 1);
      if (!who) return usage("login <principal> [--grant <kind>:<op,op>]… [--compact|--compact-definition|--console] | login --sso [--sso-port <n>]");
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
      // The DURABLE half alone, for a tool that stores what it is given and cannot re-authenticate:
      // `git clone http://you:$(radia login human:me --compact-definition)@host/ws.git`. It is the
      // safer of the two to put in a URL, since it cannot read or write anything by itself.
      if (has(argv, "--compact-definition")) {
        console.log(def.definitionToken);
        return 0;
      }
      // The console handoff (plan-console-auth.md phase 2): a URL whose FRAGMENT carries the
      // durable half. Fragments never reach the server, and the page strips it from the address
      // bar and history before anything else runs. Open it and the browser is signed in, remembered.
      if (has(argv, "--console")) {
        console.log(`${client.base}/#token=${encodeURIComponent(def.definitionToken)}`);
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
        opsPowers?: string[];
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
        if (p.opsPowers && p.opsPowers.length > 0) lines.push(`  ops powers: ${p.opsPowers.join(", ")}`);
        lines.push(`  ops plane: ${p.ops.reachable ? `self-scoped reads for ${p.ops.kinds.join(", ")}` : p.opsPowers?.includes("observe") ? "unscoped reads (observe)" : "no"}`);
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
        if (r.truncated) {
          lines.push(
            `truncated: begins at link ${r.truncated.anchorIdx}, ${r.truncated.swept} events removed by event GC` +
              (r.truncated.attested ? " (attested)" : " (UNATTESTED)"),
          );
        }
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
          // SAY it is a spot check. "4000 links verified" for a walk that read the newest 500 is
          // the kind of reassurance nobody should receive on no evidence.
          lines.push(
            chain.spotCheckedFrom !== undefined
              ? `event chain: newest ${chain.sealed - chain.spotCheckedFrom} of ${chain.sealed} links verified, signed (radia integrity walks all of it)`
              : `event chain: ${chain.sealed} links verified, signed`,
          );
        }
        // The sweep is on demand, so the backlog line is the only way anyone learns to run it.
        const sw = d.sweepable;
        if (sw && sw.eligible > 0) {
          const kinds = Object.entries(sw.byKind).map(([k, n]) => `${k}=${n}`).join("  ");
          lines.push(`sweepable: ${sw.eligible}${sw.atLeast ? "+" : ""} records past retention (${kinds}) — radia gc to reclaim`);
        }
        // Two separate lines on purpose: the seal-first debt is why an event backlog can read as
        // zero, and on a never-doctored space it is the whole log, so the first gc looks hung
        // without this.
        const ev = d.eventsSweepable;
        if (ev && ev.eligible > 0) lines.push(`event log: ${ev.eligible} sealed events past retention — radia gc --run truncates (anchored + attested)`);
        if (ev && ev.unsealed > 0) lines.push(`event log: unsealed events pending — gc seals before it sweeps, so the first run pays the whole seal debt`);
        if (lines.length === 1) lines.push("no dead-letters, stuck leases, stale work, undone erasures, or sweepable backlog");
        return lines.join("\n");
      });
    }

    // The retention sweep. Deleting is the operator's act, so the DEFAULT prints what would go and
    // `--run` does it: a destructive verb whose no-argument form destroys nothing.
    case "gc": {
      const dry = !has(argv, "--run");
      const limitArg = flag(argv, "--limit");
      const r = await client.gc({ dryRun: dry, ...(limitArg ? { limit: Number(limitArg) } : {}) });
      return out(ctx, r, () => {
        const fmt = (byKind: Record<string, number>) => Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join("  ") || "(nothing)";
        const c = r.compaction;
        const compactLine = c && (c.superseded > 0 || c.compacted > 0)
          ? `\n${dry ? `${c.superseded} superseded registry entries` : `compacted ${c.compacted} registry entries`}${c.more ? "+" : ""}: ${fmt(c.byKind)}`
          : "";
        const idemLine = r.idempotency > 0 ? `\n${dry ? `${r.idempotency} aged idempotency rows` : `swept ${r.idempotency} aged idempotency rows`}` : "";
        const ev = r.events;
        const evLine = ev && ev.enabled
          ? "\n" + (dry
            ? `event log: ${ev.eligible} sealed events past retention${ev.unsealed ? ` (+${ev.unsealed}+ unsealed: gc seals first)` : ""}`
            : `event log: ${ev.attested === false ? "statement not sealed yet, nothing truncated (run again)" : `truncated ${ev.swept} events${ev.anchorIdx !== undefined ? ` to anchor ${ev.anchorIdx}` : ""}`}${ev.sealed ? `, sealed ${ev.sealed} links first` : ""}`)
          : "";
        return dry
          ? `${r.eligible}${r.more ? "+" : ""} sweepable: ${fmt(r.byKind)}${compactLine}${idemLine}${evLine}\nradia gc --run to delete them`
          : `swept ${r.swept}${r.more ? " (more remain: run again)" : ""}: ${fmt(r.byKind)}${compactLine}${idemLine}${evLine}`;
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
      const after = flag(argv, "--after");
      const limit = Number(flag(argv, "--limit") ?? "50") || 50;
      // The TAIL is the default. `radia events` used to print the OLDEST 50 of the log, which on
      // any long-lived space is ancient history presented as "the events"; --after keeps the
      // forward-paging behavior for a caller walking the log deliberately.
      const page = after !== undefined
        ? await client.getEventsPage(after, limit)
        : await client.getEventsPage("0", limit, { tail: Number(flag(argv, "--tail") ?? String(limit)) || limit });
      const evs = page.events;
      // A read below the event-GC horizon is served from the oldest retained event; say so, or
      // the table reads as the whole log.
      const note = page.logBeginsAfter !== undefined
        ? `(log begins after cursor ${page.logBeginsAfter}; ${page.sweptBefore} events swept before it)\n`
        : "";
      return out(ctx, page, () =>
        evs.length
          ? note + table(["SEQ", "OP", "KIND", "RECORD", "STATE"], evs.map((e) => [
            String(e.seq),
            e.operation,
            e.kind ?? "-",
            (e.recordId ?? "-").slice(-8),
            e.state ?? "-",
          ]))
          : note + "(no events)"
      );
    }

    // OTLP export: threads as traces, attempts as spans (extensions/ts/otlp.ts). A CLIENT that
    // pushes, the way git-serve is a client that listens: the runtime knows nothing about OTel,
    // and the collector (Jaeger v2, Tempo, Alloy) receives plain OTLP/HTTP JSON on /v1/traces.
    case "otlp": {
      const to = flag(argv, "--to");
      const thread = flag(argv, "--thread");
      const follow = has(argv, "--follow");
      if (!to || (!thread && !follow)) return usage("otlp --to <collector> (--thread <recordId> | --follow) [--trace-root <kind>]");
      const traceRootKind = flag(argv, "--trace-root");
      // `claimable` decides whether an unsettled record is OPEN work or reference data that sits
      // available by design. Best-effort: kind_def is a coordination read the observer credential
      // deliberately lacks, and without it every kind is treated as claimable, which only
      // over-reports `radia.open`.
      const claimable = new Map<string, boolean>();
      try {
        for (const rec of await client.query({ kind: "kind_def" }, 500, { dir: "desc" })) {
          const def = rec.body as { kind?: unknown; claimable?: unknown };
          if (def && typeof def.kind === "string" && !claimable.has(def.kind)) claimable.set(def.kind, def.claimable !== false);
        }
      } catch { /* scoped session: default everything claimable */ }
      const claimableOf = (k: string) => claimable.get(k) !== false;
      // Service names. A run principal is `run:<ulid>` and its AGENT lives in agent_run records:
      // the string carries no name and must never be parsed for one (design-auth.md). Resolve
      // through the records when this credential can read them; the observer cannot, so services
      // fall back to raw run ids — said once, not silently.
      const agents = new Map<string, string>();
      let runReadDenied = false;
      const resolveService = async (principal: string): Promise<string> => {
        if (!principal || !principal.startsWith("run:")) return principal;
        const hit = agents.get(principal);
        if (hit !== undefined) return hit;
        let name = principal;
        if (!runReadDenied) {
          try {
            const recs = await client.query({ kind: "agent_run", match: { run: principal } }, 1, { dir: "desc" });
            const agent = (recs[0]?.body as { agent?: unknown } | undefined)?.agent;
            if (typeof agent === "string" && agent) name = agent;
          } catch {
            runReadDenied = true;
            console.error("otlp: this credential cannot read agent_run records, so services are raw run ids (an operator token resolves them to agent names)");
          }
        }
        agents.set(principal, name);
        return name;
      };
      const serviceOf = (p: string) => agents.get(p) ?? p;
      // The trace boundary. Default: the lineage root. `--trace-root <kind>` cuts at the nearest
      // ancestor of that kind instead — the hub problem flows already hit: a conversation-rooted
      // trace is a whole multi-day chat, and `--trace-root message` makes the TURN the trace.
      // The lineage read that resolves a root also carries the full ANCESTRY records; the
      // follower backfills them into the trace, or every span in a turn points at a parent the
      // collector never received (Jaeger: "parent span ID is not in the trace" + Incomplete).
      const lineages = new Map<string, Awaited<ReturnType<typeof client.getLineage>>>();
      const rootOf = async (id: string) => {
        const lin = await client.getLineage(id);
        lineages.set(id, lin);
        if (traceRootKind) {
          let best: { record: { id: string; kind: string }; depth: number } | null = null;
          for (const n of lin) if (n.record.kind === traceRootKind && (!best || n.depth < best.depth)) best = n;
          if (best) return best.record.id;
        }
        let root = id, depth = -1;
        for (const n of lin) if (n.depth > depth || (n.depth === depth && n.record.id < root)) { depth = n.depth; root = n.record.id; }
        return root;
      };

      if (thread) {
        // One shot: membership by walking DOWN from the root, transitions by one pass over the
        // retained log filtered to the members. Bounded and says so when a bound bites.
        const root = await rootOf(thread);
        const members = new Map();
        const queue = [root];
        let truncatedWalk = false;
        while (queue.length) {
          const id = queue.shift()!;
          if (members.has(id)) continue;
          if (members.size >= 2000) { truncatedWalk = true; break; }
          const rec = await client.getRecord(id).catch(() => null);
          if (!rec) continue;
          members.set(id, rec);
          for (const child of await client.getChildren(id, 200)) if (!members.has(child.id)) queue.push(child.id);
        }
        const evs = [];
        let after = "0";
        let sweptNote = "";
        for (;;) {
          const p = await client.getEventsPage(after, 500);
          if (p.sweptBefore) sweptNote = `the log begins after event GC's horizon (${p.sweptBefore} events swept), so early attempts may be missing`;
          for (const e of p.events) if (e.recordId && members.has(e.recordId)) evs.push(e);
          if (!p.events.length || !p.nextAfter) break;
          after = p.nextAfter;
        }
        for (const rec of members.values()) await resolveService(rec.runtimeMeta.createdBy);
        for (const e of evs) await resolveService(e.runId);
        const rs = await buildThreadSpans([...members.values()], evs, root, {
          claimableOf,
          serviceOf,
          // A member whose first parent sits OUTSIDE this membership (a cross-thread parent, or
          // above a --trace-root cut) gets a LINK, never a dangling tree-parent.
          inTrace: (id: string) => members.has(id),
        });
        await postTraces(to, rs);
        const spans = rs.reduce((n, r) => n + r.scopeSpans[0].spans.length, 0);
        console.log(`exported ${spans} span(s) across ${rs.length} service(s), trace ${await traceIdOf(root)}`);
        if (truncatedWalk) console.log("note: the membership walk stopped at 2000 records; the trace is a prefix");
        if (sweptNote) console.log(`note: ${sweptNote}`);
        return 0;
      }

      // Follow: start from NOW (the tail gives a usable cursor even on an empty log), buffer each
      // record's transitions, and emit its spans when a terminal settle arrives. Ctrl-C flushes.
      const seed = await client.getEventsPage("0", 1, { tail: 1 });
      let cursor = String(seed.nextAfter ?? "0");
      const roots = new Map<string, string>(), recs = new Map<string, Awaited<ReturnType<typeof client.getRecord>> | null>(), buf = new Map<string, Parameters<typeof recordSpans>[1]>();
      const emitted = new Set<string>(); // record ids whose record span was sent: never send one twice
      // Terminals deferred because an ancestor is mid-attempt: emitting them would backfill the
      // ancestor's record span as zero-duration OPEN, and the dedupe rule would then pin it that
      // way forever even after its ack (observed live: an acked llm_call stuck at `radia.open`,
      // duration 0, because its progress child settled first). Key = the open ancestor;
      // flushed when it settles, or after HOLD_MS if it never does.
      const held = new Map<string, { rid: string; at: number }[]>();
      const HOLD_MS = 30_000;
      let pending: Parameters<typeof toResourceSpans>[0] = [], sent = 0, stopping = false;
      const unlisten = onShutdown(() => { stopping = true; });
      const flush = async () => {
        if (!pending.length) return;
        const batch = pending;
        pending = [];
        await postTraces(to, toResourceSpans(batch));
        sent += batch.length;
        console.error(`otlp: ${sent} span(s) exported`);
      };
      /** An ancestor currently mid-attempt (a take buffered with no settle yet), nearest first. */
      const openAncestorOf = (rid: string): string | undefined => {
        for (const n of [...(lineages.get(rid) ?? [])].sort((a, b) => a.depth - b.depth)) {
          if (n.record.id === rid || emitted.has(n.record.id)) continue;
          const evs = buf.get(n.record.id);
          if (!evs) continue;
          const takes = evs.filter((e) => e.operation === "take").length;
          const settles = evs.filter((e) => e.operation === "ack" || e.operation === "nack" || e.operation === "release").length;
          if (takes > settles) return n.record.id;
        }
        return undefined;
      };
      const emitTerminal = async (rid: string, force = false): Promise<void> => {
        const rec = recs.get(rid);
        const transitions = buf.get(rid);
        if (!rec || !transitions) return;
        // Defer while an ancestor is mid-attempt: its record span would otherwise backfill as
        // zero-duration OPEN and stay that way (one deterministic id, one send).
        if (!force) {
          const anc = openAncestorOf(rid);
          if (anc) {
            if (!held.has(anc)) held.set(anc, []);
            held.get(anc)!.push({ rid, at: Date.now() });
            return;
          }
        }
        await resolveService(rec.runtimeMeta.createdBy);
        for (const be of transitions) await resolveService(be.runId);
        const rootId = roots.get(rid) ?? rid;
        // Backfill ancestry, root first, so no span names a parent the collector never saw:
        // ancestors created before this follower started never settle in its window, so they
        // enter as zero-duration record spans. If one settles later, only its attempt spans
        // are added (emitRecordSpan: false) — one deterministic id is never sent twice.
        const lin = lineages.get(rid) ?? [];
        const inSet = new Set(lin.map((n) => n.record.id));
        inSet.add(rid);
        for (const n of [...lin].sort((a, b) => b.depth - a.depth)) {
          if (n.record.id === rid || emitted.has(n.record.id)) continue;
          await resolveService(n.record.runtimeMeta.createdBy);
          pending.push(...await recordSpans(n.record, [], rootId, {
            claimable: claimableOf(n.record.kind),
            serviceOf,
            inTrace: (id: string) => inSet.has(id),
          }));
          emitted.add(n.record.id);
        }
        pending.push(...await recordSpans(rec, transitions, rootId, {
          claimable: claimableOf(rec.kind),
          serviceOf,
          inTrace: (id: string) => inSet.has(id) || emitted.has(id),
          emitRecordSpan: !emitted.has(rid),
        }));
        emitted.add(rid);
        buf.delete(rid);
        // A settled record is done: keep only the emitted-marker, or a long follow leaks a
        // record, a lineage and a root per thing the space ever did.
        lineages.delete(rid);
        roots.delete(rid);
        recs.delete(rid);
        // Everything that was waiting on THIS record's attempt can now emit, nested under a
        // record span that carries its real duration.
        const waiting = held.get(rid);
        if (waiting) {
          held.delete(rid);
          for (const h of waiting) await emitTerminal(h.rid);
        }
      };
      console.error(`otlp: following ${client.base ?? ""} -> ${to} (Ctrl-C to stop)`);
      while (!stopping) {
        const p = await client.getEventsPage(cursor, 200);
        for (const e of p.events) {
          const rid = e.recordId;
          if (!rid) continue;
          if (!buf.has(rid)) buf.set(rid, []);
          buf.get(rid)!.push(e);
          if (!recs.has(rid)) recs.set(rid, await client.getRecord(rid).catch(() => null));
          if (!roots.has(rid)) roots.set(rid, await rootOf(rid).catch(() => rid));
          const rec = recs.get(rid);
          if (!rec) continue;
          // A kind declared after this follower started is not in the map yet; look it up once,
          // or a new reference kind's records would never read as terminal for the whole session.
          if (!claimable.has(rec.kind)) {
            try {
              const kd = await client.query({ kind: "kind_def", match: { kind: rec.kind } }, 1, { dir: "desc" });
              claimable.set(rec.kind, kd.length ? (kd[0].body as { claimable?: unknown }).claimable !== false : true);
            } catch {
              claimable.set(rec.kind, true);
            }
          }
          const terminal = e.operation === "ack" || e.operation === "release" ||
            (e.operation === "nack" && e.state === "dead_letter") ||
            (e.operation === "put" && !claimableOf(rec.kind));
          if (terminal) await emitTerminal(rid);
        }
        // A held record whose ancestor never settled (crashed worker, an expired lease waiting
        // for a re-take) must not wait forever: past HOLD_MS it emits with the old backfill
        // behavior, which is the session-boundary posture anyway.
        const now = Date.now();
        for (const [anc, list] of held) {
          const due = list.filter((h) => now - h.at >= HOLD_MS);
          if (!due.length) continue;
          held.set(anc, list.filter((h) => now - h.at < HOLD_MS));
          for (const h of due) await emitTerminal(h.rid, true);
        }
        if (p.events.length && p.nextAfter) cursor = p.nextAfter;
        await flush();
        await new Promise((r) => setTimeout(r, 1000));
      }
      await flush();
      unlisten?.();
      return 0;
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

    case "git-serve": {
      // A CLIENT that happens to listen. It reads workspaces over `/v0` like anything else and the
      // runtime learns nothing about git, which is the same split that made `workspace-git` a verb
      // rather than an endpoint (see agent_docs/plan-workspaces.md §12).
      // NOT 7789, which is where this started: `radia dev --port 7788` binds 7788 for the space and
      // 7789 for the isolated artifact origin (`port + 1`), so the obvious neighbour collides with a
      // default space every time.
      const port = Number(flag(argv, "--port") ?? 7790);
      const conversationId = flag(argv, "--conversation");
      const anonymous = has(argv, "--anonymous");
      // One client per credential, not per request. A dumb-protocol clone is one request per object,
      // and a fresh client each time would exchange the credential each time: a hundred `agent_run`
      // records for one clone, which is the fastest-growing kind in the space by a wide margin.
      const clients = new Map<string, RadiaClient>();
      const handler = gitHandler(
        async (req, { startsFetch }) => {
          // The CALLER's credential, so a clone reads what that person could read. `--anonymous`
          // serves under this process's own instead: right for a laptop, wrong for anything shared,
          // which is why it is a flag rather than a fallback.
          if (anonymous) return client;
          const password = basicPassword(req);
          if (!password) return null;
          // RE-AUTHENTICATE at the start of a fetch: minting is the only way to find out whether a
          // definition token is still live, and doing it here bounds `radia revoke` to "cannot start
          // another clone" rather than "stops working when the cached run expires, in 15 minutes".
          if (startsFetch) clients.delete(password);
          const cached = clients.get(password);
          if (cached) return cached;
          // A definition token, so the clone survives its own session: git replays a stored secret
          // and has no way to renew. The SDK exchanges it for a run token.
          const fresh = new RadiaClient(client.base, { definitionToken: password });
          await fresh.ensureCredential(); // throws if the definition is revoked, which is a 401
          clients.set(password, fresh);
          return fresh;
        },
        { ...(conversationId ? { conversationId } : {}), partial: has(argv, "--partial") },
        (entry) => {
          // A CHALLENGE is not a failure: HTTP Basic opens with one, so every authenticated clone
          // produces at least one 401 before it produces anything else. Logging those turned a
          // working clone into a wall of alarming lines, and under the dumb walk (one request per
          // object) into forty of them.
          if (entry.challenge) return;
          if (entry.status >= 400) {
            console.error(`  ${entry.status} ${entry.path}`);
            return;
          }
          // And say when one WORKS, because the alternative is a server that prints nothing for a
          // successful clone and a page of text for a failed one.
          if (entry.path.endsWith("/git-upload-pack")) {
            const n = entry.bytes;
            const size = n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`;
            console.log(`  fetch ${entry.workspace}: ${size} packed`);
          }
        },
      );
      // The signal is what makes Ctrl-C work. `onShutdown` REPLACES the default terminating
      // behaviour for SIGINT and SIGTERM, so registering a handler that does nothing leaves a server
      // nothing can stop short of SIGKILL. Same shape as `radia dev`: abort, let `finished` resolve,
      // return a status. Never `exit` outside `src/main.ts`.
      const stopping = new AbortController();
      let server;
      try {
        server = serve({ port, hostname: flag(argv, "--host") ?? "127.0.0.1", signal: stopping.signal }, handler);
      } catch (e) {
        // `Address already in use (os error 98)` on its own names neither the port nor a way out.
        // A space occupies TWO ports, which is the collision people will actually hit.
        if ((e as Error).name === "AddrInUse" || /already in use/i.test((e as Error).message ?? "")) {
          console.error(`error: port ${port} is already in use. Pick another with --port <n>.`);
          console.error(`  note: a space binds two ports — ${new URL(client.base).port || 80} for /v0 and the next one for the artifact origin.`);
          return 1;
        }
        throw e;
      }
      console.log(`git server on http://127.0.0.1:${port}  (reading ${client.base})`);
      console.log(
        anonymous
          ? `  git clone http://127.0.0.1:${port}/<workspace>.git      (serving as this process; anyone who can reach the port can read)`
          : `  git clone http://you:$(radia login <principal> --compact-definition)@127.0.0.1:${port}/<workspace>.git`,
      );
      console.log(`  radia workspaces  lists what is there. Read-only: push is refused.`);
      const unlisten = onShutdown(() => stopping.abort());
      try {
        await server.finished;
      } finally {
        unlisten();
      }
      return 0;
    }

    // ---- workspace agents (architecture-workspace-agents.md) ----
    //
    // These are CLIENT verbs like `workspace-git`: promotion is a grant rotation and a binding is a
    // record, so the runtime gains nothing and the wire contract gains no entry. Until they existed
    // the only way to promote or host was to write TypeScript against `extensions/ts/`, which meant
    // the enforcement path had no operator surface at all.

    case "promote":
    case "rollback": {
      // One implementation, two names, because `rollback` is `promote` pointed backwards and the
      // audit trail reads better when the intent is in the verb.
      const [digest] = positional(argv, 1);
      const tier = flag(argv, "--tier");
      const pins = parsePins(argv);
      if (!digest || !tier || pins.length === 0) {
        return usage(`${cmd} <tree-digest> --tier <tier> --pin <principal>:<op,op> [--pin …] [--kind <k>]`);
      }
      // A grant pattern may only name DECLARED indexed paths, so an undeclared `exec_request`
      // makes every pin fail to compile. Declare the default kind here (idempotent, content-keyed)
      // rather than leaving a first promotion to fail on a rule nobody reads until it bites. A
      // custom `--kind` is the caller's to declare: its indexed paths are not ours to invent.
      if (!flag(argv, "--kind")) await declareExecRequest(client);
      const r = await promote(client, { digest, tier, pins, ...(flag(argv, "--kind") ? { kind: flag(argv, "--kind") } : {}) });
      return out(ctx, r, () => {
        const lines = [`${cmd} ${digest.slice(0, 20)}… on tier '${tier}'`];
        for (const g of r.granted) lines.push(`  grant   ${g.principal} -> this digest`);
        for (const x of r.retired) lines.push(`  retire  ${x.principal} -> ${x.digest.slice(0, 20)}… (was live)`);
        // Grant-then-retire means a rotation that half-ran leaves BOTH live, which over-permits
        // rather than stalling. Say so: it is the state `pins` will report and nobody should have
        // to infer it from a count.
        if (r.granted.length > 0 && r.retired.length === 0) {
          lines.push(`  nothing retired: either this is the first promotion on '${tier}', or the previous pin is still live`);
        }
        lines.push(`  radia pins ${r.granted[0]?.principal ?? "<principal>"} --tier ${tier}   confirms from the enforcement path`);
        return lines.join("\n");
      });
    }

    case "pins": {
      // "What is prod running", answered from the grants that enforce it rather than a deploy log.
      const [principal] = positional(argv, 1);
      const tier = flag(argv, "--tier");
      if (!principal || !tier) return usage("pins <principal> --tier <tier> [--kind <k>]");
      const digests = await pinnedDigests(client, { principal, tier, ...(flag(argv, "--kind") ? { kind: flag(argv, "--kind") } : {}) });
      return out(ctx, { principal, tier, digests }, () => {
        if (digests.length === 0) return `${principal} is pinned to nothing on '${tier}' (it can claim no work there)`;
        // Two is not an error and not a tie: it is a rotation in flight or one that half-finished,
        // and hiding it behind a "current" that picks one is how a half-promotion goes unnoticed.
        if (digests.length > 1) {
          return [`${principal} on '${tier}' is pinned to ${digests.length} digests (a rotation in flight, or one that half-finished):`, ...digests.map((d) => `  ${d}`)].join("\n");
        }
        return `${principal} on '${tier}': ${digests[0]}`;
      });
    }

    case "bind": {
      // THE ESCALATION ROOT. Whoever writes one of these chooses which code runs under an
      // identity's authority, which is why the kind is operator-only and why this prints what it
      // just decided rather than "ok".
      const [agent] = positional(argv, 1);
      if (!agent) return usage("bind <agent> --digest <tree-digest> --entrypoint <path> [--sandbox <json>] | bind <agent> --retire");
      await declareBinding(client);
      if (has(argv, "--retire")) {
        const current = (await readBindings(client)).find((b) => b.agent === agent);
        if (!current) return usage(`bind: ${agent} has no live binding to retire`);
        await client.put({ kind: BINDING, body: { ...current, retired: true } as unknown as Record<string, unknown> });
        return out(ctx, { agent, retired: true, was: current }, () => `${agent}: binding retired. It claims nothing until bound again (the grant is untouched; retire that too to close both locks)`);
      }
      const digest = flag(argv, "--digest"), entrypoint = flag(argv, "--entrypoint");
      if (!digest || !entrypoint) return usage("bind <agent> --digest <tree-digest> --entrypoint <path> [--sandbox <json>]");
      const sandboxPattern = flag(argv, "--sandbox") ? json(flag(argv, "--sandbox")!, "sandbox") : undefined;
      const body: Binding = { agent, workspaceDigest: digest, entrypoint, ...(sandboxPattern ? { sandboxPattern } : {}) };
      const rec = await client.put({ kind: BINDING, body: body as unknown as Record<string, unknown> });
      // The second lock is a different record, and a binding alone is inert. Saying so here is
      // cheaper than the silence a reader would otherwise read as "deployed".
      const pinned = await pinnedDigests(client, { principal: agent, tier: flag(argv, "--tier") ?? "prod" }).catch(() => [] as string[]);
      return out(ctx, { id: rec.id, ...body, pinnedDigests: pinned }, () => {
        const lines = [`${agent} now runs ${entrypoint} from ${digest.slice(0, 20)}…`];
        if (pinned.includes(digest)) lines.push(`  grant agrees: pinned to this digest, so a host will run it`);
        else if (pinned.length === 0) lines.push(`  INERT: ${agent} holds no pin, so it can claim nothing. radia promote ${digest} --tier <t> --pin ${agent}:take`);
        else lines.push(`  MISMATCH: the grant pins ${pinned.map((d) => d.slice(0, 20) + "…").join(", ")}. A host refuses this pairing (digest_mismatch) rather than running it`);
        return lines.join("\n");
      });
    }

    case "bindings": {
      const bindings = await readBindings(client);
      return out(ctx, bindings, () => {
        if (bindings.length === 0) return "no bindings";
        return table(
          ["AGENT", "ENTRYPOINT", "TREE", "SANDBOX"],
          bindings.map((b) => [b.agent, b.entrypoint, b.workspaceDigest.slice(0, 14) + "…", b.sandboxPattern ? JSON.stringify(b.sandboxPattern) : "deno (default)"]),
        );
      });
    }

    case "host": {
      // A CLIENT that happens to run other people's code, the way `git-serve` is a client that
      // happens to listen. It holds each agent's DEFINITION token (mint-only: it cannot read, write
      // or claim) and claims under a run minted from it, so one host serving ten agents needs none
      // of their authority.
      const credentials = parseAgentTokens(argv, await hostTokensFromStdin(argv));
      if (Object.keys(credentials).length === 0) {
        return usage("host --agent <principal>=<definition-token> [--agent …] | host --agents - (a JSON map on stdin)");
      }
      const timeoutMs = Number(flag(argv, "--timeout") ?? 15_000);
      // Brokered by default: it is the invoker that leaves the entrypoint no way to reach the API,
      // which is what makes containment structural rather than this process's discipline.
      const invoke = has(argv, "--no-broker") ? sandboxInvoker(client, { timeoutMs }) : brokeredInvoker(client, { timeoutMs });
      const host = new WorkspaceHost({
        base: client.base,
        credentials,
        reader: client,
        invoke,
        ...(flag(argv, "--request-kind") ? { requestKind: flag(argv, "--request-kind") } : {}),
        ...(flag(argv, "--lease") ? { leaseSeconds: Number(flag(argv, "--lease")) } : {}),
      });
      const once = has(argv, "--once");
      const interval = Number(flag(argv, "--interval") ?? 1000);
      const agents = Object.keys(credentials);
      if (!ctx.json) {
        console.log(`host: ${agents.length} agent${agents.length === 1 ? "" : "s"} (${agents.join(", ")}), ${has(argv, "--no-broker") ? "plain jail, no space access" : "brokered"}`);
        console.log(`  reading ${client.base}. A bound agent with no matching pin claims nothing; radia bindings, radia pins <a> --tier <t>`);
      }
      let stopping = false;
      const unlisten = onShutdown(() => {
        stopping = true;
      });
      const totals = { acked: 0, failed: 0, refused: 0, digest_mismatch: 0 };
      try {
        for (;;) {
          const outcomes = await host.tick();
          for (const o of outcomes) {
            if (o.status === "idle") continue;
            if (o.status in totals) totals[o.status as keyof typeof totals]++;
            console.log(ctx.json ? JSON.stringify(o) : `  ${describeOutcome(o)}`);
          }
          if (once || stopping) break;
          // Only sleep when there was nothing to do: a busy host should not pace itself.
          if (outcomes.every((o) => o.status === "idle")) await new Promise((r) => setTimeout(r, interval));
        }
      } finally {
        unlisten();
      }
      if (!ctx.json) console.log(`stopped: ${totals.acked} acked, ${totals.failed} failed, ${totals.refused} refused, ${totals.digest_mismatch} digest_mismatch`);
      return 0;
    }

    case "compartment": {
      // The promotion checklist. Crossing out is reserved to a principal granted BOTH sides and
      // nothing enforces that but the grants themselves, so the audit is how a mis-written grant is
      // found before it is trusted.
      const inside = (flag(argv, "--inside") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (inside.length === 0) return usage("compartment --inside <kind,kind> [--field <f>] [--expect <principal,principal>]");
      const expected = new Set((flag(argv, "--expect") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
      const audit = await auditCompartment(client, { inside, ...(flag(argv, "--field") ? { field: flag(argv, "--field") } : {}) });
      const unexpected = audit.crossers.filter((c) => !expected.has(c.principal));
      return out(ctx, { ...audit, unexpected: unexpected.map((c) => c.principal) }, () => {
        const lines = [`compartment ${inside.join(", ")}`];
        if (audit.crossers.length === 0) lines.push("  crossers: none");
        for (const c of audit.crossers) {
          const mark = expected.has(c.principal) ? "expected" : "UNEXPECTED";
          lines.push(`  crosser ${c.principal} (${mark}): reads ${c.reads.join(",")} -> writes ${c.writes.join(",")}`);
        }
        // The two doors that are not grants on the compartment's kinds, which is exactly why an
        // audit that only read those would report a clean boundary.
        for (const a of audit.unscopedArtifact) lines.push(`  artifact ${a.principal}: ${a.operations.join(",")} with NO ${flag(argv, "--field") ?? "compartment"} pattern (artifact is reserved: scoped by pattern or not at all)`);
        for (const p of audit.opsPowers) lines.push(`  ops     ${p.principal}: ${p.powers.join(",")}${p.powers.includes("observe") ? "  (observe reads every body, and is no grant)" : ""}`);
        for (const c of audit.caveats) lines.push(`  caveat: ${c}`);
        if (expected.size > 0) lines.push(unexpected.length === 0 ? `  OK: no crosser outside --expect` : `  FINDING: ${unexpected.length} crosser(s) outside --expect`);
        return lines.join("\n");
      });
    }

    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

/** `--pin <principal>:<op,op>`. Split at the LAST colon, since a principal carries one of its own
 *  (`agent:prod-runner:take`), and validate the verbs so `--pin agent:foo` cannot silently parse as
 *  principal `agent` with an operation `foo`. */
function parsePins(argv: string[]): { principal: string; operations: string[] }[] {
  const VERBS = new Set(["put", "query", "read_one", "take"]);
  return flags(argv, "--pin").map((p) => {
    const i = p.lastIndexOf(":");
    if (i <= 0) throw new UsageError(`--pin wants <principal>:<op,op>, got '${p}'`);
    const operations = p.slice(i + 1).split(",").map((s) => s.trim()).filter(Boolean);
    const bad = operations.filter((o) => !VERBS.has(o));
    if (operations.length === 0 || bad.length > 0) {
      throw new UsageError(`--pin wants <principal>:<op,op> where each op is one of ${[...VERBS].join("/")}, got '${p}'`);
    }
    return { principal: p.slice(0, i), operations };
  });
}

/** `--agent <principal>=<definition-token>`, repeatable, merged over whatever `--agents` supplied. */
function parseAgentTokens(argv: string[], base: Record<string, string>): Record<string, string> {
  const creds = { ...base };
  for (const a of flags(argv, "--agent")) {
    const i = a.indexOf("=");
    if (i <= 0) throw new UsageError(`--agent wants <principal>=<definition-token>, got '${a.slice(0, 40)}'`);
    creds[a.slice(0, i)] = a.slice(i + 1);
  }
  return creds;
}

/** `--agents -` reads `{"agent:x": "<definition-token>"}` from stdin. A token passed as an argument
 *  is visible in `ps` to every user on the box, so the stdin form is the one to use anywhere shared. */
async function hostTokensFromStdin(argv: string[]): Promise<Record<string, string>> {
  const spec = flag(argv, "--agents");
  if (!spec) return {};
  const text = spec === "-" ? new TextDecoder().decode(await readAll(stdin())) : spec;
  const parsed = json(text, "agents");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== "string") throw new UsageError(`--agents wants {"<principal>": "<definition-token>"}; ${k} is not a string`);
    out[k] = v;
  }
  return out;
}

function describeOutcome(o: Outcome): string {
  switch (o.status) {
    case "acked":
      return `${o.agent} acked ${o.recordId.slice(-8)}${o.resultId ? ` -> ${o.resultId.slice(-8)}` : ""}`;
    case "failed":
      return `${o.agent} FAILED ${o.recordId.slice(-8)}: ${o.error}`;
    case "refused":
      // Not an error: an agent with no grant is the design working. Named so it is not mistaken
      // for a crash, and so the missing half is obvious.
      return `${o.agent} refused (${o.reason}) — it holds no pin for this work`;
    case "digest_mismatch":
      return `${o.agent} DIGEST MISMATCH on ${o.recordId.slice(-8)}: grant pins ${o.wanted.slice(0, 16)}…, binding says ${o.bound.slice(0, 16)}…. Claim released; fix one of the two locks`;
    default:
      return `${o.agent} idle`;
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

