// Time arithmetic on DB-sourced timestamps.
//
// All timestamps originate from the database clock (adapter.now()); these helpers only do
// arithmetic and comparison ON those values, so the host clock never enters lease/timing
// math. Our timestamps are millisecond-precision UTC ISO 8601, which sorts
// lexicographically in chronological order.

/** DB timestamp + seconds, as a UTC ISO string in the same format. Seconds may be negative. */
export function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

/** The earlier of two same-format UTC ISO timestamps. */
export function minIso(a: string, b: string): string {
  return a <= b ? a : b;
}
