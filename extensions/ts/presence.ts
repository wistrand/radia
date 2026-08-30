// Is the other side still there? Ephemeral liveness, as records.
//
// A `capability` advertisement is a claim of INTENT (see `retireProviderCapabilities`): only a
// clean shutdown withdraws one, so a crashed process leaves its tools advertised forever. This is
// the missing half — a heartbeat whose ABSENCE is the signal, so a reader computes liveness at
// read time instead of trusting that somebody got to run their shutdown path.
//
// Liveness is NOT succession, and that is the whole design: presence records carry no
// `contentKey`. The newest record per registry key is never swept whatever its retention says
// (agent_docs/plan-gc.md), so a keyed presence kind would leave one permanent record per dead
// instance, forever. Unkeyed plus `defaultRetentionSeconds`, every beat carries its own expiry and
// a dead instance disappears entirely once its last beat ages out.
//
// Timers are always the CLIENT's. The space fires nothing at a deadline.
// See agent_docs/plan-presence.md.

import type { Cursor, KindDef, Pattern, RadiaClient } from "../../sdk/ts/client.ts";

/** The chat's measured pair, generalized (`examples/chat/client/fleet.ts`). */
export const DEFAULT_TTL_MS = 15 * 60_000;

/** A beat must fit at least this many times inside the TTL. Two missed beats then still read live,
 *  which is the margin that absorbs clock skew between the writer and the database, a slow tick,
 *  and a reader whose clock runs fast. */
export const MIN_BEATS_PER_TTL = 3;

const PAGE = 200;
const DEFAULT_MAX_SCAN = 2_000;

/**
 * One kind's presence contract, held by the WRITER and the READER together.
 *
 * They must agree: an app that beats every 10 minutes and reads with a 5-minute TTL sees an empty
 * world, and nothing would catch it. So the pair is one object, constructed once beside the kind
 * declaration and passed to both sides, with the ratio checked where it is built.
 */
export interface PresenceSpec {
  readonly kind: string;
  readonly ttlMs: number;
  readonly refreshMs: number;
}

export function presenceSpec(
  kind: string,
  opts: { ttlMs?: number; refreshMs?: number } = {},
): PresenceSpec {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const refreshMs = opts.refreshMs ?? Math.floor(ttlMs / MIN_BEATS_PER_TTL);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error(`presence: ttlMs must be positive, got ${ttlMs}`);
  if (!Number.isFinite(refreshMs) || refreshMs <= 0) {
    throw new Error(`presence: refreshMs must be positive, got ${refreshMs}`);
  }
  if (refreshMs * MIN_BEATS_PER_TTL > ttlMs) {
    throw new Error(
      `presence: refreshMs ${refreshMs} must be at most a third of ttlMs ${ttlMs}, or a single ` +
        `late beat reads as death`,
    );
  }
  return { kind, ttlMs, refreshMs };
}

/**
 * The kind declaration for a presence spec. The app registers it; this states the shape.
 *
 * NO `contentKey` (see the file header). Retention is 4x the TTL: long enough that a reader never
 * races the sweep for a record it still needs, short enough that a subject's history stays a
 * handful of records rather than one per beat since the space started.
 */
export function presenceKind(spec: PresenceSpec): KindDef {
  return {
    kind: spec.kind,
    indexedPaths: [{ path: "subject", type: "keyword" }, { path: "instance", type: "keyword" }],
    claimable: false,
    defaultRetentionSeconds: Math.ceil((spec.ttlMs * 4) / 1000),
  };
}

/**
 * `subject` is what a reader asks about (a provider name, a service, a role); `instance` is one
 * process serving it. ONE BEAT PER SUBJECT, never a `subjects` array: a plain keyword match does
 * not distribute over array elements (`getPath` in `src/core/matching.ts` needs a numeric index,
 * and `evalNode` refuses to distribute), so an array would force every reader onto `$any`.
 */
export interface PresenceBody {
  subject: string;
  instance: string;
  retired?: true;
}

export interface PresenceHandle {
  readonly instance: string;
  /** Beat once, now. The scheduler calls this; a test or a manual scheduler can too. */
  beat(): Promise<void>;
  /** Stop beating and write the tombstone. Idempotent. */
  retire(): Promise<void>;
}

const beatKey = (spec: PresenceSpec, subject: string, instance: string, window: number) =>
  `presence:${spec.kind}:${subject}:${instance}:${window}`;

// The window is in here for the same reason it is in a beat's key: a CONSTANT retirement key
// replays the first one, so an instance id that comes back (a reconnect, a supervisor reusing a
// stable name) can never be retired a second time and reads live for a full TTL after it left.
// `retireCapability` carries the same scar and answers it with an anchor.
const tombstoneKey = (spec: PresenceSpec, subject: string, instance: string, at: number) =>
  `presence:${spec.kind}:${subject}:${instance}:retired:${Math.floor(at / spec.refreshMs)}`;

