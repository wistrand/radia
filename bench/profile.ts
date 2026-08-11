// CPU-profile a Deno workload with no external tooling: no perf, no Chrome, no node.
//
//   deno task profile bench/run.ts --suite records --adapter sqlite
//   deno task profile --out claims bench/run.ts --suite take-ack
//
// The machine this project develops on has no `perf` (and perf_event_paranoid=2), so the
// profiler is V8's own sampler driven over the Chrome DevTools Protocol: the target runs under
// `--inspect-brk`, this controller speaks raw WebSocket CDP (Profiler.start / stop), and the
// result is a standard `.cpuprofile` — load it in Chrome DevTools (Performance > Load) or
// speedscope, or read the top-self-time table this prints.
//
// The target runs through `profile-wrap.ts`, which imports the script and then HOLDS the
// process: a profile cannot be stopped in a process that already exited, and the tail of a run
// is usually the part under investigation. The wrapper prints PROFILE_WRAP_DONE; this controller
// stops the profiler, writes the file, and kills the child. Consequence of the dynamic import:
// `import.meta.main` is false inside the profiled script.

const args = [...Deno.args];
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const [, v] = args.splice(i, 2);
  return v;
}
const outName = flag("out");
const intervalUs = Number(flag("interval") ?? "100");
const [script, ...scriptArgs] = args;
if (!script) {
  console.error("usage: deno task profile [--out name] [--interval µs] <script> [args…]");
  Deno.exit(2);
}

const port = 9230 + Math.floor(Math.random() * 400);
const child = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", `--inspect-brk=127.0.0.1:${port}`, new URL("./profile-wrap.ts", import.meta.url).pathname, script, ...scriptArgs],
  stdout: "piped",
  stderr: "inherit", // "Debugger listening on …" and the workload's own noise go to the terminal
}).spawn();

// Pass the workload's stdout through while watching for the wrapper's completion marker.
let done!: () => void;
const finished = new Promise<void>((r) => (done = r));
(async () => {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of child.stdout) {
    const text = dec.decode(chunk);
    buf += text;
    // Strip the marker from what the person sees; everything else passes through untouched.
    await Deno.stdout.write(new TextEncoder().encode(text.replace(/^PROFILE_WRAP_DONE\n?$/m, "")));
    if (buf.includes("PROFILE_WRAP_DONE")) done();
    if (buf.length > 65536) buf = buf.slice(-1024);
  }
  done(); // stdout closed without the marker: the script crashed; stop with what we have
})();

// The inspector needs a beat to come up; then CDP over a raw WebSocket.
const wsUrl = await (async () => {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await r.json() as { webSocketDebuggerUrl?: string }[];
      const url = targets[0]?.webSocketDebuggerUrl;
      if (url) return url;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("inspector never came up");
})();

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let nextId = 1;
const pending = new Map<number, (v: unknown) => void>();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg.result);
    pending.delete(msg.id);
  }
};
function cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await cdp("Runtime.enable");
await cdp("Profiler.enable");
await cdp("Profiler.setSamplingInterval", { interval: intervalUs });
await cdp("Profiler.start");
const t0 = performance.now();
await cdp("Runtime.runIfWaitingForDebugger"); // release the --inspect-brk pause: the run starts NOW

await finished;
const { profile } = await cdp("Profiler.stop") as {
  profile: {
    nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number; children?: number[] }[];
    samples?: number[];
    timeDeltas?: number[];
  };
};
const wallMs = performance.now() - t0;
ws.close();
child.kill("SIGKILL");
await child.status;

const stem = outName ?? (script.split("/").pop() ?? "profile").replace(/\.ts$/, "");
const cpuPath = `bench/${stem}.cpuprofile`;
await Deno.writeTextFile(cpuPath, JSON.stringify(profile));

// ---- in-terminal analysis: self time per function, and the hottest stacks (folded) ----
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map<number, number>();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const totalHits = profile.nodes.reduce((s, n) => s + (n.hitCount ?? 0), 0) || 1;
const frameName = (n: { callFrame: { functionName: string; url: string; lineNumber: number } }) => {
  const fn = n.callFrame.functionName || "(anonymous)";
  const file = n.callFrame.url.split("/").slice(-2).join("/");
  return file ? `${fn} ${file}:${n.callFrame.lineNumber + 1}` : fn;
};

const bySelf = new Map<string, number>();
for (const n of profile.nodes) {
  if (!n.hitCount) continue;
  const k = frameName(n);
  bySelf.set(k, (bySelf.get(k) ?? 0) + n.hitCount);
}
const top = [...bySelf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

const folded = new Map<string, number>();
for (const n of profile.nodes) {
  if (!n.hitCount) continue;
  const stack: string[] = [];
  for (let id: number | undefined = n.id; id !== undefined; id = parent.get(id)) {
    const f = nodes.get(id)!;
    if (f.callFrame.functionName === "(root)") break;
    stack.unshift(frameName(f));
  }
  const key = stack.join(";") || "(root)";
  folded.set(key, (folded.get(key) ?? 0) + n.hitCount);
}
const foldedPath = `bench/${stem}.folded`;
await Deno.writeTextFile(foldedPath, [...folded.entries()].map(([s, w]) => `${s} ${w}`).join("\n") + "\n");

console.log(`\nprofiled ${(wallMs / 1000).toFixed(1)}s of wall clock, ${totalHits} samples @ ${intervalUs}µs`);
console.log(`  ${cpuPath}   (Chrome DevTools Performance > Load, or speedscope)`);
console.log(`  ${foldedPath}   (flamegraph.pl-compatible folded stacks)`);
console.log(`\ntop self time:`);
for (const [name, hits] of top) {
  console.log(`  ${((hits / totalHits) * 100).toFixed(1).padStart(5)}%  ${name}`);
}