import type { RadiaRecord } from "../storage/adapter.ts";
// The registry projection, re-exported from the wire vocabulary.
//
// The IMPLEMENTATION lives in `sdk/ts/registry.ts` because a client needs it as much as the runtime
// does: "latest wins, minus retirements" is how every consumer reads a registry of records, and two
// implementations of that rule is one too many (it was six, once, before it was shared). Keeping the
// import path here means nothing inside `src/` had to move when the definition did.
export {
  activeByKey,
  activeSet,
  grantKey,
  isRetired,
  newer,
  newestByKey,
  oidcIdentityKey,
  opsGrantKey,
  readCompletely,
  RETIRED,
} from "../../sdk/ts/registry.ts";

/** What `Space.registry` hands its callers: the projection plus how far the walk got. Defined here
 *  rather than in the SDK because the runtime is its only consumer; a client projects with
 *  `activeByKey` / `newestByKey` over a `Population` and needs no view type. */
export interface RegistryView {
  /** Current entry per key, retired ones dropped. */
  entries: Map<string, RadiaRecord>;
  /** Newest record per key INCLUDING retirements. A writer that re-declares a key needs this:
   *  reviving a retired entry requires a key that differs from the record being revived, so it
   *  has to be able to see that the newest record is a retirement, and which record that is. */
  newest: Map<string, RadiaRecord>;
  /** False when the scan hit its cap before exhausting the kind. The view may be missing entries,
   *  and a caller that treats it as authoritative would be guessing. */
  complete: boolean;
  scanned: number;
}
