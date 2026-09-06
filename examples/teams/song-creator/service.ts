// How a service of this team stops, which is the half a `while` loop forgets.
//
// A service holds a DEFINITION token and mints a short-lived RUN from it. Exiting does not stop that
// run, and an `interest` is live for as long as its run is, so a service that has been gone for
// minutes still shows as listening. Measured: restarting the team 50 seconds after a clean shutdown
// warned that another `team up` might still be running, on the evidence of two dead processes. A
// warning that cries wolf is worse than none, because it is ignored on the day it is right.
//
// Retiring the run also keeps `radia runs` honest: a stopped worker whose token still resolves is
// the shape of the credential bug the invariants warn about, and leaving one behind per start is how
// a space accumulates them.

import type { RadiaClient } from "../../../sdk/ts/client.ts";

/**
 * Stop this process's own run, best effort.
 *
 * BEST EFFORT ON PURPOSE: the work is already done by the time this is called, and a service that
 * refused to exit because it could not tidy up would be a worse failure than the untidiness. The
 * space is reachable in the ordinary case and not reachable in exactly the case where it does not
 * matter (the space is gone, so the run is unreachable anyway).
 */
export async function retireRun(client: RadiaClient, who: string): Promise<void> {
  try {
    const { principal } = await client.health();
    // Only a RUN can be stopped, and only this one: `principal` is whatever this client authenticated
    // as, so there is no id here that could belong to somebody else.
    if (!principal?.startsWith("run:")) return;
    await client.stopRun(principal);
    console.error(`${who}: stopped its run ${principal.slice(-8)}, so its interests stop showing as live`);
  } catch (e) {
    console.error(`${who}: could not stop its own run: ${(e as Error).message}`);
  }
}
