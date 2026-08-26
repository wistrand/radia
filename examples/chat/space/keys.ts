// Where the chat's keys come from, and how a session learns the fleet's (plan-encryption.md
// phase 2).
//
// The crypto is in `extensions/ts/encrypted.ts`; this file is POLICY, which is why it is app code:
// which env var, which file, which record, and who is trusted to hold what.
//
//   the FLEET KEY PAIR belongs to whoever runs `--serve`. Inference must decrypt to call a
//     provider, so the fleet holds the PRIVATE half, and that is the accepted gap in the design:
//     this protects against the store, a dump, the console and principals without a key, never
//     against whoever runs the fleet.
//   the FLEET'S PUBLIC HALF is published as an ordinary record, because a joining session has to
//     wrap a new conversation's DEK to a fleet whose secret it must not hold. Out-of-band config
//     would work and is exactly what the space exists to avoid: as a record it is discoverable,
//     latest-wins, and retirable.
//   a PERSON'S KEY belongs to the person, lives beside their credential at 0600, and is generated
//     on first use. Losing it costs them nothing the fleet cannot recover, which is deliberate: a
//     lost laptop must not be a destroyed conversation.
//
// No private key is ever written to the space. What the space holds is the DEK wrapped under each.

import type { RadiaClient, RadiaRecord } from "../../../sdk/ts/client.ts";
import { RadiaClientError, readExhaustively } from "../../../sdk/ts/client.ts";
import { activeByKey, newer } from "../../../sdk/ts/registry.ts";
import {
  type ConversationEncryption,
  type ConversationKey,
  withWrapsFor,
  encryptionOf,
  type FleetKeyPair,
  fleetKeyId,
  type KeyHolder,
  KeyRing,
  newFleetKeyPair,
} from "../../../extensions/ts/encrypted.ts";
import { saveContentKey, storedContentKey } from "../../../src/credentials.ts";

/** The kind the fleet's public half is published under. A registry: latest wins, retirable. */
export const FLEET_KEY_KIND = "fleet_key";

/**
 * A conversation's key material, keyed by `conversationId` because a session cannot fetch the anchor
 * by id: get-by-id is the ops plane, and every public read is a pattern over declared paths.
 *
 * The record POINTS at the wraps; it does not hold them. Body = `{conversationId, owner, v, keys}`,
 * where `keys` is an artifact id. That indirection is the whole of phase 5: a record body has no
 * erasure path (the erasure invariant is what pushes erasable data into artifacts), so wraps stored
 * inline could never be destroyed and a conversation could never be crypto-shredded. Shredding that
 * artifact destroys the only copy of the key, and every body it protected becomes permanently
 * unreadable while the records, their lineage and the event chain survive.
 *
 * Same precedent as an OIDC profile artifact, and the same reason.
 */
export const CONVERSATION_KEY_KIND = "conversation_key";

const KEY_ENV = "RADIA_CHAT_FLEET_KEY";

/** Where a generated fleet key pair is kept: the one runtime directory, beside everything else a
 *  space writes. Not the per-user credential file — this is the FLEET's secret, not a person's. */
export function fleetKeyPath(): string {
  return `${env("RADIA_DIR") ?? ".radia"}/chat-fleet-key.json`;
}

/** `Deno.env.get` that answers "unset" for a variable this process may not read. A worker under a
 *  narrow `--allow-env` must degrade to having no key, never fail to start. */
