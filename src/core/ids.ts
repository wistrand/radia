// Identifiers and content hashing.

import { ulid } from "@std/ulid";

/** A fresh ULID. Lexicographically sortable ~ chronological, like created_at ordering. */
export function newUlid(): string {
  return ulid();
}

/**
 * Lowercase hex SHA-256 of a UTF-8 string, via Web Crypto (no dependency).
 * We hash the exact serialized body we persist, so the stored bytes and the hash always
 * agree (see core/record.ts). INVARIANT: the hash is over plaintext.
 */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
