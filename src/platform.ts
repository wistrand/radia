// The platform seam: every non-portable host operation the runtime performs, in one file.
//
// Why this exists. The CLAUDE.md invariant is *maximal platform independence* — the code should
// be portable across runtimes, not bound to one. Scattering `Deno.exit`, `Deno.env.get`, and
// `Deno.readTextFileSync` through `src/` binds every module to Deno for operations every runtime
// has. Behind this seam, porting to Node or Bun means reimplementing THIS FILE and nothing else.
//
// What is deliberately NOT here, and why:
//   - `Deno.test` in `conformance/harness.ts` — a test-runner binding, not a runtime operation.
//     A port swaps the harness, not the suites.
//   - `Deno.connect` in `src/storage/postgres.ts` — that patches the *driver's* socket layer to
//     set TCP_NODELAY, which only makes sense against deno-postgres. It is adapter-local by
//     nature and documented at the call site.
//   - `examples/` — those are SDK-only by design (they import nothing from `src/`), so they
//     model what an external agent author writes. They are Deno scripts by construction.
//
// Style rule for the rest of `src/`: never reach for `Deno.*` directly. If something is missing
// here, add it here. Named "platform" rather than "host" because `host` already means *hostname*
// in the server code.

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

/** Command-line arguments, excluding the program name. */
export function args(): string[] {
  return Deno.args;
}

/**
 * Terminate the process. Call this ONLY from a top-level entry point — a function deep in a
 * module that exits denies its caller any chance to clean up, and makes the function untestable.
 * Everywhere else, return a status or throw `UsageError`.
 */
export function exit(code: number): never {
  Deno.exit(code);
}

/** An environment variable, or undefined — including when the permission is not granted, so a
 *  worker running without `--allow-env` degrades to defaults instead of crashing. */
export function env(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** Host OS: "linux" | "darwin" | "windows" | … Used for path and permission conventions. */
export function osName(): string {
  return Deno.build.os;
}

/** Thrown for bad CLI input. The entry point turns it into a message plus exit code 2; nothing
 *  else in `src/` should exit on its own. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

// ---------------------------------------------------------------------------
// Files
//
// Sync throughout: radia's file I/O is startup- and config-scale (the console asset, the
// credential file), never on a request path, and sync keeps the call sites free of async
// colouring they would otherwise spread.
// ---------------------------------------------------------------------------

/** File contents, or undefined if it does not exist / cannot be read. Callers all treat a
 *  missing file as "no value", so an exception would only be caught and discarded. */
export function readTextFile(path: string | URL): string | undefined {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return undefined;
  }
}

/** Write a file, creating parent directories. Throws on failure — callers decide what that means. */
export function writeTextFile(path: string, text: string): void {
  Deno.writeTextFileSync(path, text);
}

export function mkdirp(path: string): void {
  Deno.mkdirSync(path, { recursive: true });
}

/** Delete a file. Missing is not an error — the goal is "gone", and it is. */
export function removeFile(path: string): void {
  try {
    Deno.removeSync(path);
  } catch { /* already gone */ }
}

/** Restrict a file to its owner. A no-op where the platform has no POSIX mode (Windows), where
 *  per-user directory ACLs are the protection instead. */
export function restrictToOwner(path: string): void {
  if (osName() === "windows") return;
  try {
    Deno.chmodSync(path, 0o600);
  } catch { /* best-effort hardening; the caller already handled the write */ }
}

/** Resolve a path relative to a module URL — how bundled assets are located both from source
 *  and inside a compiled binary. */
export function moduleRelative(url: string, path: string): URL {
  return new URL(path, url);
}

// ---------------------------------------------------------------------------
// Binary files (artifact blobs)
//
// The ONLY async, request-path file I/O in the seam, and the exception to the sync rule
// above: artifact bytes can be megabytes and are read while serving a request. Downloads
// stream (never materialize a blob in memory); writes take a whole buffer, because the
// upload is size-capped before it reaches here and Web Crypto has no incremental digest,
// so the bytes are held once either way.
// ---------------------------------------------------------------------------

/** Write bytes to a path, creating parent directories. Overwrites. */
export async function writeBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
  await Deno.writeFile(path, bytes);
}

/** A path's byte size, or undefined if it does not exist. */
export function fileSize(path: string): number | undefined {
  try {
    const st = Deno.statSync(path);
    return st.isFile ? st.size : undefined;
  } catch {
    return undefined;
  }
}

/** A file's bytes, or undefined if it does not exist. Used where the whole payload is needed at
 *  once (an encrypted blob: AES-GCM verifies its tag over the complete ciphertext). */
export async function readBinaryFile(path: string): Promise<Uint8Array | undefined> {
  try {
    return await Deno.readFile(path);
  } catch {
    return undefined;
  }
}

/** Stream a file's bytes, or undefined if it does not exist. The caller owns the stream and
 *  cancelling it closes the underlying handle. */
export async function readBinaryStream(path: string): Promise<ReadableStream<Uint8Array> | undefined> {
  try {
    const file = await Deno.open(path, { read: true });
    return file.readable;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Standard streams
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** stdin as a byte stream (the MCP adapter's JSON-RPC transport, and `radia ack -`). */
export function stdin(): ReadableStream<Uint8Array> {
  return Deno.stdin.readable;
}

/** Write to stdout synchronously. Sync matters for the MCP transport: two interleaved async
 *  writes would corrupt the frame stream. */
export function writeStdout(text: string): void {
  Deno.stdout.writeSync(encoder.encode(text));
}

export function writeStderr(text: string): void {
  Deno.stderr.writeSync(encoder.encode(text));
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/**
 * Run `handler` on an interrupt or termination signal; returns an unsubscribe function.
 *
 * Without this, a SIGTERM kills the process before any `finally` runs, and the provisioned
 * credential outlives the space that minted it — 401ing the next command. SIGTERM does not
 * exist on Windows; SIGINT does, so the set is platform-dependent.
 */
export function onShutdown(handler: () => void): () => void {
  const signals: Deno.Signal[] = osName() === "windows" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
  for (const sig of signals) Deno.addSignalListener(sig, handler);
  return () => {
    for (const sig of signals) Deno.removeSignalListener(sig, handler);
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export interface ServeOptions {
  port: number;
  hostname: string;
  /** Abort to stop accepting and resolve `finished`. */
  signal?: AbortSignal;
}

/** Serve HTTP. Narrowed to what the runtime uses, so a port implements this signature rather
 *  than all of `Deno.serve`. `onListen` is suppressed — startup logging is the caller's. */
export function serve(
  opts: ServeOptions,
  handler: (req: Request) => Response | Promise<Response>,
): { finished: Promise<void> } {
  const server = Deno.serve({ ...opts, onListen: () => {} }, handler);
  return { finished: server.finished };
}
