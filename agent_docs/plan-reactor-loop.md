# Plan: reactorLoop, the fact-side twin of agentLoop

**Status: BUILT 2026-08-18** (`reactorLoop` in `sdk/ts/loop.ts`; the three conversions; the three
contract tests in `test/loop.test.ts`, each proven able to fail by planting — the gap test
was green under a disabled tick until it sequenced the write strictly after the boot pass, which
is now a comment in the test). TS only; Python parity deferred and noted in `sdk/README.md`.
Analysis 2026-08-18, claims verified against source the same day. Radia has two link shapes and only the fenced one has a harness: `agentLoop` supervises the
claim side, and every fact-side reader (watch, re-read, decide, write under a derived key) is a
hand-rolled `for await` that gets the supervision wrong. Extract the loop; leave the join in the
app.

## The two questions this must keep apart

Claiming several KINDS OF WORK is already `agentLoop` with `patterns: Pattern[]`; nothing to
build. Waiting for several records to ALL ARRIVE is the join, and there is deliberately no join
primitive: `take` claims exactly one record, so a barrier cannot be a claim. The shape is watch,
re-read, decide, write under a derived key (`examples/pipeline/aggregator.ts` canonical,
`extensions/ts/turn.ts` elaborate). The five rules of that shape stay APP rules: don't claim
facts; a wakeup is a trigger, never the data; let the parts carry their own arity; the
idempotency key is the correctness argument (and expires, so the QUERY is the long-term memo);
page to exhaustion before deciding (`readAll`, refuse a prefix).

## What actually fails today, verified

`client.watch()` self-heals more than its call sites assume: transient drops retry inside the
generator (300ms), a server restart's 404 RE-CREATES the watch, 410 restarts the cursor, an
expired token gets one exchange (`sdk/ts/client.ts:952-1065`). It throws only on terminal
authorization (a real 403, or a `revoked` frame). So the naive sites survive blips and space
restarts, and their real failures are two, both invisible from outside:

1. **Gap misses with no signal.** After the internal 404 re-create, events in the gap are
   "missed by construction" and THE CALLER IS NEVER TOLD a reconnect happened. "Sweep on every
   re-watch" is unimplementable against today's generator: there is no observable re-watch.
2. **Death on run turnover.** A `revoked: credential_invalid` frame (the run ceiling, or
   `runs --stop`) throws out of the `for await`. `examples/analysis/planner.ts` and `host.ts`
   have no catch, so the PROCESS exits — loud in a terminal, invisible to the pipeline, and
   `run.ts` does not supervise children. The flagship pipeline dies half a day in.

Census (9 `for await` watch sites outside the SDK): `extensions/ts/turn.ts` is the one full
implementation; `examples/chat/client/waiting.ts` and `workers/exec.ts` have documented
degradations; `extensions/ts/enrolment.ts` stops watching on throw; `analysis/planner.ts` (twice)
and `analysis/host.ts` die; `cli.ts`'s interactive verb is fine as is. `agentLoop` already
contains the correct watcher (`sdk/ts/loop.ts:223-262`: streak-suppressed drop logging, backoff,
`credential_invalid` re-watched vs permanent 403 reported once + poll fallback) — unreachable
unless you claim work. This is de-duplication, not new machinery: the tool-worker envelope
precedent, same failure mode (a silent stall that reads as an idle space).

## The design

```ts
export interface ReactorOptions {
  name: string;
  /**
   * What to wake on. A WAKEUP HINT, never the correctness argument: `reconcile` decides, and
   * must be correct against a watch that woke it for the wrong record or did not wake it at all.
   * Write the pattern you mean; a `match` is evaluated server-side today (`Space.matchesEvent`)
   * and costs one coalesced record fetch per write of that kind, not per stream.
   *
   * Wake precision may IMPROVE and will never be exact. Within-kind routing is measured and
   * deferred (plan-scaling.md, crossover around A x U = 10,000); if it lands it is a
   * same-process equality index that must be provably at least as permissive as the matcher, so
   * `$or`, `$exists`, non-indexed paths and author scope stay in a wake-always bucket, and the
   * cross-instance path stays kind-blind by decision rather than by omission. The server also
   * ANDs your grant patterns into the watch, so wakeups can narrow under a grant change your
   * code never sees — one more reason the watch is a hint.
   */
  patterns: Pattern[];
  /** Called at boot, on every wakeup, and on every tick. Single-flighted: a burst of wakeups is
   *  one pass. A throw is reported and the loop continues; supervision undone by one unhandled
   *  sweep error is the planner's current bug, not a behavior to keep. */
  reconcile: () => Promise<void>;
  signal?: AbortSignal;
  /** The CORRECTNESS SPINE, not a degradation: the SDK's watch re-creates itself after a server
   *  restart without telling anyone, so events in the gap are healed by this tick and nothing
   *  else. The same structure as agentLoop, whose take-side poll is why ITS watchers can afford
   *  to be dumb hints. Also what a permanently refused watch degrades to. */
  pollMs?: number;
  log?: (m: string) => void;
}
export function reactorLoop(client: RadiaClient, o: ReactorOptions): Promise<void>;
```

Owns: reconcile before the first watch; N watches (one per pattern) merged into one
single-flighted reconcile; `credential_invalid` re-watched under a fresh run; a real 403 reported
once, never retried, poll continues; abort as a clean stop; the always-on tick; reconcile errors
reported and survived. The alternative to the tick — extending `watch()` to surface reconnects as
a control event — is a fine future SDK addition but not a prerequisite; the tick is precedented
and needs no SDK change.

Must NOT own, and the doc comment says so: the completeness test (which kinds, what arity — app
policy, the planner argument), the idempotency key (`summary:<jobId>`, `turn:<messageId>` and
`stage:<dataset>:...` are three different join identities), and the sweep's scoping (`turn.ts`
sweeps only conversation heads for a stated reason; the planner takes the 50 newest datasets).

## Where it goes, and the conversions

`sdk/ts/loop.ts`, beside `agentLoop`: it imports only the client and carries no opinion about
what a record means, and extensions may import the SDK, so `turn.ts` and `enrolment.ts` can
convert without a layering violation. Convert three: `examples/analysis/planner.ts`,
`examples/analysis/host.ts`, `extensions/ts/enrolment.ts` (the invisible-failure sites).
`turn.ts` may convert to shed its hand-rolled copy; `waiting.ts` and `exec.ts` keep their
documented shapes; the CLI verb stays.

## The contract test

`test/loop.test.ts` (it may import `src/`), planting BOTH failure classes, because a
supervision guard nobody has seen fail is one nobody has tested:

- a `credential_invalid` revocation mid-stream: assert the loop re-watches under a fresh run and
  reconciles on the way round;
- a gap (kill and restart the space between two writes): assert the tick reconciles the missed
  record with no wakeup ever arriving;
- a permanent 403: assert one loud report, no retry storm, and the poll keeping the join correct.
