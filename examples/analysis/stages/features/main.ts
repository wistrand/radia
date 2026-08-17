// FEATURES: per-column descriptive statistics over clean's rows.

import { runStage, type StageRequest } from "../harness.ts";

export const about = "per-column count, mean, min, max and standard deviation";

const round = (n: number) => Math.round(n * 1000) / 1000;

export function transform(input: Uint8Array): Uint8Array {
  const { columns, rows } = JSON.parse(new TextDecoder().decode(input)) as { columns: string[]; rows: number[][] };
  const stats = columns.map((name, i) => {
    const xs = rows.map((r) => r[i]).filter((n) => Number.isFinite(n));
    const n = xs.length;
    const mean = n === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / n;
    // Population standard deviation: a sample estimate would need a rule for n = 1 that says
    // more about the estimator than about the data.
    const sd = n === 0 ? 0 : Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    return {
      name,
      n,
      mean: round(mean),
      min: n === 0 ? 0 : Math.min(...xs),
      max: n === 0 ? 0 : Math.max(...xs),
      sd: round(sd),
    };
  });
  return new TextEncoder().encode(JSON.stringify({ columns: stats, rows: rows.length }, null, 2));
}

/** What the workspace-agent host calls: this tree, run as a stage agent. */
export default (record: StageRequest) => runStage(record, transform);
