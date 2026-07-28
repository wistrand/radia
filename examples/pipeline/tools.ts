// Deterministic demo tools, keyed by `op`. These stand in for the model call / real work
// a production agent would do in its handler (deterministic, so the demo has no keys and
// no flakiness). The seam where a tool runs is exactly where an LLM step would go.

export type Tool = (input: unknown) => unknown;

export const tools: Record<string, Tool> = {
  upper: (s) => String(s).toUpperCase(),
  reverse: (s) => [...String(s)].reverse().join(""),
  wordcount: (s) => String(s).trim().split(/\s+/).filter(Boolean).length,
  sum: (xs) => (Array.isArray(xs) ? xs : []).reduce((a, b) => a + Number(b), 0),
  split: (s) => String(s).trim().split(/\s+/).filter(Boolean),
};