/**
 * Say this process is serving `subject`, and keep saying it until `signal` aborts or `retire` runs.
 *
 * Beats are keyed per refresh WINDOW (`floor(now / refreshMs)`), so a process running for a week
 * costs one record per window rather than one per beat: a repeat inside a window is answered with
 * the record that already exists. The FIRST beat is awaited and throws, because a presence nobody
 * is allowed to write is a configuration failure that should surface at boot rather than as an
 * empty world an hour later; every later beat goes to `onError` instead, since a heartbeat must
 * not kill the process it describes.
 */
export async function announcePresence(
  client: RadiaClient,
  spec: PresenceSpec,
  subject: string,
  opts: { instance?: string; signal?: AbortSignal; onError?: (e: unknown) => void; now?: () => number } = {},
): Promise<PresenceHandle> {
  const instance = opts.instance ?? crypto.randomUUID();
  const clock = opts.now ?? (() => Date.now());
  let stopped = false;
  let window = -1;
  let highWater = -Infinity;
  /** The beat currently in flight, so a retirement can wait for it. */
  let inFlight: Promise<unknown> = Promise.resolve();

  const beat = async () => {
    if (stopped) return;
    // The window comes from the WALL CLOCK, which can step backwards (an NTP correction, a resumed
    // VM). A backward step lands on a window that already has a record, so the write REPLAYS,
    // nothing is appended, and `put` still reports success: an instance beating perfectly well
    // would read as dead once the step exceeded the TTL, and another instance would withdraw the
    // advertisements out from under it. So a reading BELOW the high-water mark advances the window
    // by hand instead of trusting the arithmetic. A repeat call inside one window is a different
    // thing and still dedups, because the clock has not moved backwards.
    const t = clock();
    window = t < highWater ? window + 1 : Math.max(Math.floor(t / spec.refreshMs), window);
    highWater = Math.max(highWater, t);
    inFlight = client.put(
      { kind: spec.kind, body: { subject, instance } satisfies PresenceBody },
      beatKey(spec, subject, instance, window),
    );
    await inFlight;
  };
  // Checked BEFORE the first beat as well as after the listener is registered: announcing on a
  // signal that has already aborted should write nothing at all, not one beat that then ages out.
  if (opts.signal?.aborted) stopped = true;
  await beat();

  const timer = setInterval(() => void beat().catch((e) => opts.onError?.(e)), spec.refreshMs);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  // AFTER registering, because a signal that aborted while the first beat was in flight fires no
  // listener at all: the interval would then beat for the life of the process, and a launcher that
  // shut down during startup would read LIVE forever, blocking every other launcher's withdrawal.
  opts.signal?.addEventListener("abort", stop, { once: true });
  if (opts.signal?.aborted) stop();

  return {
    instance,
    beat,
    retire: async () => {
      stop();
      // A beat that passed the `stopped` check before this call is still in flight, and it commits
      // AFTER the tombstone if nobody waits: the newest record for the pair would be a live beat
      // and the instance a ghost for a whole TTL.
      await inFlight.catch(() => {/* a failed beat is not this retirement's problem */});
      await retirePresence(client, spec, { subject, instance }, clock());
    },
  };
}

export interface PresenceView {
  /** Subject to the instances beating inside the TTL. A subject with none is absent, never empty. */
  readonly live: ReadonlyMap<string, ReadonlySet<string>>;
  readonly scanned: number;
  /**
   * Whether the walk reached the TTL horizon (or the end of the kind). FALSE means the answer is a
   * PREFIX and an instance may be live and unlisted: the scan ceiling stopped the walk, a page came
   * back full with nowhere to continue, or a GRANT narrowed the read to a subset of who is beating.
   * Never decide a withdrawal, or judge an advertisement stale, on an incomplete view.
   */
  readonly complete: boolean;
}

/**
 * Who is alive, right now.
 *
 * BOUNDED BY RELEVANCE, not by page size. The walk reads newest-first and stops at the first
 * record older than the TTL, which is exhaustive over the live set by construction: every live
 * instance has a beat younger than the TTL, so nothing live can sit past the stopping point
 * (agent_docs/plan-bounded-reads.md — this is neither a narrow nor a page, and the population it
 * exhausts is the live one rather than the kind). The scan ceiling is a backstop against a flooded
 * kind and REPORTS, rather than answering a plausible prefix in silence.
 *
 * Ages compare `createdAt`, the DATABASE clock, against the reader's own. That is the one place
 * this module trusts two clocks to be roughly in step, and the refresh margin
 * (`MIN_BEATS_PER_TTL`) is the tolerance. `now` is injectable so a test can age a space without
 * sleeping through one.
 */
