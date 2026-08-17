// REPORT: the headline an operator actually reads, over features' statistics.

import { runStage, type StageRequest } from "../harness.ts";

export const about = "the headline: the most variable column, and how many rows carried it";

const round = (n: number) => Math.round(n * 1000) / 1000;

export function transform(input: Uint8Array): Uint8Array {
  const { columns, rows } = JSON.parse(new TextDecoder().decode(input)) as {
    columns: { name: string; n: number; mean: number; sd: number; min: number; max: number }[];
    rows: number;
  };
  // "Most variable" by COEFFICIENT of variation, not by raw sd: columns in different units are
  // not comparable by spread alone, and a column of large numbers would always win.
  const ranked = [...columns]
    .map((c) => ({ ...c, cv: c.mean === 0 ? 0 : round(Math.abs(c.sd / c.mean)) }))
    .sort((a, b) => b.cv - a.cv);
  // Only a column that HELD values may headline. All-garbage input still yields columns (clean
  // reads a lettered first line as a header), each with n = 0, and "vvv varies most (cv 0, mean 0
  // over 0 values)" is a confident sentence about nothing.
  const top = ranked.find((c) => c.n > 0);
  return new TextEncoder().encode(JSON.stringify({
    rows,
    headline: top
      ? `${top.name} varies most (cv ${top.cv}, mean ${top.mean} over ${top.n} values)`
      : "no numeric data was found",
    ranked,
  }, null, 2));
}

/** What the workspace-agent host calls: this tree, run as a stage agent. */
export default (record: StageRequest) => runStage(record, transform);
