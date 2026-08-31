// The clear marker on a body whose prose is ciphertext, and the refusal every reader owes it.
//
// An app-level convention (agent_docs/plan-encryption.md): the runtime never inspects prose, so
// `message.content` and friends can be ciphertext without matching, watches, lineage or the event
// chain noticing. What the runtime also cannot do is stop ciphertext from being READ as text, and
// that is the worst outcome in the whole plan — an answer confidently about nothing, with nothing
// in the transcript saying why. So the marker ships, and the refusal ships, before any field is
// encrypted.
//
// Always: a reader that sees a marker it cannot handle RAISES. Never: pass the field through, and
// never substitute a placeholder into anything a model or a person will read — a placeholder is
// how ciphertext becomes a plausible-looking answer instead of an error.

/** The body field carrying the marker. Reserved by this convention; no app may use it otherwise. */
export const ENC_FIELD = "enc";

/** The marker a phase-3 writer stamps. Defined here so writer and reader cannot disagree. */
export const ENC_V1 = "v1";

/**
 * Markers this build can read WITHOUT decrypting.
 *
 * EMPTY, and it stays empty. Phase 1 said phase 3 would add `ENC_V1` here once readers had keys;
 * building phase 3 showed that would be the wrong move, because it turns the refusal off for every
 * reader at once — including one that forgot to decrypt, which would then pass ciphertext along in
 * exactly the silence this file exists to prevent.
 *
 * What clears the marker is DECRYPTING: `openBody` strips `enc` from the copy it returns, so the
 * refusals downstream stop firing precisely where a key was actually applied, and nowhere else.
 */
const READABLE: ReadonlySet<string> = new Set<string>();

/** Raised instead of handing ciphertext to a model, a provider or a terminal. */
export class EncryptedBodyError extends Error {
  readonly marker: string;
  readonly where: string;
  constructor(marker: string, where: string) {
    super(
      `${where}: this body is encrypted (${ENC_FIELD}=${marker}) and this build has no key for it. ` +
        `Refusing rather than reading ciphertext as text.`,
    );
    this.name = "EncryptedBodyError";
    this.marker = marker;
    this.where = where;
  }
}

/** The body's marker, or undefined for an ordinary plaintext body. */
export function encMarker(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const v = (body as Record<string, unknown>)[ENC_FIELD];
  return v === undefined || v === null ? undefined : String(v);
}

/**
 * Refuse a body this reader cannot decrypt. `where` names the READER, because the useful half of
 * the report is which component stopped, not that some body was encrypted.
 *
 * A PRIMITIVE is a misuse, not a plaintext body, and it is the misuse this guard exists to make
 * loud: `encMarker` reads `enc` off an object and answers `undefined` for anything else, so
 * `assertReadable(body.content, …)` — reaching for the field you care about rather than the whole
 * body — passed silently and left the ciphertext check disabled at exactly the call that meant to
 * do it. `undefined`/`null` still pass, because a missing body is legitimate; a string, number or
 * boolean never is, so it throws a programming error rather than an `EncryptedBodyError`.
 */
export function assertReadable(body: unknown, where: string): void {
  if (body !== undefined && body !== null && typeof body !== "object") {
    throw new TypeError(
      `${where}: assertReadable was given a ${typeof body}, not a record body. ` +
        `Pass the whole body; a field off it (\`body.content\`) skips the encryption check silently.`,
    );
  }
  const marker = encMarker(body);
  if (marker !== undefined && !READABLE.has(marker)) throw new EncryptedBodyError(marker, where);
}

/** The same check over a batch, so a reader asserts once rather than per row inside its own loop. */
export function assertAllReadable(bodies: Iterable<unknown>, where: string): void {
  for (const b of bodies) assertReadable(b, where);
}