function env(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/**
 * The fleet's key pair: `RADIA_CHAT_FLEET_KEY` (base64 JSON) wins, else the key file, generated on
 * first use when `create` is set.
 *
 * `create` is what separates the two callers. `--serve` generates; anything else reports absence,
 * because a process that quietly minted its own fleet key would publish a public half the real
 * fleet cannot match and seal conversations nobody can read.
 */
export async function fleetKeyPair(opts: { create?: boolean } = {}): Promise<FleetKeyPair | undefined> {
  // Every read here is permission-guarded, because the callers are workers with deliberately narrow
  // permission sets: a `Deno.env.get` for a variable outside `--allow-env` THROWS, and one of these
  // runs at module scope, so an unguarded read does not degrade to "no key" — it stops the worker
  // before it advertises anything. That is how the exec worker went silent once.
  const fromEnv = env(KEY_ENV);
  if (fromEnv) return JSON.parse(atob(fromEnv)) as FleetKeyPair;
  const path = fleetKeyPath();
  try {
    return JSON.parse(Deno.readTextFileSync(path)) as FleetKeyPair;
  } catch { /* absent or unreadable: fall through */ }
  if (!opts.create) return undefined;
  const pair = await newFleetKeyPair();
  Deno.mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
  Deno.writeTextFileSync(path, JSON.stringify(pair, null, 2) + "\n");
  try {
    Deno.chmodSync(path, 0o600);
  } catch { /* not POSIX; the directory is the protection there */ }
  return pair;
}

/** Publish the fleet's PUBLIC half. Content-keyed on the key itself, so a fleet restarting writes
 *  nothing new and a rotation is a different record rather than a mutation. */
export async function publishFleetKey(admin: RadiaClient, pair: FleetKeyPair): Promise<void> {
  await admin.put(
    { kind: FLEET_KEY_KIND, body: { keyId: pair.keyId, publicKey: pair.publicKey } },
    `fleet-key:${pair.keyId}`,
  );
}

/**
 * The fleet's current public key, as any session reads it.
 *
 * As a registry, never a bounded `query`: this decides whether a conversation can be sealed at all,
 * and a page that missed the newest key would seal to a retired one.
 */
export async function currentFleetKey(
  c: RadiaClient,
): Promise<{ keyId: string; publicKey: string } | undefined> {
  type Body = { keyId: string; publicKey: string; retired?: boolean };
  const view = await c.registry<Body>(FLEET_KEY_KIND);
  if (!view.complete) throw new Error("could not read the fleet key registry completely; refusing to seal");
  // `entries` is already latest-wins minus tombstones. Newest wins among what is left: several live
  // keys means a rotation in flight, and sealing to the newest is what makes the old private half
  // safe to retire once no conversation names it.
  //
  // Chosen with the SHARED COMPARATOR, never by position. This took the LAST entry, and a
  // projection is ordered by when each key was first seen, so during a rotation it sealed to the
  // OLDEST live key: the one whose private half is about to be retired.
  let live: RadiaRecord<Body> | undefined;
  for (const rec of view.entries) if (!live || newer(live, rec)) live = rec;
  return live ? { keyId: live.body.keyId, publicKey: live.body.publicKey } : undefined;
}

/** The kind a person's PUBLIC keys are published under, one per machine. A registry: latest wins
 *  per key id, and a retired entry is a machine that no longer reads. */
export const PERSON_KEY_KIND = "person_key";

/**
 * This machine's key PAIR for this person, generated and stored on first use.
 *
 * A pair rather than a secret, and that is what lets a person use more than one machine. With a
 * symmetric key the sealer had to hold the opener's secret, so a conversation could only ever be
 * read where it was created; with a pair, any session can wrap TO a machine it will never be.
 * The private half never leaves this file.
 */
export function personKeyPair(url: string, principal: string): FleetKeyPair | Promise<FleetKeyPair> {
  const stored = storedContentKey(url, principal);
  if (stored) return JSON.parse(atob(stored)) as FleetKeyPair;
  return newFleetKeyPair().then((pair) => {
    const saved = saveContentKey(url, principal, btoa(JSON.stringify(pair)));
    if (!saved.ok) {
      // Not fatal, and deliberately not silent. The conversation stays readable through the fleet
      // wrap, so the session works; what is lost is that this machine will mint a NEW key next
      // time and lose access to everything sealed for this one.
      console.error(`warning: could not store your conversation key in ${saved.path}: ${saved.error}`);
      console.error(`  This machine will not be able to reopen what it writes now.`);
    }
    return pair;
  });
}

/** Publish this machine's PUBLIC half, so any session of this person can seal to it. Content-keyed,
 *  so a machine that runs daily writes one record ever. */
export async function publishPersonKey(c: RadiaClient, principal: string, pair: FleetKeyPair): Promise<void> {
  await c.put(
    { kind: PERSON_KEY_KIND, body: { principal, keyId: pair.keyId, publicKey: pair.publicKey } },
    `person-key:${principal}:${pair.keyId}`,
  );
}

/**
 * Every machine this person can still read on, newest wins per key id, tombstones dropped.
 *
 * As a registry, never a bounded query: a page that missed a key would seal a conversation the
 * person cannot open on that machine, and they would find out later and elsewhere.
 */
export async function livePersonKeys(
  c: RadiaClient,
  principal: string,
): Promise<{ keyId: string; publicKey: string }[]> {
  type Body = { principal: string; keyId: string; publicKey: string; retired?: boolean };
  const view = await c.registry<Body>(PERSON_KEY_KIND, { principal });
  if (!view.complete) throw new Error(`could not read ${principal}'s key registry completely; refusing to seal`);
  return [...view.entries].map((r) => ({ keyId: r.body.keyId, publicKey: r.body.publicKey }));
}

/** Re-derive a key id from a stored public half, for callers that hold one without its id. */
export const idOf = fleetKeyId;

/**
 * A reader's way to a conversation's DEK: fetch the key record, unwrap under whatever this holder
 * has, cache (plan-encryption.md phase 3). Shared by the session and the fleet, so the two cannot
 * disagree about what "this conversation is encrypted" means.
 *
 * `undefined` means PLAINTEXT — no key record — and that is the only miss it reports as one. A
 * record that exists and will not open raises, because a reader that treated an unopenable
 * conversation as plaintext would hand ciphertext straight to a model.
 *
 * The `owner` check is the package V rule (plan-audit-remediation.md): a worker holds an UNSCOPED
 * `conversation_key` grant and is asked for an id that came out of a body, so it verifies the
 * record it got back belongs to the caller instead of trusting the reference. A session's own read
 * is already scoped by its grant, and passing no owner is how it says so.
 */
export function conversationKeys(
  c: RadiaClient,
  holder: KeyHolder,
  /** When set, a successful open also ENROLS any of this person's published keys that had no wrap
   *  (see `enrolMissingKeys`). Sessions pass it; workers do not — a fleet worker re-wrapping on
   *  every claim would write a record per turn for no one's benefit. */
  enrolFor?: string,
): (conversationId: string, owner?: string) => Promise<ConversationKey | undefined> {
  const ring = new KeyRing(holder);
  const enrolled = new Set<string>();
  return async (conversationId, owner) => {
    // NEWEST, and that is not a detail. Enrolling another machine writes a SUCCESSOR key record, so
    // an unordered read — which returns the oldest — would keep handing back the original wrap set
    // and the newly enrolled machine would never appear. Latest wins, like every registry here.
    const rec = (await c.queryNewest<{ owner?: string; keys?: string }>({ kind: CONVERSATION_KEY_KIND, match: { conversationId } }, 1))[0];
    if (!rec) return undefined;
    const body = rec.body;
    if (owner !== undefined && body.owner !== owner) {
      throw new Error(`conversation ${conversationId} does not belong to ${owner}; refusing to open its key`);
    }
    if (!body.keys) throw new Error(`conversation ${conversationId} has a key record naming no key material`);
    let raw: Uint8Array;
    try {
      raw = await c.getArtifact(body.keys);
    } catch (e) {
      // `erased` is the erasure doing its job, and it must not read like a transient failure: the
      // bytes are gone, so this conversation is unreadable by anyone, forever, and no retry changes
      // that. Matched on the CODE the space returns, never on the prose of the message.
      if (e instanceof RadiaClientError && e.code === "erased") throw new ConversationErasedError(conversationId);
      throw e;
    }
    const encryption = encryptionOf(JSON.parse(new TextDecoder().decode(raw)));
    if (!encryption) throw new Error(`conversation ${conversationId}'s key artifact carries no key material`);
    const dek = await ring.dek(conversationId, encryption);
    if (enrolFor && !enrolled.has(conversationId)) {
      enrolled.add(conversationId);
      await enrolMissingKeys(c, conversationId, enrolFor, encryption, holder);
    }
    return dek;
  };
}

/**
 * Give this person's other machines a wrap on a conversation this one can already open.
 *
 * The second half of the multi-machine fix. Publishing a public key lets every LATER conversation
 * be sealed to it; this is what reaches the earlier ones. Only a holder can do it, because adding a
 * wrap needs the DEK — so access spreads from a machine that has it, never from one that wants it.
 *
 * Best-effort by design: a session that cannot write a key record still WORKS, it just leaves the
 * other machine waiting for the next session that can. Failing the open over it would trade a
 * working conversation for a convenience.
 */
async function enrolMissingKeys(
  c: RadiaClient,
  conversationId: string,
  principal: string,
  encryption: ConversationEncryption,
  holder: KeyHolder,
): Promise<void> {
  try {
    const keys = await livePersonKeys(c, principal);
    const grown = await withWrapsFor(encryption, holder, keys);
    if (grown === encryption) return; // identity means nothing was missing
    await writeConversationKey(c, conversationId, principal, grown);
  } catch { /* the other machine waits for a session that can write */ }
}

/**
 * OPERATOR RECOVERY: give a person's current machines access to conversations none of them can open.
 *
 * For the one case the client-side enrolment cannot reach — every machine that held a wrap is gone,
 * so no session can extend the conversation, and only the fleet can still open it.
 *
 * Deliberately NOT self-service, and that is the whole design. A stolen credential gets an attacker
 * the records, which are ciphertext, but not the content: their machine's key is not among the
 * wraps. That is a real second factor. A recovery anyone could REQUEST would convert credential
 * theft straight into content theft, so this is a verb an operator runs after establishing who is
 * asking, by some means this space knows nothing about.
 *
 * Adding a reader is IRREVERSIBLE — unwrapping cannot be undone without re-keying the whole
 * conversation, which nothing here does — so `apply` is opt-in and the default only reports.
 */
export async function recoverPersonKeys(
  admin: RadiaClient,
  principal: string,
  fleet: FleetKeyPair,
  opts: { apply?: boolean; conversationId?: string } = {},
): Promise<{ scanned: number; extend: { conversationId: string; keyIds: string[] }[]; erased: string[] }> {
  const keys = await livePersonKeys(admin, principal);
  if (keys.length === 0) {
    throw new Error(
      `${principal} has published no machine key, so there is nothing to recover TO. ` +
        `They start a session first; it publishes one.`,
    );
  }
  // NEWEST per conversation: enrolment writes successors, and only the latest names the artifact
  // holding every wrap so far.
  const view = await readExhaustively((page) =>
    admin.queryPage({
      kind: CONVERSATION_KEY_KIND,
      match: { owner: principal, ...(opts.conversationId ? { conversationId: opts.conversationId } : {}) },
    }, page.limit, page).then((r) => r.records)
  );
  const current = activeByKey<{ conversationId?: string; keys?: string }>(view.records, (b) => b.conversationId);
  if (!view.complete) throw new Error(`could not enumerate ${principal}'s conversations; refusing a partial recovery`);

  const holder: KeyHolder = { kind: "fleet", privateKey: fleet.privateKey, keyId: fleet.keyId };
  const extend: { conversationId: string; keyIds: string[] }[] = [];
  const erased: string[] = [];
  for (const rec of current.values()) {
    const body = rec.body;
    if (!body.conversationId || !body.keys) continue;
    let encryption;
    try {
      encryption = encryptionOf(JSON.parse(new TextDecoder().decode(await admin.getArtifact(body.keys))));
    } catch (e) {
      // An erased conversation is reported rather than skipped in silence: "nothing to do" and
      // "its key was destroyed" are answers an operator must be able to tell apart.
      if (e instanceof RadiaClientError && e.code === "erased") {
        erased.push(body.conversationId);
        continue;
      }
      throw e;
    }
    if (!encryption) continue;
    const missing = keys.filter((k) => !encryption.people?.[k.keyId]).map((k) => k.keyId);
    if (missing.length === 0) continue;
    extend.push({ conversationId: body.conversationId, keyIds: missing });
    if (opts.apply) {
      const grown = await withWrapsFor(encryption, holder, keys);
      await writeConversationKey(admin, body.conversationId, principal, grown);
    }
  }
  return { scanned: current.size, extend, erased };
}

/**
 * Erase a conversation: destroy EVERY artifact holding its key.
 *
 * Every one, because enrolling a machine writes a successor rather than editing the original — a
 * record is immutable — so a conversation read on two machines has two artifacts and both hold the
 * same DEK. Shredding only the newest leaves the key alive in the one before it, and the erasure
 * would look done while the conversation stayed readable.
 *
 * Operator work: shredding needs that or the `purge` ops power. Returns what it destroyed, so a
 * caller can report it rather than assume.
 */
export async function eraseConversation(
  admin: RadiaClient,
  conversationId: string,
): Promise<{ shredded: string[] }> {
  // EVERY version, not the newest: each names an artifact that must go.
  const records = await readExhaustively((page) =>
    admin.queryPage<{ keys?: string }>({ kind: CONVERSATION_KEY_KIND, match: { conversationId } }, page.limit, page).then((r) => r.records)
  );
  if (!records.complete) {
    throw new Error(`could not enumerate every key record for ${conversationId}; refusing a partial erasure`);
  }
  const shredded: string[] = [];
  for (const rec of records.records) {
    const id = rec.body.keys;
    if (!id || shredded.includes(id)) continue;
    // Already-shredded is success, not a failure: erasing twice must converge rather than throw.
    await admin.shredArtifact(id, { reason: `erase conversation ${conversationId}` }).catch((e) => {
      if (!(e instanceof RadiaClientError && e.code === "erased")) throw e;
    });
    shredded.push(id);
  }
  return { shredded };
}

/** Raised when a conversation's key artifact has been shredded. Its bodies are ciphertext nobody
 *  can open, which is the intended end state rather than a fault to retry. */
export class ConversationErasedError extends Error {
  constructor(readonly conversationId: string) {
    super(
      `conversation ${conversationId} was ERASED: its key was destroyed, so its content is permanently ` +
        `unreadable. The records, their lineage and the event chain remain.`,
    );
    this.name = "ConversationErasedError";
  }
}

/**
 * Write a conversation's key material: the wraps as a SHREDDABLE artifact, and a record naming it.
 *
 * Both carry `conversationId` and `owner` so a grant pattern binds them, which is what stops the
 * artifact being readable by anyone holding its id.
 */
export async function writeConversationKey(
  c: RadiaClient,
  conversationId: string,
  owner: string,
  encryption: ConversationEncryption,
): Promise<{ record: string; keys: string }> {
  const art = await c.putArtifact(new TextEncoder().encode(JSON.stringify(encryption)), {
    mediaType: "application/json",
    filename: `conversation-key-${conversationId}.json`,
    meta: { conversationId, owner },
    // Keyed by the SET OF READERS, for the same reason the record below is: a key naming only the
    // conversation would replay the first artifact when a machine is enrolled, so the write would
    // report success and change nothing. Sorted, so the key does not depend on map order.
    idempotencyKey: `conversation-key-bytes:${conversationId}:${
      [encryption.fleetKeyId, ...Object.keys(encryption.people).sort()].join(",")
    }`,
  });
  // Keyed by the WRAP SET, not by the conversation. Enrolling another machine writes a successor
  // (latest wins), and a key naming only the conversation would dedupe that successor away — the
  // second machine would publish its key, be told the write succeeded, and still not be able to
  // read. Re-running with an unchanged set is still a no-op, which is what the key is for.
  const rec = await c.put(
    { kind: CONVERSATION_KEY_KIND, body: { conversationId, owner, v: encryption.v, keys: art.id } },
    `conversation-key:${conversationId}:${art.digest}`,
  );
  return { record: rec.id, keys: art.id };
}
