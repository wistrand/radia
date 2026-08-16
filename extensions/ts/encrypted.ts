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
 * Markers this build can read.
 *
 * EMPTY, and that is the phase-1 contract rather than an oversight: nothing encrypts yet, so every
 * marker is one no reader can handle. Phase 3 adds `ENC_V1` here in the same change that gives the
 * readers a key.
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
 */
export function assertReadable(body: unknown, where: string): void {
  const marker = encMarker(body);
  if (marker !== undefined && !READABLE.has(marker)) throw new EncryptedBodyError(marker, where);
}

/** The same check over a batch, so a reader asserts once rather than per row inside its own loop. */
export function assertAllReadable(bodies: Iterable<unknown>, where: string): void {
  for (const b of bodies) assertReadable(b, where);
}