// ---- keys: one DEK per conversation, WRAPPED TWICE ----
//
// Envelope encryption, the shape `src/storage/crypto.ts` already uses for blobs, lifted to bodies
// rather than imported: an extension never imports `src/`, and the two are the same idea over
// different material. Per-conversation DEK, AES-GCM-256.
//
// TWICE, and the second wrap is what a shared fleet forces (plan-scaling.md item 3):
//
//   - to the FLEET, because inference must decrypt to call a provider;
//   - under a PER-PERSON key, so a joining session can read its own conversation.
//
// Fleet-only would mean every joining session needs the fleet's key to render its own messages, so
// every person would hold the key to every conversation. Their grants still stop them FETCHING
// anyone else's records, so it is not an immediate breach — it dissolves the safe-against-a-dump
// property for anyone who has ever run a session.
//
// THE FLEET HALF IS ASYMMETRIC, and that is forced rather than chosen. In join mode the SESSION
// creates the conversation (there is no operator in that process), so whoever creates it must be
// able to wrap the DEK for a fleet whose secret they must not hold. A symmetric KEK cannot do that:
// wrapping to it IS holding it. So the fleet publishes an RSA-OAEP PUBLIC key as an ordinary record
// and keeps the private half; a session wraps to it and can never unwrap. The person half stays
// symmetric, because there the wrapper and the reader are the same party.
//
// The wrapped DEKs live in their own record, addressed by `conversationId` — NOT on the
// conversation anchor, which the plan proposed and which cannot work: an anchor's only identifier
// is its record id, and a session cannot fetch by id (get-by-id is the ops plane, and every public
// read is a pattern over declared paths). Key material only an operator can reach is no key.
//
// That record NEVER carries `enc`. The two fields say different things: `enc` on a body means "my
// prose is ciphertext" and every reader refuses it, while key material is plaintext by definition.
// Overloading the marker would make a reader raise on the one record it needs to proceed.

/** Key material as it is stored, flattened onto the key record beside `conversationId`/`owner`.
 *  Wrapped DEKs only; no plaintext key ever reaches the space. */
export interface ConversationEncryption {
  /** Marker version, matching what writers stamp on the bodies this key protects. */
  v: string;
  /** The DEK wrapped to the fleet's public key, RSA-OAEP (base64). */
  fleet: string;
  /** Which fleet key that wrap targets, so a rotated fleet reports a MISS rather than a decrypt
   *  failure — the two want different fixes and look identical without this. */
  fleetKeyId: string;
  /**
   * The DEK wrapped to each person KEY (base64), by key id.
   *
   * By KEY, not by principal: a person uses more than one machine, each holds its own private half,
   * and one entry per principal would mean one machine per person. Which keys belong to whom is the
   * `person_key` registry's business, not this record's — a reader looks up its OWN id.
   */
  people: Record<string, string>;
}

/**
 * A conversation's DEK as a reader holds it: two handles over one key.
 *
 * `content` seals and opens bodies. `nonce` derives each write's nonce (below). Two handles because
 * Web Crypto binds a key to one algorithm, and unwrapping twice keeps the DEK NON-EXTRACTABLE —
 * deriving the nonce from exported raw bytes would have meant the key material sitting in a JS
 * variable for the life of every worker.
 */
export interface ConversationKey {
  content: CryptoKey;
  nonce: CryptoKey;
}

/** Which key a holder is offering. A person also names themselves, because their wrap is one entry
 *  in a map and asking for someone else's is a bug worth naming rather than a decrypt failure. */
export type KeyHolder =
  | { kind: "fleet"; privateKey: string; keyId?: string }
  | { kind: "person"; principal: string; keyId: string; privateKey: string };

/** Raised when a holder has no wrap on this conversation, or holds the wrong key for the one it has. */
export class NoConversationKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoConversationKeyError";
  }
}

/** Deno's lib types declare `BufferSource` as `ArrayBufferView<ArrayBuffer>`, which a plain
 *  `Uint8Array` does not satisfy. Runtime-identical; the cast keeps every crypto call readable. */
const buf = (b: Uint8Array): BufferSource => b as unknown as BufferSource;

const b64 = {
  encode(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(s);
  },
  decode(text: string): Uint8Array {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  },
};

const RSA: RsaHashedImportParams = { name: "RSA-OAEP", hash: "SHA-256" };