export async function livePresence(
  client: RadiaClient,
  spec: PresenceSpec,
  opts: { subject?: string; now?: number; maxScan?: number } = {},
): Promise<PresenceView> {
  const horizon = (opts.now ?? Date.now()) - spec.ttlMs;
  const maxScan = opts.maxScan ?? DEFAULT_MAX_SCAN;
  const pattern: Pattern = { kind: spec.kind, ...(opts.subject ? { match: { subject: opts.subject } } : {}) };

  const live = new Map<string, Set<string>>();
  const seen = new Set<string>();
  let scanned = 0;
  let complete = false;
  let cursor: Cursor | undefined;

  walk: for (;;) {
    const page = await client.queryPage<PresenceBody>(pattern, PAGE, cursor ? { cursor } : { dir: "desc" });
    // A GRANT NARROWED THIS READ, so the answer is somebody's subset of who is beating and can
    // never be evidence that nobody else is. `scope` is present exactly when that happened, and
    // `retireIfLast` reads `complete` as permission to withdraw: without this, a reader holding a
    // pattern-scoped presence grant withdraws a live fleet's advertisements on a read that
    // deliberately hid it.
    if (page.scope) return { live, scanned, complete: false };
    for (const rec of page.records) {
      scanned++;
      if (Date.parse(rec.runtimeMeta.createdAt) < horizon) {
        complete = true; // the horizon: everything below it is dead by definition
        break walk;
      }
      const b = rec.body;
      if (typeof b?.subject !== "string" || typeof b.instance !== "string") continue;
      const pair = `${b.subject}\u0000${b.instance}`;
      if (seen.has(pair)) continue;
      seen.add(pair); // newest-first, so the first sighting of a pair is its current state
      if (b.retired) continue;
      const set = live.get(b.subject) ?? new Set<string>();
      set.add(b.instance);
      live.set(b.subject, set);
    }
    // TERMINATION IS DECIDED FROM THE PAGE'S OWN SIZE, never from the absence of `nextCursor`,
    // which says where to continue and never that it is safe to stop (`RadiaClient.queryAll` states
    // the same rule). A space that does not send the field would otherwise make a one-page prefix
    // report `complete: true`, and `retireIfLast` trusts exactly that flag to decide it is alone: a
    // live fleet's advertisements would be withdrawn out from under it.
    if (page.records.length < PAGE) {
      complete = true; // a short page is the only evidence of exhaustion that cannot go missing
      break;
    }
    if (!page.nextCursor || scanned >= maxScan) break; // a full page with nowhere to go is a PREFIX
    cursor = page.nextCursor;
  }
  return { live, scanned, complete };
}

/**
 * Say this instance has stopped serving `subject`, without deciding anything else.
 *
 * For an instance that beats on SEVERAL subjects and only asks the last-one-out question about one
 * of them: stopping the beats alone leaves the others reading live until the TTL expires, which is
 * a window in which readers still act on what this process was serving.
 */
export function retirePresence(
  client: RadiaClient,
  spec: PresenceSpec,
  who: { subject: string; instance: string },
  now = Date.now(),
): Promise<{ id: string }> {
  return client.put(
    { kind: spec.kind, body: { ...who, retired: true } satisfies PresenceBody },
    tombstoneKey(spec, who.subject, who.instance, now),
  );
}

export interface RetireResult {
  /** Whether `onLast` ran. */
  withdrew: boolean;
  /** The other instances seen serving. */
  others: readonly string[];
  /** False when the view was a PREFIX, so an empty `others` is not evidence that there are none. */
  complete: boolean;
}

/**
 * Retire this instance, and run `onLast` only if nobody else is serving the subject.
 *
 * For withdrawal work that is SHARED rather than per-instance: a `capability` advertisement is
 * keyed by (provider, tool), so two fleets publish one record and "retire what I published" names
 * nothing. Last one out withdraws.
 *
 * Fails toward STALE-VISIBLE in both of its uncertain cases, because a stale advertisement costs a
 * failed call while a wrongly withdrawn one makes a working tool invisible until its definition
 * changes. Two instances exiting in the same instant can each see the other and both skip; and an
 * incomplete view (the scan ceiling) counts as "somebody else is out there", never as zero.
 *
 * The two declines are DIFFERENT and the result keeps them apart: others still serving is the
 * ordinary case, while an incomplete view is a warning, since it means nothing here could tell.
 */
export async function retireIfLast(
  client: RadiaClient,
  spec: PresenceSpec,
  who: { subject: string; instance: string },
  onLast: () => Promise<void>,
  opts: { now?: number; maxScan?: number } = {},
): Promise<RetireResult> {
  await retirePresence(client, spec, who);
  const view = await livePresence(client, spec, { subject: who.subject, ...opts });
  const others = [...(view.live.get(who.subject) ?? [])].filter((i) => i !== who.instance);
  if (!view.complete || others.length > 0) return { withdrew: false, others, complete: view.complete };
  await onLast();
  return { withdrew: true, others, complete: true };
}
