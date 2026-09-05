// A team member run as a WORKER: an `agentLoop` on the member's patterns whose handler launches an
// agent harness (Claude Code, Codex, anything with a non-interactive mode) once per claim, with
// the claimed record in its prompt and the member's MCP config in its hands. What that closes is
// the one limit architecture-teams.md states for MCP alone: nothing wakes a harness that is not
// running. Here the loop is what runs, holding a real watch stream and a fenced lease, and the
// harness exists only while there is work, so an idle team costs no tokens.
//
// THE CLAIM IS SHARED WITH THE HARNESS. The loop claims under the member's session run, and the
// harness's adapter resumes the same session (`radia mcp --session <name>`), so the claim id the
// prompt names (`claim-<record>-<epoch>`, the adapter's own format) is one the harness may settle
// itself, with its answer riding the ack the way a member on MCP answers. If the harness exits
// without settling, the loop acks with no result; a non-zero exit nacks; a lease lost mid-run kills
// the child, since a fenced worker must stop at the fence rather than finish into somebody else's
// claim. The harness never sees a credential this file did not already hand it in its config.
//
// A CLIENT, like `host.ts`: it imports the SDK and spawns processes, and the runtime learns
// nothing about harnesses. The command templates live with the CLI (`src/surfaces/teamfile.ts`),
// because which flags make a harness non-interactive is a fact about somebody else's release.

import { agentLoop, SETTLED } from "../../sdk/ts/loop.ts";
import type { Pattern, RadiaClient, RadiaRecord } from "../../sdk/ts/client.ts";

export interface HarnessMember {
  /** The principal, `agent:<name>`. */
  agent: string;
  /** argv, fully substituted except `{{prompt}}` (present, the prompt travels in argv; absent, it
   *  goes in on stdin, which is what Claude Code and Codex both read) and `{{harnessSession}}`,
   *  the harness session id this worker owns when `resume` is set. */
  command: string[];
  /** The prompt template. Placeholders: `{{agent}}`, `{{url}}`, `{{recordId}}`, `{{kind}}`,
   *  `{{body}}` (the record body as JSON), `{{claimId}}`. */
  prompt: string;
  /**
   * WARM SESSIONS: keep one harness session per member across claims. The worker owns the id: it
   * mints one before the first launch (a UUID, which Claude Code accepts as `--session-id` and
   * Codex reports back as its `thread_id`), stores it through `sessions`, and launches
   * `resumeCommand` with `resumePrompt` while it holds one. A run that FAILED drops the id, so a
   * poisoned session does not follow the member to its next claim; a fence or a timeout keeps it.
   */
  resume?: {
    command: string[];
    prompt: string;
    /** Where the id lives between launches, and between runs of the worker. */
    sessions: { load(): string | undefined; save(id: string | undefined): void };
    /** Learn the id from a harness that reports its own (Codex's `thread.started`); Claude Code
     *  is told the id and reports nothing. */
    learn?: (line: string) => string | undefined;
  };
  patterns: Pattern[];
  leaseSeconds: number;
  /** Kill the harness past this and nack: a harness that hangs holds a lease that heartbeats. */
  timeoutSeconds: number;
  concurrency: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface HarnessRun {
  agent: string;
  recordId: string;
  kind: string;
  /** `ok`: the loop acked (no result). `settled`: the harness settled the claim itself. `failed`:
   *  non-zero exit, nacked. `timeout`: killed past `timeoutSeconds`, nacked. `fenced`: the lease
   *  was lost mid-run and the child killed. */
  outcome: "ok" | "settled" | "failed" | "timeout" | "fenced";
  exitCode: number | null;
  durationMs: number;
  /** The last lines the harness printed, for a log line rather than a transcript. */
  tail: string[];
}

export interface WorkerOptions {
  signal: AbortSignal;
  log: (line: string) => void;
  onRun?: (run: HarnessRun) => void;
  /** Handle one claim, then stop. */
  once?: boolean;
  /** Relay the harness's output as it came rather than one digested line per event. */
  verbose?: boolean;
  /** Runs just before each spawn: the CLI uses it to write the session's current run where the
   *  harness's adapter will resume it, since a run past its ceiling is replaced mid-loop. */
  beforeSpawn?: () => Promise<void>;
}

/**
 * One line per harness event rather than the harness's own stream. Codex `exec --json` emits JSONL
 * items (a tool call, a message, the turn's usage); Claude Code `-p --output-format json` emits one
 * result object at the end. Anything unrecognised passes through as it came, cut to a line. The
 * raw stream is what `verbose` gives back.
 */
export function digestLine(line: string): string | undefined {
  const cut = (t: string, n = 160) => (t.length > n ? t.slice(0, n - 1) + "…" : t).replace(/\s+/g, " ");
  if (!line.startsWith("{")) return line ? cut(line) : undefined;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return cut(line);
  }
  const t = o.type;
  if (t === "item.started" || t === "item.completed") {
    const item = o.item as { type?: string; tool?: string; text?: string; arguments?: unknown; error?: unknown } | undefined;
    if (!item) return undefined;
    if (item.type === "mcp_tool_call") {
      if (t === "item.started") return `→ ${item.tool} ${cut(JSON.stringify(item.arguments ?? {}), 100)}`;
      return item.error ? `← ${item.tool} error ${cut(String(item.error), 100)}` : undefined;
    }
    if (item.type === "agent_message" && t === "item.completed") return `says: ${cut(String(item.text ?? ""))}`;
    return undefined;
  }
  if (t === "turn.completed") {
    const u = o.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    return u ? `turn done: ${u.input_tokens ?? 0} in, ${u.output_tokens ?? 0} out` : "turn done";
  }
  if (t === "thread.started" || t === "turn.started") return undefined;
  if (t === "result") {
    const cost = typeof o.total_cost_usd === "number" ? ` ($${o.total_cost_usd.toFixed(3)}, ${o.num_turns ?? "?"} turns)` : "";
    return `result${cost}: ${cut(String(o.result ?? ""))}`;
  }
  return cut(line);
}