/**
 * A key pair, in the forms that get stored: SPKI for the public half (published as a record, so
 * anyone can wrap TO it) and PKCS#8 for the private half (kept by whoever it belongs to).
 *
 * The fleet has one, and so does each of a person's machines. Same shape and same reason: the party
 * that SEALS is not the party that opens, so a symmetric key would mean the sealer holds the
 * opener's secret. For a person that is what tied their conversations to one machine.
 */
export interface FleetKeyPair {
  publicKey: string; // base64 SPKI
  privateKey: string; // base64 PKCS#8
  keyId: string;
}

/** A fleet key pair. 3072-bit RSA-OAEP: generated once per fleet, so keygen cost is paid at setup
 *  and every later operation is a single wrap or unwrap of 32 bytes. */
export async function newFleetKeyPair(): Promise<FleetKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["wrapKey", "unwrapKey"],
  ) as CryptoKeyPair;
  const publicKey = b64.encode(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  return {
    publicKey,
    privateKey: b64.encode(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
    keyId: await fleetKeyId(publicKey),
  };
}

/** A fleet key's identity: the digest of its PUBLIC half, so both sides compute it from what they
 *  hold and a rotation is visible without anyone publishing a version number. */
export async function fleetKeyId(publicKey: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf(b64.decode(publicKey))));
  return [...d.subarray(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Mint a conversation's DEK, wrap it to the fleet's public key and under each person's own key.
 *
 * `people` is a map rather than one principal because the shape has to survive a second reader
 * being added later; today a conversation is created with exactly its owner in it. Adding one
 * afterwards needs that person's key, which is why a SECOND participant would want the asymmetric
 * treatment the fleet half already has.
 */
export async function sealConversation(
  fleet: { publicKey: string; keyId?: string },
  people: readonly { keyId: string; publicKey: string }[],
  version = ENC_V1,
): Promise<{ encryption: ConversationEncryption; key: ConversationKey }> {
  // Extractable, because wrapping requires it. This is the one process that could export the key
  // anyway: it just generated it.
  const dek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const pub = await crypto.subtle.importKey("spki", buf(b64.decode(fleet.publicKey)), RSA, false, ["wrapKey"]);
  const wrapped: Record<string, string> = { ...(await wrapForPeople(dek, people)) };
  return {
    encryption: {
      v: version,
      fleet: b64.encode(new Uint8Array(await crypto.subtle.wrapKey("raw", dek, pub, RSA))),
      fleetKeyId: fleet.keyId ?? await fleetKeyId(fleet.publicKey),
      people: wrapped,
    },
    key: {
      content: dek,
      nonce: await crypto.subtle.importKey(
        "raw",
        await crypto.subtle.exportKey("raw", dek),
        "HKDF",
        false,
        ["deriveBits"],
      ),
    },
  };
}

/**
 * Unwrap a conversation's DEK with whichever key the caller holds.
 *
 * Throws `NoConversationKeyError` for "there is no wrap for you" and for "your key does not open
 * the wrap there is" alike. Between those two the distinction is deliberately not reported: it is
 * a missing entry versus a wrong key, and a caller can act on neither. A fleet key ROTATION is the
 * exception and is named, because it is the one case with an operator fix.
 */
export async function openConversation(
  encryption: ConversationEncryption,
  holder: KeyHolder,
): Promise<ConversationKey> {
  if (holder.kind === "person") {
    const wrapped = encryption.people?.[holder.keyId];
    if (!wrapped) {
      // By KEY, so this is "this machine was not among the readers when it was sealed" rather than
      // "not for you". A session that can open the conversation elsewhere can add a wrap for it.
      throw new NoConversationKeyError(
        `this conversation carries no key wrapped for ${holder.principal}'s key ${holder.keyId}`,
      );
    }
    try {
      const priv = await crypto.subtle.importKey("pkcs8", buf(b64.decode(holder.privateKey)), RSA, false, ["unwrapKey"]);
      return await bothHandles((alg, usages) =>
        crypto.subtle.unwrapKey("raw", buf(b64.decode(wrapped)), priv, RSA, alg, false, usages)
      );
    } catch {
      throw new NoConversationKeyError(`the key held for ${holder.principal} does not open this conversation`);
    }
  }
  if (!encryption.fleet) throw new NoConversationKeyError("this conversation carries no key wrapped for the fleet");
  if (holder.keyId && encryption.fleetKeyId && holder.keyId !== encryption.fleetKeyId) {
    throw new NoConversationKeyError(
      `this conversation was sealed to fleet key ${encryption.fleetKeyId}, and the fleet now holds ${holder.keyId}. ` +
        `The old private key still opens it; a rotation that discards it discards these conversations.`,
    );
  }
  try {
    const priv = await crypto.subtle.importKey("pkcs8", buf(b64.decode(holder.privateKey)), RSA, false, ["unwrapKey"]);
    return await bothHandles((alg, usages) =>
      crypto.subtle.unwrapKey("raw", buf(b64.decode(encryption.fleet)), priv, RSA, alg, false, usages)
    );
  } catch {
    throw new NoConversationKeyError("the fleet's key does not open this conversation");
  }
}

/** Wrap a DEK to each of a person's published public keys, by key id. */
async function wrapForPeople(
  dek: CryptoKey,
  people: readonly { keyId: string; publicKey: string }[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of people) {
    const pub = await crypto.subtle.importKey("spki", buf(b64.decode(p.publicKey)), RSA, false, ["wrapKey"]);
    out[p.keyId] = b64.encode(new Uint8Array(await crypto.subtle.wrapKey("raw", dek, pub, RSA)));
  }
  return out;
}

/**
 * The same key material, with wraps added for keys that had none.
 *
 * This is how a person's SECOND machine reaches a conversation sealed before it existed: whoever
 * can already open the thread re-wraps the DEK to the newly published key. It needs the DEK, so
 * only a holder can do it — the wraps cannot be added by someone who cannot read the conversation.
 *
 * Returns the input unchanged when nothing is missing, so a caller can use identity to decide
 * whether a write is needed at all.
 */
export async function withWrapsFor(
  encryption: ConversationEncryption,
  holder: KeyHolder,
  people: readonly { keyId: string; publicKey: string }[],
): Promise<ConversationEncryption> {
  const missing = people.filter((p) => !encryption.people?.[p.keyId]);
  if (missing.length === 0) return encryption;
  // A dedicated EXTRACTABLE unwrap, done here and nowhere else. The handles `openConversation`
  // hands out are deliberately not extractable, and wrapping a key requires that it is — so rather
  // than weaken every reader for the sake of this one path, it re-opens the DEK from the holder's
  // own wrap. Same authority as reading: only someone who can already open the conversation can
  // extend it to another key.
  const dek = await unwrapExtractable(encryption, holder);
  return { ...encryption, people: { ...encryption.people, ...(await wrapForPeople(dek, missing)) } };
}

async function unwrapExtractable(encryption: ConversationEncryption, holder: KeyHolder): Promise<CryptoKey> {
  const wrapped = holder.kind === "fleet" ? encryption.fleet : encryption.people?.[holder.keyId];
  if (!wrapped) throw new NoConversationKeyError("this conversation carries no key this holder can open");
  const priv = await crypto.subtle.importKey("pkcs8", buf(b64.decode(holder.privateKey)), RSA, false, ["unwrapKey"]);
  return await crypto.subtle.unwrapKey(
    "raw",
    buf(b64.decode(wrapped)),
    priv,
    RSA,
    { name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"],
  );
}

/** Unwrap the same DEK twice, once per algorithm. Web Crypto binds a key to one algorithm, and this
 *  is what lets the nonce be derived from the DEK without the DEK ever becoming extractable. */
async function bothHandles(
  unwrap: (alg: AlgorithmIdentifier, usages: KeyUsage[]) => Promise<CryptoKey>,
): Promise<ConversationKey> {
  return {
    content: await unwrap({ name: "AES-GCM" }, ["encrypt", "decrypt"]),
    nonce: await unwrap("HKDF", ["deriveBits"]),
  };
}

/**
 * Read key material off a key record's body, or undefined if it carries none.
 *
 * Checks the fields it will USE rather than trusting the kind: a body reaching here is whatever a
 * writer put on the space, and a half-written one must read as "no key" instead of failing later
 * inside a decrypt with nothing naming the cause.
 */
export function encryptionOf(body: unknown): ConversationEncryption | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Partial<ConversationEncryption>;
  if (typeof b.v !== "string" || typeof b.fleet !== "string") return undefined;
  return { v: b.v, fleet: b.fleet, fleetKeyId: b.fleetKeyId ?? "", people: b.people ?? {} };
}

// ---- sealing a body's prose ----
//
// Which fields, per kind, in ONE place: a writer and a reader that disagree about the list produce
// a thread that renders half as ciphertext, and the disagreement is invisible until someone reads
// it. Routing and scope fields are never in here and never can be — `bodyMatchesGrant` matches
// grant patterns against the BODY on write, so encrypting `owner` or `conversationId` would break
// authorization rather than hide anything.

/**
 * Which fields a kind seals, split by how the value survives the round trip.
 *
 * `text` is a string and is sealed as itself. `json` is anything else — an object, or a field whose
 * type varies by call — and is sealed as its JSON, so opening restores the value rather than a
 * string that looks like one. The split is static per field because every field here has one shape,
 * and a tag inside the ciphertext would have changed the format strings already use.
 */
export interface SealedFields {
  text?: readonly string[];
  json?: readonly string[];
}

export const ENCRYPTED_FIELDS: Readonly<Record<string, SealedFields>> = {
  // `tool_calls` is sealed one level down, at `function.arguments`: the turn worker routes on `id`
  // and `function.name` and must keep reading them (see `sealToolCalls`).
  message: { text: ["content"] },
  // The stream, not only the answer. Encrypting the final message while the same text goes past in
  // clear as chunks is a feature that looks like it works: chunks are retained for a day, so the
  // whole conversation would sit on the space in the clear.
  llm_chunk: { text: ["delta"] },
  // A tool ACTS on its arguments. What arrives here is already sealed: the inference worker sealed
  // `function.arguments` when it wrote the assistant message, and the turn worker copied the blob
  // without reading it, so this opens to the model's RAW argument string rather than to an object.
  tool_call: { text: ["args"] },
  // `output` is whatever a tool returned — a string, an object, a number — so it round-trips as JSON.
  tool_result: { json: ["output"] },
  // A code runner's verdict. `stdout` is the program's output and `expected` holds the text it was
  // compared against, which is the same content by another name. `verdict` stays clear: it is an
  // indexed routing field, and it is the half an operator needs without reading anyone's data.
  check: { text: ["stdout"], json: ["expected"] },
};

const NONCE_BYTES = 12;
const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Where a sealed value lives: `content` -> `contentSealed`, so a reader that never imported this
 * convention finds `body.content` ABSENT rather than a base64 string it forwards as prose. That
 * reaches a THIRD PARTY the `assertReadable` wall cannot, because a check in a module binds only
 * code that imports the module, while the record's SHAPE reaches anyone who reads the space
 * ([plan-sealed-field-shape.md](../../agent_docs/plan-sealed-field-shape.md)). Derived from the
 * field name, so `ENCRYPTED_FIELDS` stays the one declaration and no second table maps the two.
 */
const sealedName = (field: string): string => `${field}Sealed`;

/**
 * The ciphertext for one sealed field, from the new name or the old one, or undefined.
 *
 * The fallback is PERMANENT, not a migration window: records are immutable, so a conversation
 * sealed before this rename must still open. A record carrying BOTH is refused rather than guessed
 * at, since two ciphertexts for one field means it was written two ways.
 */
function sealedValue(body: Record<string, unknown>, field: string): string | undefined {
  const fresh = body[sealedName(field)];
  const legacy = body[field];
  const hasFresh = typeof fresh === "string";
  const hasLegacy = typeof legacy === "string";
  if (hasFresh && hasLegacy) {
    throw new Error(`sealed body carries both ${field} and ${sealedName(field)}; it was written two ways`);
  }
  return hasFresh ? (fresh as string) : hasLegacy ? (legacy as string) : undefined;
}

/**
 * The nonce for one write.
 *
 * A KEYED write derives it: HKDF over the DEK with the idempotency key as info. Deterministic, so a
 * re-put under the same key produces BYTE-IDENTICAL ciphertext and replays. `Space.idem` hashes
 * `{kind, body, parentIds}` into `requestHash` to detect a different request under the same key, so
 * a random nonce would make every retry an `idempotency_conflict` — a runtime error for something
 * the runtime got right.
 *
 * An UNKEYED write takes a random one. There is no replay to be identical to, and randomness is the
 * stronger default.
 *
 * Fully deterministic encryption (nonce from the plaintext) is the other trap and is not used: it
 * leaks equality between identical messages.
 */
async function nonceFor(key: ConversationKey, idempotencyKey?: string): Promise<Uint8Array> {
  if (idempotencyKey === undefined) return crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("radia/chat/nonce"), info: enc.encode(idempotencyKey) },
    key.nonce,
    NONCE_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Seal one string. The nonce travels with the ciphertext, so a reader needs the DEK and nothing
 *  else — deriving it again would mean every reader knowing the idempotency key it was written under. */
export async function encryptText(key: ConversationKey, plaintext: string, idempotencyKey?: string): Promise<string> {
  const nonce = await nonceFor(key, idempotencyKey);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce) }, key.content, buf(enc.encode(plaintext))),
  );
  const packed = new Uint8Array(nonce.length + ct.length);
  packed.set(nonce, 0);
  packed.set(ct, nonce.length);
  return b64.encode(packed);
}

