// Identifiers and content hashing.

import { monotonicUlid } from "@std/ulid";

/**
 * A fresh ULID — MONOTONIC, and that matters more than it looks.
 *
 * A plain `ulid()` encodes the millisecond and fills the rest with randomness, so two ids minted
 * inside the same millisecond sort in ARBITRARY relative order. Record id order is load-bearing
 * all over Radia: it is the deterministic tie-break for `query`, the cursor for keyset pagination,
 * and — the one that bites — the "which record is newer" rule behind every latest-wins registry
 * projection (`core/registry.ts`: kind declarations, grants, capabilities, saved procedures).
 * Declaring something and then retiring it in quick succession is exactly a same-millisecond pair,
 * so with plain ULIDs a retirement could be silently outranked by the record it retired.
 *
 * `monotonicUlid()` keeps the timestamp and INCREMENTS the random component when the clock has not
 * advanced, so ids from one process are strictly increasing. Note the honest limit: across
 * processes (several runtime instances on one Postgres) ordering is still only millisecond-
 * accurate, because nothing coordinates their random halves. Within a millisecond, across
 * instances, "newest" remains a tie — which is why a retirement and its revival should not be
 * raced from two instances.
 */
export function newUlid(): string {
  return monotonicUlid();
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
