// CLEAN: text to rows of numbers, dropping what does not parse.
//
// PURE, like every stage transform: `bytes -> bytes` with no clock, no randomness and no I/O
// beyond what the harness hands it, so "same input, same code, same output" holds and the memo
// keyed on (inputDigest, code digest) is sound.

import { runStage, type StageRequest } from "../harness.ts";

export const about = "parse the upload into numeric rows, dropping unparseable lines";

export function transform(input: Uint8Array): Uint8Array {
  const lines = new TextDecoder().decode(input).split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
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
  return new TextEncoder().encode(JSON.stringify({ columns, rows, dropped }, null, 2));
}

/** What the workspace-agent host calls: this tree, run as a stage agent. */
export default (record: StageRequest) => runStage(record, transform);
