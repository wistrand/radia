// The operator credential an example uses to bootstrap its own space.
//
// Every example here is the OPERATOR of the space it runs against: it registers kinds, mints run
// tokens for its workers, and assigns grants, all of which is privileged. It used to do that on a
// request carrying no credential at all, which the space answered as `human:local` under the
// open-mode shortcut. That worked, and it meant the examples never exercised the authenticated path
// they are supposed to demonstrate: local development using the same API shape as production.
//
// `radia dev` writes a real operator token to the per-user credential file before it starts
// listening, so an example that has just seen `/v0/health` answer can always read one.

import { resolveToken } from "../src/credentials.ts";

/**
 * The operator token for `url`: `RADIA_TOKEN`, else the credential `radia dev` provisioned.
 *
 * Throws rather than returning undefined. An example that silently continued without one would
 * fail later with a 401 from whichever verb happened to be first, which says nothing about the
 * cause.
 */
export function operatorToken(url: string): string {
  const token = (globalThis.Deno?.env.get("RADIA_TOKEN")) ?? resolveToken(url);
  if (!token) {
    throw new Error(
      `no operator credential for ${url}. Start a space with \`radia dev\` (it provisions one), ` +
        `or set RADIA_TOKEN. Note that the credential is keyed by HOST: a space started on ` +
        `127.0.0.1 has no credential under localhost, even though both reach it.`,
    );
  }
  return token;
}