/** Codex `exec --json` reports its own session as the first event's `thread_id`. */
export function learnCodexThread(line: string): string | undefined {
  if (!line.startsWith("{") || !line.includes("thread.started")) return undefined;
  try {
    const o = JSON.parse(line) as { type?: string; thread_id?: string };
    return o.type === "thread.started" && typeof o.thread_id === "string" ? o.thread_id : undefined;
  } catch {
    return undefined;
  }
}

export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in values ? values[k] : m));
}

const decoder = new TextDecoder();

/** Drain a stream line by line into `sink`; for a process whose output is relayed and not kept. */
export async function pumpLines(stream: ReadableStream<Uint8Array>, sink: (line: string) => void): Promise<void> {
  await pump(stream, sink, []);
}

/** Drain a stream line by line into `sink`, keeping a bounded tail. */
async function pump(stream: ReadableStream<Uint8Array>, sink: (line: string) => void, tail: string[]): Promise<void> {
  let rest = "";
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      sink(line);
      tail.push(line);
      if (tail.length > 8) tail.shift();
    }
  }
  if (rest) {
    sink(rest);
    tail.push(rest);
    if (tail.length > 8) tail.shift();
  }
}

/**
 * Run one member as a worker until `signal` aborts (or, with `once`, until one claim is handled).
 * Resolves when the loop has stopped; the caller runs one of these per member and awaits them all.
 */
