// Opt-in policy: everyone the IdP vouches for may use this chat.
//
// Without it, an SSO identity enrolls with ZERO grants (agent_docs/plan-oidc.md: an unmapped
// `(iss, sub)` auto-admits under a derived principal that holds nothing) and somebody holding the
// operator credential has to run `grant-user.ts` per person, copying a 32-hex principal out of one
// terminal into another. With it, the `--serve` process — which already holds that credential and
// is already parked — assigns the standard session grants as each person enrolls.
//
// WHY IT IS A FLAG AND NOT THE DEFAULT. It converts "authenticated at the IdP" into "authorized to
// use this app", which is a real policy decision and often the right one (a corporate realm where
// everyone may chat). The substrate deliberately refuses to make it for you: a fresh identity holds
// nothing until somebody decides. `--auto-grant` is that somebody, saying so once.
//
// WHAT THE BAN IS, once this is on. RETIRING THEIR MAPPING, which is the mechanism plan-oidc.md
// designed for exactly this ("retire is a ban") and which `activeByKey` drops from the view below
// without any check of ours.
//
// Revoking a person's grants is NOT a ban, and the way it fails is worth stating precisely because
// it is not the obvious way. A sweep decides each principal ONCE PER PROCESS (the `decided` set
// below), so revoking looks like it worked — until the fleet restarts, when the sweep sees a
// principal holding nothing and admits them again. Something that holds until the next deploy is
// worse than something that never holds, because only the second one gets noticed.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { sweepEnrolments, watchEnrolments } from "../../../extensions/ts/enrolment.ts";
import { assignUserGrants } from "./roles.ts";

// The generic half lives in `extensions/ts/enrolment.ts`: paging the identity registry to
// exhaustion, deciding each principal once per process, and never re-assigning to someone who
// already holds something. Two apps want it (this and examples/analysis), and every one of those
// details has a failure behind it, so it is shared rather than re-derived.
//
// What is CHAT-specific is one line: which grants a person needs.
const grantChatUser = (admin: RadiaClient, principal: string) =>
  assignUserGrants(admin, principal, { owner: principal });

/** Grant the standard session set to every enrolled identity that holds nothing yet. */
export function sweepAutoGrants(
  admin: RadiaClient,
  log: (message: string) => void = console.error,
  decided: Set<string> = new Set(),
): Promise<string[]> {
  return sweepEnrolments(admin, grantChatUser, log, decided);
}

/** Run the sweep now, then again whenever an identity record lands, until `signal` aborts. */
export function watchAutoGrants(
  admin: RadiaClient,
  signal: AbortSignal,
  log: (message: string) => void = console.error,
): Promise<void> {
  return watchEnrolments(admin, signal, grantChatUser, log, (p) => `auto-grant: ${p} may now use the chat`);
}
