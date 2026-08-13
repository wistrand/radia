// Operator tool: give a person this app's grants, without minting them a credential.
//
// The gap it fills. A session joining a shared fleet cannot assign its own grants — that is the
// whole point of the split (agent_docs/plan-scaling.md item 3) — and an SSO identity arrives with
// ZERO grants by design: an unmapped `(iss, sub)` auto-enrolls under a derived
// `human:oidc-…` principal that holds nothing until somebody decides what it may do
// (agent_docs/plan-oidc.md). Somebody holding the operator credential runs this, once per person.
//
// NOT `radia login <principal> --grant …`, which is the obvious-looking alternative and is WRONG
// for an SSO identity: that verb creates an `agent_definition`, i.e. a DURABLE credential, and the
// OIDC design deliberately has no durable half so that deprovisioning at the IdP bites within one
// run ceiling. This writes grant records and nothing else, so the only way in stays the IdP.
//
//   deno run -A examples/chat/grant-user.ts human:oidc-a918902abbc14d6a6a6ec0ab109577b8
//   deno run -A examples/chat/grant-user.ts human:alice --conversation 01K…   # thread-scoped
//
// Run it against the space the fleet serves (RADIA_URL, default http://127.0.0.1:7788), AFTER
// `--serve` has registered the kinds: a grant pattern is validated against the kind it names, and
// a kind that does not exist yet cannot validate one.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { assignUserGrants } from "./space/roles.ts";
import { arg } from "./util.ts";

const url = Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const principal = Deno.args.find((a) => !a.startsWith("--"));
if (!principal) {
  console.error("usage: grant-user.ts <human:principal> [--conversation <id>]");
  console.error("  Gives that principal this app's grant set. Find an SSO principal with:");
  console.error("    radia query oidc_identity --json");
  Deno.exit(1);
}
if (!principal.startsWith("human:")) {
  console.error(`'${principal}' is not a person: this assigns a SESSION's grants, and a session is a human principal.`);
  Deno.exit(1);
}

const token = operatorToken(url);
if (!token) {
  console.error(`No operator credential for ${url}. Assigning grants is privileged; set RADIA_TOKEN.`);
  Deno.exit(1);
}
const admin = new RadiaClient(url, { token });

// Identity scope by default, matching the chat's own default (`RADIA_CHAT_SCOPE`): everything this
// person produced, across their conversations. `--conversation` is the stricter posture, and the
// session must then be started with `--conversation <the same id>` or its grants bind nothing.
const conversationId = arg("--conversation");
const scope = conversationId ? { conversationId } : { owner: principal };

await assignUserGrants(admin, principal, scope);

// Read it back from the ENFORCEMENT path rather than reporting what was written: every grant bug in
// this project has been a promise that did not match what was enforced, and this is the one command
// that answers from the other side.
const perms = await admin.permissions(principal) as {
  kinds: { kind: string; operations: string[] }[];
  complete: boolean;
};
console.log(`${principal} can now:`);
for (const k of perms.kinds) console.log(`  ${k.kind.padEnd(16)} ${k.operations.join(",")}`);
console.log(`  scope: ${JSON.stringify(scope)}`);
if (!perms.complete) console.log("  WARNING: the grant scan could not be exhausted; this view may be partial");
console.log(`\nThey can now run:  deno task chat        (join mode, on their own login)`);