/** Open one sealed string. Throws on a wrong key or tampered bytes; AES-GCM authenticates. */
export async function decryptText(key: ConversationKey, packed: string): Promise<string> {
  const raw = b64.decode(packed);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf(raw.subarray(0, NONCE_BYTES)) },
    key.content,
    buf(raw.subarray(NONCE_BYTES)),
  );
  return dec.decode(pt);
}

/**
 * A copy of `body` with this kind's prose sealed and the marker stamped.
 *
 * A `null`/absent field stays as it is: an assistant message with no content carries none, and
 * encrypting the absence would invent a value the reader then has to un-invent.
 *
 * The return is `Record<string, unknown>`, NOT the input `T`: the sealed body is a different shape
 * (`content` gone, `contentSealed` added), so typing it as `T` would let a caller read
 * `sealed.content` and get `undefined` with no complaint. That is the runtime footgun the rename
 * closes; the type refuses to promise a field the seal removed. Callers write this body, they do
 * not field-access it, so the opaque type costs them nothing.
 */
export async function sealBody(
  body: Record<string, unknown>,
  kind: string,
  key: ConversationKey,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const fields = ENCRYPTED_FIELDS[kind];
  if (!fields) return body;
  const out: Record<string, unknown> = { ...body, [ENC_FIELD]: ENC_V1 };
  // Each sealed field MOVES to its `<name>Sealed` twin: the plaintext name is deleted, so a raw
  // reader of `body.content` gets `undefined` rather than ciphertext. The marker still says "sealed"
  // for readers that DO import the convention; the rename is what serves those that do not.
  for (const f of fields.text ?? []) {
    if (typeof body[f] === "string") {
      out[sealedName(f)] = await encryptText(key, body[f] as string, idempotencyKey);
      delete out[f];
    }
  }
  for (const f of fields.json ?? []) {
    if (body[f] !== undefined && body[f] !== null) {
      out[sealedName(f)] = await encryptText(key, JSON.stringify(body[f]), idempotencyKey);
      delete out[f];
    }
  }
  // The one NESTED case, and it is nested because the turn worker must keep routing on what
  // surrounds it: a tool call's `id` and `function.name` say which worker answers where, while
  // `arguments` is the model's prose. Sealed here, at the only writer that holds a key, so the turn
  // worker can copy the blob into a `tool_call` without ever being able to read it.
  if (kind === "message" && Array.isArray(body.tool_calls)) {
    out.tool_calls = await sealToolCalls(body.tool_calls as ToolCallish[], key, idempotencyKey);
  }
  return out;
}

