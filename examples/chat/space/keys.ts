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
//     would work and is exactly what the substrate exists to avoid: as a record it is discoverable,
//     latest-wins, and retirable.
//   a PERSON'S KEY belongs to the person, lives beside their credential at 0600, and is generated
//     on first use. Losing it costs them nothing the fleet cannot recover, which is deliberate: a
//     lost laptop must not be a destroyed conversation.
//
// No private key is ever written to the space. What the space holds is the DEK wrapped under each.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { readRegistry } from "../../../sdk/ts/client.ts";
import {
  type ConversationKey,
  encryptionOf,
  type FleetKeyPair,
  fleetKeyId,
  keyFromBase64,
  type KeyHolder,
  KeyRing,
  keyToBase64,
  newFleetKeyPair,
  newKeyBytes,
} from "../../../extensions/ts/encrypted.ts";
import { saveContentKey, storedContentKey } from "../../../src/credentials.ts";

/** The kind the fleet's public half is published under. A registry: latest wins, retirable. */
export const FLEET_KEY_KIND = "fleet_key";

/** A conversation's wrapped DEKs, keyed by `conversationId` because a session cannot fetch the
 *  anchor by id: get-by-id is the ops plane, and every public read is a pattern over declared
 *  paths. Body = `{conversationId, owner, ...ConversationEncryption}`. */
export const CONVERSATION_KEY_KIND = "conversation_key";

const KEY_ENV = "RADIA_CHAT_FLEET_KEY";

/** Where a generated fleet key pair is kept: the one runtime directory, beside everything else a
 *  space writes. Not the per-user credential file — this is the FLEET's secret, not a person's. */
export function fleetKeyPath(): string {
  return `${Deno.env.get("RADIA_DIR") ?? ".radia"}/chat-fleet-key.json`;
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
  const fromEnv = Deno.env.get(KEY_ENV);
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
 * Through `readRegistry`, never a bounded `query`: this decides whether a conversation can be
 * sealed at all, and a page that missed the newest key would seal to a retired one.
 */
export async function currentFleetKey(
  c: RadiaClient,
): Promise<{ keyId: string; publicKey: string } | undefined> {
  type Body = { keyId: string; publicKey: string; retired?: boolean };
  const view = await readRegistry<Body>(
    (limit, after) => c.query({ kind: FLEET_KEY_KIND }, limit, { after }),
    (b) => b.keyId,
  );
  if (!view.complete) throw new Error("could not read the fleet key registry completely; refusing to seal");
  // `entries` is already latest-wins minus tombstones. Newest wins among what is left: several live
  // keys means a rotation in flight, and sealing to the newest is what makes the old private half
  // safe to retire once no conversation names it.
  const live = [...view.entries.values()].at(-1);
  return live ? { keyId: (live.body as Body).keyId, publicKey: (live.body as Body).publicKey } : undefined;
}

/** This person's own key for this space, generated and stored on first use. */
export function personKey(url: string, principal: string): Uint8Array {
  const stored = storedContentKey(url, principal);
  if (stored) return keyFromBase64(stored, "the stored content key");
  const key = newKeyBytes();
  const saved = saveContentKey(url, principal, keyToBase64(key));
  if (!saved.ok) {
    // Not fatal, and deliberately not silent. The conversation is still readable through the fleet
    // wrap, so the session works; what is lost is the property that made the second wrap worth
    // having, and only saying so at the moment it happens makes that visible.
    console.error(`warning: could not store your conversation key in ${saved.path}: ${saved.error}`);
    console.error(`  This session's conversations will be readable by the fleet but not by a later session of yours.`);
  }
  return key;
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
): (conversationId: string, owner?: string) => Promise<ConversationKey | undefined> {
  const ring = new KeyRing(holder);
  return async (conversationId, owner) => {
    const rec = await c.readOne({ kind: CONVERSATION_KEY_KIND, match: { conversationId } });
    if (!rec) return undefined;
    const body = rec.body as { owner?: string };
    if (owner !== undefined && body.owner !== owner) {
      throw new Error(`conversation ${conversationId} does not belong to ${owner}; refusing to open its key`);
    }
    const encryption = encryptionOf(rec.body);
    if (!encryption) throw new Error(`conversation ${conversationId} has a key record carrying no key material`);
    return await ring.dek(conversationId, encryption);
  };
}
