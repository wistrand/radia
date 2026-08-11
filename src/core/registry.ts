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
  newestByKey,
  oidcIdentityKey,
  opsGrantKey,
  readRegistry,
  RETIRED,
  type RegistryView,
} from "../../sdk/ts/registry.ts";
