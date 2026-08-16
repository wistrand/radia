// OPERATOR RECOVERY: give a person's current machines access to conversations none of them can open.
//
//   deno run -A examples/chat/recover-keys.ts human:alice            # report what would change
//   deno run -A examples/chat/recover-keys.ts human:alice --apply    # do it
//
// For the one case a session cannot fix itself. A conversation is sealed to the machines a person
// had at the time, and a later machine is extended by any session that can already read it
// (`conversationKeys(..., enrolFor)`). When EVERY such machine is gone there is no session left to
// do the extending, and only the fleet can still open the conversation.
//
// WHY THIS IS A VERB AND NOT A REQUEST. A stolen credential gets an attacker the records, which are
// ciphertext, but not the content: their machine's key is not among the wraps, and that is a real
// second factor. A recovery anyone could ask for would turn credential theft directly into content
// theft. So an operator runs this, after establishing who is asking by means this space knows
// nothing about — a conversation, a badge, a ticket.
//
// Adding a reader cannot be undone (nothing here re-keys a conversation), so it reports by default
// and changes nothing without `--apply`.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { fleetKeyPair, recoverPersonKeys } from "./space/keys.ts";
import { arg, argOn } from "./util.ts";

const url = Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const principal = Deno.args.find((a) => a.startsWith("human:") || a.startsWith("agent:"));
if (!principal) {
  console.error("usage: recover-keys.ts <human:principal> [--conversation <id>] [--apply]");
  console.error("  Reports what would change. Nothing is written without --apply.");
  Deno.exit(1);
}

const admin = new RadiaClient(url, { token: operatorToken(url) });
// Read, never created: a process that minted its own fleet key here would hold a private half whose
// public half sealed nothing, and would report every conversation as unrecoverable.
const fleet = await fleetKeyPair();
if (!fleet) {
  console.error(`no fleet key on this host. Recovery needs the fleet's PRIVATE half, so run this`);
  console.error(`  where the fleet runs, or set RADIA_CHAT_FLEET_KEY.`);
  Deno.exit(1);
}

const apply = argOn("--apply");
const conversationId = arg("--conversation");
const r = await recoverPersonKeys(admin, principal, fleet, {
  apply,
  ...(conversationId ? { conversationId } : {}),
});

console.log(`${principal}: ${r.scanned} conversation${r.scanned === 1 ? "" : "s"} scanned`);
for (const e of r.extend) console.log(`  ${apply ? "extended" : "would extend"} ${e.conversationId} to ${e.keyIds.join(", ")}`);
for (const c of r.erased) console.log(`  ${c} was ERASED: its key is destroyed and no recovery reaches it`);
if (r.extend.length === 0) {
  console.log(`  nothing to do: every conversation already opens on a machine they have published`);
} else if (!apply) {
  console.log(`\nRe-run with --apply to perform it. This cannot be undone: a reader added to a`);
  console.log(`conversation stays a reader, because nothing here re-keys one.`);
}
