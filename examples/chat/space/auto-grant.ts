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
// WHAT THE BAN IS, once this is on. Revoking a person's grants does NOT keep them out: the next
// sweep sees a principal holding none and grants again. The ban is RETIRING THEIR MAPPING, which is
// the mechanism plan-oidc.md designed for exactly this ("retire is a ban") and which `activeByKey`
// drops from the view below without any check of ours. Say this out loud to anyone running with
// the flag, because "I revoked them and they came back" is otherwise a mystery.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { oidcIdentityKey, readRegistry } from "../../../sdk/ts/registry.ts";
import { assignUserGrants } from "./roles.ts";

interface OidcMapping {
  principal?: string;
  iss?: string;
  sub?: string;
}

/**
 * Grant the standard session set to every enrolled identity that holds nothing yet.
 *
 * Returns the principals newly granted, so a caller can report them. Safe to run repeatedly: it is
 * the "holds nothing" test that makes it so, and that test is load-bearing rather than an
 * optimisation. `RadiaClient.grant` is content-keyed AND revives a retired grant, so a blind
 * re-assign would undo an operator's deliberate narrowing — someone who cut a person back to two
 * kinds would find the full set restored on the next enrolment wakeup.
 */
export async function sweepAutoGrants(
  admin: RadiaClient,
  log: (message: string) => void = console.error,
): Promise<string[]> {
  // PAGED TO EXHAUSTION rather than a bounded read: a person who fell off the page would silently
  // never be granted. `activeByKey` (inside `readRegistry`) drops retired mappings, so a ban needs
  // no test here — it is absent from the view.
  const view = await readRegistry<OidcMapping>(
    (limit, after) => admin.query({ kind: "oidc_identity" }, limit, { dir: "desc", after }),
    oidcIdentityKey,
  );
  if (!view.complete) {
    log(`auto-grant: the identity registry could not be read to the end (${view.scanned} scanned); some people may not be granted yet`);
  }

  const granted: string[] = [];
  for (const rec of view.entries.values()) {
    const principal = (rec.body as OidcMapping).principal;
    if (typeof principal !== "string" || !principal.startsWith("human:")) continue;
    try {
      const perms = await admin.permissions(principal) as { privileged: boolean; kinds: unknown[] };
      // An operator needs nothing from us, and a principal that already holds something has been
      // decided about — by an earlier sweep or by a person. Either way, leave it alone.
      if (perms.privileged || perms.kinds.length > 0) continue;
      await assignUserGrants(admin, principal, { owner: principal });
      granted.push(principal);
    } catch (e) {
      // One unreadable identity must not stop the rest: the others are still waiting to be let in.
      log(`auto-grant: could not grant ${principal}: ${e}`);
    }
  }
  return granted;
}

/**
 * Run the sweep now, then again whenever an identity record lands, until `signal` aborts.
 *
 * Watching rather than polling, and re-sweeping wholesale rather than reading the event's record:
  * a sweep is idempotent and cheap next to being wrong about which enrolment woke us. Display-claim
 * refreshes write successors too, and they simply find nothing to do.
 */
export async function watchAutoGrants(
  admin: RadiaClient,
  signal: AbortSignal,
  log: (message: string) => void = console.error,
): Promise<void> {
  const announce = (granted: string[]) => {
    for (const p of granted) log(`auto-grant: ${p} may now use the chat`);
  };
  announce(await sweepAutoGrants(admin, log));
  try {
    for await (const _ of admin.watch({ kind: "oidc_identity" }, signal)) {
      announce(await sweepAutoGrants(admin, log));
    }
  } catch {
    // Aborted on shutdown, or the stream ended. Either way there is nothing left to grant for.
  }
}
