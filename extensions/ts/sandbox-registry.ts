// A sandbox as a RECORD: what a space can execute, and under what guarantees.
//
// The point is who can act on it. A description in a tool's prose is readable, and only by a model;
// a record is matchable, so a GRANT can scope on the property that matters (`tool_call` limited to
// a sandbox with no filesystem) rather than on a language name standing in for it, an operator can
// ASK what a space can run, and a `check` can name the environment a verdict was reached in.
//
// TWO PARTIES, and the split is the design (agent_docs/design-execution.md):
//
//   the OPERATOR declares a sandbox, because a manifest claim is descriptive by definition and an
//     execution guarantee must not be. They configured the launcher; a worker only believes things
//     about it.
//   the WORKER verifies before serving, because a declaration nobody tested is a more convincing
//     version of an unenforced sentence. Structured data LOOKS authoritative.
//
// So a record can exist and go unserved, which is the fail-closed direction: a mismatch means
// nobody runs anything, rather than something running under a guarantee that was never true.

import type { RadiaClient } from "../../sdk/ts/client.ts";
import { type BwrapOptions, probeSandbox, type ProbeResult, type SandboxSpec } from "./sandbox.ts";

/** The kind's indexing contract. Every field a policy might bind is indexed, which is the whole
 *  reason this is a record: `{network: false}` has to be matchable, not merely readable. */
export const SANDBOX_KIND = {
  kind: "sandbox",
  indexedPaths: [
    { path: "name", type: "keyword" as const },
    { path: "language", type: "keyword" as const },
    { path: "isolation", type: "keyword" as const },
    { path: "network", type: "keyword" as const },
    { path: "processes", type: "keyword" as const },
  ],
  claimable: false,
};

/**
 * Declare a sandbox. An OPERATOR action: this is a claim about a jail somebody configured.
 *
 * Content-keyed on the spec, like every other registry write here, so a fleet restarting does not
 * append a duplicate per boot. Unbounded growth is what makes a bounded read dangerous, and this
 * registry is read to decide what may execute.
 */
export async function declareSandbox(client: RadiaClient, spec: SandboxSpec): Promise<{ id: string }> {
  const key = `sandbox:${spec.name}:${await specHash(spec)}`;
  return await client.put({ kind: "sandbox", body: spec as unknown as Record<string, unknown> }, key);
}

/** The current declaration for a name, or null. Latest-wins, bounded, like `readWorkspace`. */
export async function readSandbox(client: RadiaClient, name: string): Promise<(SandboxSpec & { id: string }) | null> {
  const rows = await client.queryNewest({ kind: "sandbox", match: { name } }, 1);
  if (rows.length === 0) return null;
  return { id: rows[0].id, ...(rows[0].body as unknown as SandboxSpec) };
}

/** Every declared sandbox: "what can this space execute, and under what guarantees". An operator
 *  question that used to be answerable only by reading a deployment script. */
export async function listSandboxes(client: RadiaClient): Promise<(SandboxSpec & { id: string })[]> {
  const rows = await client.queryNewest({ kind: "sandbox" }, 200);
  const newest = new Map<string, { id: string; body: unknown }>();
  for (const r of rows) {
    const name = (r.body as { name?: string }).name;
    if (!name) continue;
    const prev = newest.get(name);
    if (!prev || prev.id < r.id) newest.set(name, r);
  }
  return [...newest.values()].map((r) => ({ id: r.id, ...(r.body as SandboxSpec) }));
}

/**
 * Prove a declaration before serving it. A WORKER action, run once at boot.
 *
 * Returns the failing claims rather than a boolean, because "your jail is not what the record says"
 * is only actionable if it names which part. An empty array means every claim held.
 *
 * A caller that gets a non-empty result must REFUSE TO SERVE that sandbox. Not warn: the whole
 * value of the record is that a policy can rely on it, and a policy relying on an unverified claim
 * is worse than no policy, because it looks like one.
 */
export async function verifySandbox(
  spec: SandboxSpec,
  opts: {
    readRoots?: string[];
    writeRoots?: string[];
    timeoutMs?: number;
    /** How to reach the interpreter, for a backend that needs one named. */
    bwrap?: BwrapOptions;
    /** Where the import probe may write its canary; see `probeSandbox`. Needed by any caller that
     *  holds write access to exactly one directory. */
    scratchDir?: string;
    /** `host:port` this process can already reach, used to test a `network: false` claim. Without it
     *  the claim is reported UNVERIFIED rather than passing: a probe with nothing to dial cannot
     *  tell an isolated jail from an offline machine. The space's own address is the natural one. */
    networkTarget?: string;
  } = {},
): Promise<ProbeResult[]> {
  const results = await probeSandbox(spec, opts);
  return results.filter((r) => !r.held);
}

async function specHash(spec: SandboxSpec): Promise<string> {
  // Sorted keys, so the same jail described in a different field order is the same key rather than
  // a second record that looks like a change.
  const stable = JSON.stringify(Object.fromEntries(Object.entries(spec).sort(([a], [b]) => (a < b ? -1 : 1))));
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