/** The shape this file needs from a tool call. Structural rather than imported, so `turn.ts` and
 *  this one do not depend on each other. */
interface ToolCallish {
  id?: string;
  function?: { name?: string; arguments?: string; argumentsSealed?: string };
}

async function sealToolCalls(
  calls: ToolCallish[],
  key: ConversationKey,
  idempotencyKey?: string,
): Promise<ToolCallish[]> {
  const out: ToolCallish[] = [];
  for (const [i, c] of calls.entries()) {
    const args = c.function?.arguments;
    if (typeof args !== "string") {
      out.push(c);
      continue;
    }
    // `arguments` MOVES to `argumentsSealed`, the nested twin of the flat rename: the turn worker
    // copies this blob into a `tool_call` without a key, so it must read the sealed name there too
    // (`extensions/ts/turn.ts`). The per-call index joins the idempotency key, or two calls in one
    // round would derive one nonce under one DEK.
    const fn = { ...c.function } as { name?: string; arguments?: string; argumentsSealed?: string };
    fn.argumentsSealed = await encryptText(key, args, idempotencyKey && `${idempotencyKey}#${i}`);
    delete fn.arguments;
    out.push({ ...c, function: fn });
  }
  return out;
}

/**
 * A copy of `body` with this kind's prose opened and the marker REMOVED.
 *
 * Removing it is the load-bearing half. `READABLE` is empty, so every downstream `assertReadable`
 * refuses a marked body; a body that has been through here is unmarked, so those refusals stop
 * firing exactly where a key was applied. A reader that forgot to decrypt still hits the wall.
 */
