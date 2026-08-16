// One space per test FILE. Each per-test boot of `src/main.ts dev` cost ~1.4s of subprocess
// startup around milliseconds of assertion, which made this suite ~150 boots and 3m44s in CI.
// A file's tests share one space instead, and isolation moves from "a virgin space" to NAMES:
// anything a test grants, retires, publishes or counts must be scoped to identifiers from
// `uniq()`, because a kind now holds other tests' records too. An absolute count over a whole
// kind is the tell that a test still assumes the virgin space.
//
// The spawn happens at module load, OUTSIDE any test, so the test sanitizers never see the child
// process; the unload hook reaps it when the process exits. Every file must use a DISTINCT port:
// all files' spaces are alive at once now, not one at a time.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../../examples/operator.ts";

export async function bootSpace(port: number, opts: { artifactPort?: number } = {}): Promise<RadiaClient> {
  const url = `http://127.0.0.1:${port}`;
  const space = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/main.ts", "dev", "--port", String(port), "--artifact-port", String(opts.artifactPort ?? 0)],
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  globalThis.addEventListener("unload", () => {
    try {
      space.kill("SIGTERM");
    } catch {
      // already gone
    }
  });
  const probe = new RadiaClient(url);
  for (let i = 0; i < 400; i++) {
    try {
      await probe.health();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  return new RadiaClient(url, { token: operatorToken(url) });
}

let n = 0;

/** A per-test name (`uniq("w")` -> `w1`, `w2`, …). Scoping by these is what replaces the virgin
 *  space: two tests that both say `agent:worker` now share grants, retirements and records. */
export function uniq(prefix: string): string {
  return `${prefix}${++n}`;
}
