// Benchmark harness: timing, percentiles, and a readable table.
//
// Separate from `test/` on purpose. The tests answer "is this correct on every
// adapter"; this answers "how fast, and where does it stop scaling". A benchmark that fails is
// not a broken build. It is a number that moved, which is why nothing here asserts.
//
// Two rules the suites follow:
//   - MEASURE THE RUNTIME, NOT THE HARNESS. Setup (seeding records, minting tokens) happens
//     outside the timed region, and every suite warms up before it counts.
//   - REPORT THE SHAPE, NOT ONE NUMBER. A mean hides the tail that actually hurts, so every
//     measurement carries p50/p95/p99 (blank below MIN_SAMPLES), and scaling suites report cost
//     at several sizes.
//
// `Deno.bench` is deliberately not used: it is built for ns-scale microbenchmarks of a single
// function, and what matters here is throughput under contention and how cost grows with the
// size of a space: curves and percentiles across adapters, not one ops/sec figure.

import type { StorageAdapter } from "../src/storage/adapter.ts";
import { Space } from "../src/core/space.ts";

export interface BenchContext {
  /** A fresh space on the adapter under test. */
  space: Space;
  /** How hard to push: scales iteration counts so a quick run stays under a minute. */
  scale: number;
  /** The adapter itself, for a suite that needs a Space with a non-default context (the OIDC
   *  suite configures an issuer). Build the second Space over this; never a second adapter. */
  adapter: StorageAdapter;
}

export interface Bench {
  name: string;
  /** What the number means, printed under the table. Say what would make it move. */
  note?: string;
  run: (ctx: BenchContext) => Promise<Measurement[]>;
}

export interface Measurement {
  /** The operation, e.g. "put" or "childrenOf @ 10k". */
  label: string;
  /** Wall-clock per operation, in milliseconds. */
  samples: number[];
  /** Operations counted (usually samples.length, but batched ops report the batch size). */
  ops?: number;
  /** Total elapsed for the whole run, for a throughput figure that includes overheads. */
  elapsedMs?: number;
  /** One p50 per independent trial, set by `pool` when `--trials` ran the bench more than once. */
  trialP50s?: number[];
}

/** Fewer samples than this and the percentile is blank: at 20 samples a p99 IS the max, and a
 *  column that looks like a tail but reports one observation is worse than an empty one. */
export const MIN_SAMPLES = { p95: 20, p99: 100 } as const;

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/** Time one operation, returning its duration in ms. */
export async function timed(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

/**
 * Run `fn` n times, collecting per-op durations. Warms up first, uncounted.
 *
 * Pass `warmup: 0` for a STATEFUL benchmark, one where each iteration consumes a resource
 * prepared in advance (a lease to settle, a record to claim). The default warmup would eat the
 * first few of them and the counted loop would run off the end.
 */
export async function measure(label: string, n: number, fn: (i: number) => Promise<unknown>, warmup = 5): Promise<Measurement> {
  for (let i = 0; i < Math.min(warmup, n); i++) await fn(-1 - i);
  const samples: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < n; i++) samples.push(await timed(() => fn(i)));
  return { label, samples, elapsedMs: performance.now() - t0 };
}

/**
 * Merge independent trials of one bench into one row per label. Samples and operation counts are
 * pooled, so the tail columns get the combined sample count; each trial's own p50 is kept, because
 * the spread between trials is the run-to-run noise a single run cannot show.
 */
export function pool(trials: Measurement[][]): Measurement[] {
  const byLabel = new Map<string, Measurement>();
  for (const trial of trials) {
    for (const m of trial) {
      const p50 = m.samples.length > 0 ? [percentile([...m.samples].sort((a, b) => a - b), 50)] : [];
      const ops = m.ops ?? m.samples.length;
      const prev = byLabel.get(m.label);
      if (!prev) {
        byLabel.set(m.label, { label: m.label, samples: [...m.samples], ops, elapsedMs: m.elapsedMs, trialP50s: p50 });
        continue;
      }
      prev.samples.push(...m.samples);
      prev.ops = (prev.ops ?? 0) + ops;
      if (m.elapsedMs !== undefined) prev.elapsedMs = (prev.elapsedMs ?? 0) + m.elapsedMs;
      prev.trialP50s!.push(...p50);
    }
  }
  return [...byLabel.values()];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const fmt = (ms: number) => ms >= 100 ? `${ms.toFixed(0)}ms` : ms >= 1 ? `${ms.toFixed(1)}ms` : `${(ms * 1000).toFixed(0)}µs`;

/** `heading` names the first column: the adapter under test for an in-process suite, the scale
 *  checkpoint for the deployment one. Everything else about the row is the same. */
export function renderTable(rows: { adapter: string; m: Measurement }[], heading = "ADAPTER"): string {
  // SPREAD only when trials ran: (max - min) of the per-trial p50s over their median. It is the
  // run-to-run noise, so a before/after difference smaller than it is not a difference.
  const trials = rows.some(({ m }) => (m.trialP50s?.length ?? 0) > 1);
  const head = [heading, "OPERATION", "OPS", "OPS/S", "p50", ...(trials ? ["SPREAD"] : []), "p95", "p99", "MAX"];
  const body = rows.map(({ adapter, m }) => {
    const sorted = [...m.samples].sort((a, b) => a - b);
    const n = sorted.length;
    const ops = m.ops ?? n;
    const perSec = m.elapsedMs && m.elapsedMs > 0 ? (ops / m.elapsedMs) * 1000 : 0;
    const p50s = m.trialP50s ?? [];
    const mid = p50s.length > 1 ? median(p50s) : percentile(sorted, 50);
    const spread = p50s.length > 1 && mid > 0 ? `${(((Math.max(...p50s) - Math.min(...p50s)) / mid) * 100).toFixed(0)}%` : "-";
    // A row with no per-op samples measured THROUGHPUT only (a concurrent fill, where a per-op
    // duration would time queueing rather than the operation). Blank percentiles, not zeros: `0µs`
    // reads as instant, which is the opposite of what an unmeasured column means. A tail with too
    // few samples behind it is blank for the same reason (MIN_SAMPLES).
    const tail = n === 0 ? ["-", ...(trials ? ["-"] : []), "-", "-", "-"] : [
      fmt(mid),
      ...(trials ? [spread] : []),
      n >= MIN_SAMPLES.p95 ? fmt(percentile(sorted, 95)) : "-",
      n >= MIN_SAMPLES.p99 ? fmt(percentile(sorted, 99)) : "-",
      fmt(sorted[n - 1]),
    ];
    return [
      adapter,
      m.label,
      String(ops),
      perSec >= 1000 ? `${(perSec / 1000).toFixed(1)}k` : perSec.toFixed(0),
      ...tail,
    ];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => i <= 1 ? c.padEnd(widths[i]) : c.padStart(widths[i])).join("  ");
  return [line(head), widths.map((w) => "─".repeat(w)).join("  "), ...body.map(line)].join("\n");
}

/** A fresh space per benchmark, so one suite's records never skew another's scans. */
export async function withSpace<T>(adapter: StorageAdapter, fn: (space: Space, adapter: StorageAdapter) => Promise<T>): Promise<T> {
  await adapter.init();
  try {
    return await fn(new Space(adapter), adapter);
  } finally {
    await adapter.close();
  }
}
