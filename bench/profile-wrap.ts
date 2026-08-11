// The target side of `bench/profile.ts`: import the script under profile, then HOLD the process
// so the controller can stop the profiler and collect. Without this hold, the process exits the
// moment the script finishes and the CPU profile dies with it — the tail of the run (often the
// part being investigated) is exactly what gets lost.
//
// The script runs via dynamic import, so `import.meta.main` is false inside it; scripts gated on
// it will not run under the profiler (bench/run.ts and friends are top-level and fine).

const [script, ...rest] = Deno.args;
if (!script) {
  console.error("profile-wrap: no script given");
  Deno.exit(2);
}
// Give the script its own view of Deno.args (best-effort: the namespace is a plain object).
try {
  Object.defineProperty(Deno, "args", { value: rest, configurable: true });
} catch { /* flag-scanning scripts tolerate the extra leading token */ }

await import(new URL(script, `file://${Deno.cwd()}/`).href);

// The marker the controller watches for, then an idle heartbeat it will kill.
console.log("PROFILE_WRAP_DONE");
setInterval(() => {}, 1 << 30);
