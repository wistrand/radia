// The analysis itself: three pure functions over bytes.
//
// PURE, and that is what makes the pipeline's caching honest. A stage is `bytes -> bytes` with no
// clock, no randomness and no I/O, so "same input, same code, same output" holds and a memo keyed
// on (inputDigest, codeDigest) is sound. A stage that read the time would make every cached result
// a lie, and nothing in the substrate could tell.
//
// Each stage's VERSION is the sha256 of this file. Editing an analysis below therefore changes the
// digest for real — which is the whole demonstration: the planner sees a stage whose code digest
// has no result, asks for that work, and leaves every unaffected stage alone.

import type { StageName } from "./kinds.ts";

export interface Stage {
  name: StageName;
  /** What it produces, for the UI. Not part of the digest. */
  about: string;
  run(input: Uint8Array): Uint8Array;
}

const dec = new TextDecoder();
const enc = new TextEncoder();
const json = (v: unknown) => enc.encode(JSON.stringify(v, null, 2));

/** CLEAN: text to rows of numbers, dropping what does not parse. */
const clean: Stage = {
  name: "clean",
  about: "parse the upload into numeric rows, dropping unparseable lines",
  run(input) {
    const lines = dec.decode(input).split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const header = lines.length > 0 && /[a-zA-Z]/.test(lines[0]) ? lines[0].split(/[,\t;]/).map((h) => h.trim()) : null;
    const rows: number[][] = [];
    let dropped = 0;
    for (const line of lines.slice(header ? 1 : 0)) {
      const cells = line.split(/[,\t;]/).map((c) => Number(c.trim()));
      if (cells.length === 0 || cells.some((n) => !Number.isFinite(n))) {
        dropped++;
        continue;
      }
      rows.push(cells);
    }
    const columns = header ?? rows[0]?.map((_, i) => `col${i + 1}`) ?? [];
    return json({ columns, rows, dropped });
  },
};

/** FEATURES: per-column descriptive statistics. */
const features: Stage = {
  name: "features",
  about: "per-column count, mean, min, max and standard deviation",
  run(input) {
    const { columns, rows } = JSON.parse(dec.decode(input)) as { columns: string[]; rows: number[][] };
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
    return json({ columns: stats, rows: rows.length });
  },
};

/** REPORT: the headline an operator actually reads. */
const report: Stage = {
  name: "report",
  about: "the headline: the most variable column, and how many rows carried it",
  run(input) {
    const { columns, rows } = JSON.parse(dec.decode(input)) as {
      columns: { name: string; n: number; mean: number; sd: number; min: number; max: number }[];
      rows: number;
    };
    // "Most variable" by COEFFICIENT of variation, not by raw sd: columns in different units are
    // not comparable by spread alone, and a column of large numbers would always win.
    const ranked = [...columns]
      .map((c) => ({ ...c, cv: c.mean === 0 ? 0 : round(Math.abs(c.sd / c.mean)) }))
      .sort((a, b) => b.cv - a.cv);
    const top = ranked[0];
    return json({
      rows,
      headline: top
        ? `${top.name} varies most (cv ${top.cv}, mean ${top.mean} over ${top.n} values)`
        : "no numeric columns were found",
      ranked,
    });
  },
};

const round = (n: number) => Math.round(n * 1000) / 1000;

export const STAGE_IMPLS: Record<StageName, Stage> = { clean, features, report };

/**
 * This file's digest, which every stage reports as its code version.
 *
 * ONE file for all three stages, so editing any analysis re-runs all of them. That is coarser than
 * it needs to be and it is honest about what it measures: the digest covers the code that COULD
 * have run, not the code that did. Splitting the file per stage is the obvious refinement and is
 * left out because it would hide the point — the granularity of invalidation is a property of how
 * you version, not of the substrate.
 */
export async function stagesDigest(): Promise<string> {
  const src = await Deno.readFile(new URL("./stages.ts", import.meta.url));
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", src));
  return "s1:" + [...d.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
