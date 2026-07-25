// The sandbox: run model-written JavaScript with nothing.
//
// A fresh `deno` subprocess with ZERO permissions — no `--allow-net`, `--allow-read`,
// `--allow-env`, `--allow-run`, nothing — so every capability check inside it fails. The program
// arrives on stdin (`deno run -`), which is also why no file needs to be readable. The only thing
// that crosses back is bytes on stdout/stderr.
//
// Why a subprocess and not a Worker: hostile code should not share a heap with the thing holding
// a run token. Why not the tool-worker: spawning needs `--allow-run`, which that process
// deliberately lacks, and it holds a credential this code must never reach.
//
// What this IS: a boundary against accidents and ordinary malice — exfiltration, snooping,
// clobbering, runaway loops. What it is NOT: a hard boundary against a V8 or Deno 0-day. For a
// local example that is proportionate; anything multi-tenant or internet-facing wants OS-level
// isolation (container, gVisor, Firecracker) around this same worker.
//
// Known gaps, stated rather than papered over (all measured, not assumed):
//   - No CPU bound. A `while(true)` spins one core until the timeout fires.
//   - Memory is bounded only for V8's OLD SPACE. `--max-old-space-size` kills an ordinary
//     object-allocation loop in ~0.3s ("Reached heap limit", exit 133), but a TypedArray's backing
//     store is external to that heap, so `while(true) a.push(new Uint8Array(1e7))` is bounded by
//     the TIMEOUT, not the flag — it can chew host RAM for the whole window. Keep the timeout
//     short, and use `ulimit -v` or a container for anything beyond local single-user use.
//   - `Date.now()` / `Math.random()` work, so executions are not reproducible (re-execution, not
//     replay — see design-observability).
//   - Output is capped; a program that prints forever gets truncated, not obeyed.

export interface RunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  memoryMb?: number;
}

export interface RunResult {
  ok: boolean; // exited 0, in time, without being killed
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  ms: number;
}

const DEFAULTS = { timeoutMs: 5_000, maxOutputBytes: 64 * 1024, memoryMb: 128 };

/** Read a stream up to a byte cap, then stop reading (the writer gets EPIPE, which is the point:
 *  a program that prints forever is truncated rather than allowed to exhaust this process). */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > cap) {
        chunks.push(value.subarray(0, Math.max(0, cap - total)));
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // the child was killed mid-write; whatever we already have is the output
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  // Strip ANSI: Deno colours its error output, and those escapes would otherwise land verbatim in
  // a record and then in the model's context, where they are noise it has to reason around.
  const text = new TextDecoder().decode(joined).replace(/\x1b\[[0-9;]*m/g, "");
  return { text, truncated };
}

export async function runCode(source: string, opts: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs, maxOutputBytes, memoryMb } = { ...DEFAULTS, ...opts };
  const started = Date.now();
  const child = new Deno.Command("deno", {
    args: [
      "run",
      "--no-prompt", // a denied permission fails; it never waits for a human that isn't there
      "--no-remote", // `import("https://…")` cannot even be attempted
      "--quiet",
      "--ext=js", // stdin has no filename, so the dialect must be stated
      `--v8-flags=--max-old-space-size=${memoryMb}`,
      "-", // the program comes from stdin: no file needs to be readable
    ],
    // No --allow-* at all: net, read, write, env, run, ffi and sys are all denied.
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    // Deno itself needs a home for its module cache; nothing else is inherited, and the child
    // cannot read even this without --allow-env.
    clearEnv: true,
    env: { HOME: Deno.env.get("HOME") ?? "/tmp", PATH: "/usr/bin:/bin" },
  }).spawn();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, timeoutMs);

  try {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(source));
    await w.close();
  } catch { /* child exited before reading its program */ }

  const [out, err] = await Promise.all([
    readCapped(child.stdout, maxOutputBytes),
    readCapped(child.stderr, maxOutputBytes),
  ]);
  const status = await child.status;
  clearTimeout(timer);

  return {
    ok: status.success && !timedOut,
    stdout: out.text,
    stderr: err.text,
    exitCode: status.code,
    timedOut,
    truncated: out.truncated || err.truncated,
    ms: Date.now() - started,
  };
}