export async function openBody<T extends Record<string, unknown>>(
  body: T,
  kind: string,
  key: ConversationKey,
): Promise<T> {
  if (encMarker(body) === undefined) return body;
  const out: Record<string, unknown> = { ...body };
  delete out[ENC_FIELD];
  const fields = ENCRYPTED_FIELDS[kind];
  // Restore the ORIGINAL name, so everything downstream of `openBody` still reads `content`: the
  // rename is invisible past this boundary. `sealedValue` takes the new field or the old one, so a
  // record sealed before the rename opens unchanged, and the `<name>Sealed` twin is dropped.
  for (const f of fields?.text ?? []) {
    const packed = sealedValue(body, f);
    if (packed !== undefined) {
      out[f] = await decryptText(key, packed);
      delete out[sealedName(f)];
    }
  }
  for (const f of fields?.json ?? []) {
    const packed = sealedValue(body, f);
    if (packed !== undefined) {
      out[f] = JSON.parse(await decryptText(key, packed));
      delete out[sealedName(f)];
    }
  }
  if (kind === "message" && Array.isArray(body.tool_calls)) {
    const opened: ToolCallish[] = [];
    for (const c of body.tool_calls as ToolCallish[]) {
      const packed = c.function?.argumentsSealed ?? c.function?.arguments;
      if (typeof packed !== "string") {
        opened.push(c);
        continue;
      }
      const fn = { ...c.function } as { name?: string; arguments?: string; argumentsSealed?: string };
      fn.arguments = await decryptText(key, packed);
      delete fn.argumentsSealed;
      opened.push({ ...c, function: fn });
    }
    out.tool_calls = opened;
  }
  return out as T;
}

/**
 * One holder's view of the conversations it can open, with the unwrapped DEK cached per id.
 *
 * A DEK never changes, so this is one unwrap per conversation per process — the point being that
 * a worker serving many conversations does not repeat the KEK work per record. Cached by
 * conversation id, never by the `encryption` block: two blocks that differ are two conversations,
 * and keying on the material would hide a record that was swapped underneath.
 */
export class KeyRing {
  private readonly cache = new Map<string, Promise<ConversationKey>>();
  constructor(private readonly holder: KeyHolder) {}

  /** The DEK for `conversationId`, given that conversation's stored key material. */
  dek(conversationId: string, encryption: ConversationEncryption): Promise<ConversationKey> {
    const hit = this.cache.get(conversationId);
    if (hit) return hit;
    // Cached as the PROMISE, so concurrent claims on one conversation unwrap once. A rejection is
    // evicted: a transient holder mistake must not be remembered as this conversation's answer.
    const pending = openConversation(encryption, this.holder).catch((e) => {
      this.cache.delete(conversationId);
      throw e;
    });
    this.cache.set(conversationId, pending);
    return pending;
  }
}