export async function runHarnessMember(client: RadiaClient, m: HarnessMember, o: WorkerOptions): Promise<void> {
  if (m.resume && m.concurrency > 1) {
    throw new Error(`${m.agent}: a warm session (resume) is one harness session, so it cannot run ${m.concurrency} claims at once; set concurrency 1 or resume false`);
  }
  const ctl = new AbortController();
  o.signal.addEventListener("abort", () => ctl.abort(), { once: true });
  // A harness that fails to start comes back in 200ms and the loop would nack and reclaim it at
  // once, forever. Each consecutive failure waits longer before the nack (5s, 10s, … 60s), reset
  // by a run that got anywhere, so a broken launch costs one line a minute rather than a spin.
  let failures = 0;
  const short = (id: string) => id.slice(-6);
  const handle = async (record: RadiaRecord, c: RadiaClient, fence: AbortSignal): Promise<void | typeof SETTLED> => {
    const started = Date.now();
    // The adapter's claim id is `claim-<record>-<epoch>`, and its recovery checks the epoch, so the
    // envelope is read for the number rather than guessed. Fail-soft: a member that may not read
    // its own envelope still gets a harness, with no claim id to settle by.
    const before = await c.getEnvelope(record.id).catch(() => null);
    const claimId = before && before.leaseEpoch !== undefined ? `claim-${record.id}-${before.leaseEpoch}` : "";
    await o.beforeSpawn?.();
    // Warm session: resume when the member holds an id, else mint one and run the first-launch
    // command (which for Claude Code names the id up front).
    let harnessSession = m.resume?.sessions.load();
    const resuming = !!(m.resume && harnessSession && m.resume.command.length);
    if (m.resume && !harnessSession) harnessSession = crypto.randomUUID();
    const template = resuming ? m.resume!.command : m.command;
    const prompt = renderPrompt(resuming ? m.resume!.prompt : m.prompt, {
      agent: m.agent,
      url: c.base,
      recordId: record.id,
      kind: record.kind,
      body: JSON.stringify(record.body, null, 2),
      claimId,
    });
    const inArgv = template.some((s) => s.includes("{{prompt}}"));
    const argv = template.map((s) => s.replaceAll("{{prompt}}", prompt).replaceAll("{{harnessSession}}", harnessSession ?? ""));
    if (m.resume) o.log(`[${m.agent}] ${short(record.id)} | ${resuming ? "resuming" : "starting"} harness session ${harnessSession}`);
    const tail: string[] = [];
    const st: { outcome: HarnessRun["outcome"] } = { outcome: "ok" };
    let code: number | null = null;
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(argv[0], {
        args: argv.slice(1),
        cwd: m.cwd,
        env: { ...(m.env ?? {}), RADIA_URL: c.base, RADIA_RECORD_ID: record.id, RADIA_CLAIM_ID: claimId },
        stdin: inArgv ? "null" : "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (e) {
      throw new Error(`cannot start ${argv[0]}: ${(e as Error).message}`);
    }
    // SIGTERM, then SIGKILL five seconds later: a harness mid-request can ignore the first, and a
    // child that will not die holds the lease's heartbeat and the loop's slot open.
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const kill = (why: HarnessRun["outcome"]) => {
      if (st.outcome === "ok") st.outcome = why;
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      hardKill ??= setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch { /* gone */ }
      }, 5000);
    };
    const timer = setTimeout(() => kill("timeout"), m.timeoutSeconds * 1000);
    // A lease lost while the harness runs is a fence unless the record is CONSUMED, which under an
    // owner-bound settle means the harness acked it and has not exited yet: the heartbeat's next
    // renewal finds it consumed and reports lease_lost. So look before killing, and let a harness
    // that settled finish saying so. Anything else (dead-lettered by an operator, reclaimed after
    // an expiry) is somebody else's decision, and the child dies at the fence.
    const onFence = () => {
      if (ctl.signal.aborted) return kill("fenced"); // the worker is stopping: no envelope to consult
      c.getEnvelope(record.id).then((env) => {
        if (env?.state === "consumed") o.log(`[${m.agent}] ${short(record.id)} is consumed: the harness settled it, letting it finish`);
        else kill("fenced");
      }).catch(() => kill("fenced"));
    };
    fence.addEventListener("abort", onFence, { once: true });
    try {
      if (!inArgv) {
        const w = child.stdin.getWriter();
        await w.write(new TextEncoder().encode(prompt));
        await w.close();
      }
      const say = (line: string) => {
        if (m.resume?.learn && !resuming) {
          const learned = m.resume.learn(line);
          if (learned) harnessSession = learned;
        }
        const shown = o.verbose ? line : digestLine(line);
        if (shown !== undefined) o.log(`[${m.agent}] ${short(record.id)} | ${shown}`);
      };
      const [status] = await Promise.all([child.status, pump(child.stdout, say, tail), pump(child.stderr, say, tail)]);
      code = status.signal ? null : status.code; // a signal death is no exit code, whatever the shell number
    } finally {
      clearTimeout(timer);
      if (hardKill !== undefined) clearTimeout(hardKill);
      fence.removeEventListener("abort", onFence);
    }
    const after = await c.getEnvelope(record.id).catch(() => null);
    // Settled by the harness means the record is no longer under OUR lease: consumed, dead-lettered,
    // or (a nack) no longer leased at all, or leased under another id. A nack keeps the epoch (the
    // bump comes with the next claim), so the epoch cannot tell; the lease id can.
    const settled = !!after && (after.state === "consumed" || after.state === "dead_letter" ||
      (before !== null && before.leaseId !== undefined && after.leaseId !== before.leaseId));
    if (st.outcome === "ok" && settled) st.outcome = "settled";
    if (st.outcome === "ok" && code !== 0) st.outcome = "failed";
    const outcome = st.outcome;
    if (m.resume) {
      // Kept across a fence (a Ctrl-C, a stop, the loop's doing) and a timeout (the harness was
      // working); dropped after a FAILURE, which is the harness's own verdict on itself and the
      // one case where a poisoned session would follow the member.
      const keep = outcome !== "failed";
      m.resume.sessions.save(keep ? harnessSession : undefined);
      if (!keep && harnessSession) o.log(`[${m.agent}] ${short(record.id)} | harness session dropped after ${outcome}`);
    }
    const run: HarnessRun = { agent: m.agent, recordId: record.id, kind: record.kind, outcome, exitCode: code, durationMs: Date.now() - started, tail: [...tail] };
    o.onRun?.(run);
    // `once`: stop after this claim. Scheduled rather than immediate so the loop's own settle
    // (the ack or nack it performs on return) goes out under a live signal; the failure pause below
    // is cut short by the same abort, so a failed launch under --once still nacks and returns.
    if (o.once) setTimeout(() => ctl.abort(), 1500);
    if (outcome === "settled") {
      failures = 0;
      return SETTLED; // the loop neither acks nor nacks a claim the harness settled
    }
    if (outcome === "fenced") throw new Error("fenced: the lease was lost while the harness ran; it was killed");
    if (outcome === "ok") {
      failures = 0;
      return;
    }
    failures++;
    const pause = o.once ? 0 : Math.min(60, 5 * failures) * 1000;
    if (pause > 0) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, pause);
        const cut = () => {
          clearTimeout(t);
          r();
        };
        fence.addEventListener("abort", cut, { once: true });
        ctl.signal.addEventListener("abort", cut, { once: true });
      });
    }
    if (outcome === "timeout") throw new Error(`timed out after ${m.timeoutSeconds}s; killed`);
    throw new Error(`exited ${code}${tail.length ? `: ${tail[tail.length - 1]}` : ""}`);
  };
  await agentLoop(client, {
    name: m.agent,
    patterns: m.patterns,
    leaseSeconds: m.leaseSeconds,
    concurrency: m.concurrency,
    signal: ctl.signal,
    handle,
    log: o.log,
  });
}
