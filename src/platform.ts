// The platform seam: every non-portable host operation the runtime performs, in one file.
//
// Why this exists. The CLAUDE.md invariant is *maximal platform independence*: the code should
// be portable across runtimes, not bound to one. Scattering `Deno.exit`, `Deno.env.get`, and
// `Deno.readTextFileSync` through `src/` binds every module to Deno for operations every runtime
// has. Behind this seam, porting to Node or Bun means reimplementing THIS FILE and nothing else.
//
// The seam is INJECTABLE: the exported functions delegate to a backend object whose default is
// the Deno implementation below, and `setPlatformBackend` swaps it for another host. That is how
// the browser build works (`src/platform_browser.ts` + `src/browser.ts`,
// agent_docs/plan-browser-space.md): same modules, one object injected at boot, no bundler alias.
// The Deno bodies only touch `Deno.*` inside methods, so importing this file on a host without
// Deno is safe until an un-replaced operation is actually called.
//
// What is deliberately NOT here, and why:
//   - `Deno.test` in `conformance/harness.ts`: a test-runner binding, not a runtime operation.
//     A port swaps the harness, not the suites.
//   - `Deno.connect` in `src/storage/postgres.ts`: it patches the *driver's* socket layer to
//     set TCP_NODELAY, which only makes sense against deno-postgres. It is adapter-local by
//     nature and documented at the call site.
//   - `examples/`: those are SDK-only by design (they import nothing from `src/`), so they
//     model what an external agent author writes. They are Deno scripts by construction.
//
// Style rule for the rest of `src/`: never reach for `Deno.*` directly. If something is missing
// here, add it here. Named "platform" rather than "host" because `host` already means *hostname*
// in the server code.

/** Thrown for bad CLI input. The entry point turns it into a message plus exit code 2; nothing
 *  else in `src/` should exit on its own. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ServeOptions {
  port: number;
  hostname: string;
  /** Abort to stop accepting and resolve `finished`. */
  signal?: AbortSignal;
}

/** Every host operation the runtime performs. One method per exported delegate below; the
 *  delegates carry the contracts, the backend carries the host. */
export interface PlatformBackend {
  args(): string[];
  exit(code: number): never;
  env(name: string): string | undefined;
  osName(): string;
  readTextFile(path: string | URL): string | undefined;
  writeTextFile(path: string, text: string): void;
  mkdirp(path: string): void;
  removeFile(path: string): void;
  restrictToOwner(path: string): void;
  writeBinaryFile(path: string, bytes: Uint8Array): Promise<void>;
  renameFile(from: string, to: string): void;
  fileSize(path: string): number | undefined;
  fileMtimeMs(path: string): number | undefined;
  touchFile(path: string): void;
  listDirNames(path: string): string[];
  readBinaryFile(path: string): Promise<Uint8Array | undefined>;
  readBinaryStream(path: string): Promise<ReadableStream<Uint8Array> | undefined>;
  stdin(): ReadableStream<Uint8Array>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  onShutdown(handler: () => void): () => void;
  serve(opts: ServeOptions, handler: (req: Request) => Response | Promise<Response>): { finished: Promise<void> };
  httpGetJson(url: string): Promise<unknown>;
}

const encoder = new TextEncoder();

/** The default host. `Deno.*` appears only inside method bodies, never at module load. */
const denoBackend: PlatformBackend = {
  args: () => Deno.args,
  exit: (code) => Deno.exit(code),
  env: (name) => {
    try {
      return Deno.env.get(name);
    } catch {
      return undefined;
    }
  },
  osName: () => Deno.build.os,
  readTextFile: (path) => {
    try {
      return Deno.readTextFileSync(path);
    } catch {
      return undefined;
    }
  },
  writeTextFile: (path, text) => Deno.writeTextFileSync(path, text),
  mkdirp: (path) => Deno.mkdirSync(path, { recursive: true }),
  removeFile: (path) => {
    try {
      Deno.removeSync(path);
    } catch { /* already gone */ }
  },
  restrictToOwner: (path) => {
    if (Deno.build.os === "windows") return;
    try {
      Deno.chmodSync(path, 0o600);
    } catch { /* best-effort hardening; the caller already handled the write */ }
  },
  writeBinaryFile: async (path, bytes) => {
    await Deno.writeFile(path, bytes);
  },
  renameFile: (from, to) => Deno.renameSync(from, to),
  fileSize: (path) => {
    try {
      const st = Deno.statSync(path);
      return st.isFile ? st.size : undefined;
    } catch {
      return undefined;
    }
  },
  fileMtimeMs: (path) => {
    try {
      const st = Deno.statSync(path);
      return st.isFile ? st.mtime?.getTime() : undefined;
    } catch {
      return undefined;
    }
  },
  touchFile: (path) => {
    try {
      const now = new Date();
      Deno.utimeSync(path, now, now);
    } catch { /* absent or read-only: the caller's next check answers honestly */ }
  },
  listDirNames: (path) => {
    try {
      const out: string[] = [];
      for (const e of Deno.readDirSync(path)) out.push(e.name);
      return out;
    } catch {
      return [];
    }
  },
  readBinaryFile: async (path) => {
    try {
      return await Deno.readFile(path);
    } catch {
      return undefined;
    }
  },
  readBinaryStream: async (path) => {
    try {
      const file = await Deno.open(path, { read: true });
      return file.readable;
    } catch {
      return undefined;
    }
  },
  stdin: () => Deno.stdin.readable,
  writeStdout: (text) => {
    Deno.stdout.writeSync(encoder.encode(text));
  },
  writeStderr: (text) => {
    Deno.stderr.writeSync(encoder.encode(text));
  },
  onShutdown: (handler) => {
    const signals: Deno.Signal[] = Deno.build.os === "windows" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
    for (const sig of signals) Deno.addSignalListener(sig, handler);
    return () => {
      for (const sig of signals) Deno.removeSignalListener(sig, handler);
    };
  },
  serve: (opts, handler) => {
    const server = Deno.serve({ ...opts, onListen: () => {} }, handler);
    return { finished: server.finished };
  },
  // Portable already (fetch is universal); lives in the backend so a host can still swap it.
  httpGetJson: async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    try {
      if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
      return await res.json();
    } finally {
      if (res.bodyUsed === false) await res.body?.cancel();
    }
  },
};

let backend: PlatformBackend = denoBackend;

/** Swap the host. Partial: unnamed operations keep the Deno defaults, which is safe because
 *  those defaults touch `Deno.*` only when called. Call once, at an entry point, before any
 *  runtime module does host work; this is boot wiring, not a runtime feature. */
export function setPlatformBackend(b: Partial<PlatformBackend>): void {
  backend = { ...denoBackend, ...b };
}

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

/** Command-line arguments, excluding the program name. */
export function args(): string[] {
  return backend.args();
}

/**
 * Terminate the process. Call this ONLY from a top-level entry point. A function deep in a
 * module that exits denies its caller any chance to clean up, and makes the function untestable.
 * Everywhere else, return a status or throw `UsageError`.
 */
export function exit(code: number): never {
  return backend.exit(code);
}

/** An environment variable, or undefined (including when the permission is not granted), so a
 *  worker running without `--allow-env` degrades to defaults instead of crashing. */
export function env(name: string): string | undefined {
  return backend.env(name);
}

/** Host OS: "linux" | "darwin" | "windows" | "browser" | … Used for path and permission
 *  conventions. */
export function osName(): string {
  return backend.osName();
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
  return backend.readTextFile(path);
}

/** Write a file, creating parent directories. Throws on failure. Callers decide what that means. */
export function writeTextFile(path: string, text: string): void {
  backend.writeTextFile(path, text);
}

export function mkdirp(path: string): void {
  backend.mkdirp(path);
}

/** Delete a file. Missing is not an error. The goal is "gone", and it is. */
export function removeFile(path: string): void {
  backend.removeFile(path);
}

/** Restrict a file to its owner. A no-op where the platform has no POSIX mode (Windows), where
 *  per-user directory ACLs are the protection instead. */
export function restrictToOwner(path: string): void {
  backend.restrictToOwner(path);
}

/** Resolve a path relative to a module URL. This is how bundled assets are located both from
 *  source and inside a compiled binary. Pure, so it lives outside the backend. */
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

/** Write bytes to a path, creating parent directories. Overwrites. NOT atomic: a crash partway
 *  leaves a truncated file at `path`. Anything content-addressed wants `renameFile` instead. */
export function writeBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
  return backend.writeBinaryFile(path, bytes);
}

/** Move `from` onto `to`, replacing it. A same-filesystem rename is atomic on POSIX and on Windows,
 *  which is the whole point: write to a temp name and rename, and readers see the old file or the
 *  new one, never half of either. */
export function renameFile(from: string, to: string): void {
  backend.renameFile(from, to);
}

/** A path's byte size, or undefined if it does not exist. */
export function fileSize(path: string): number | undefined {
  return backend.fileSize(path);
}

/** The file's mtime in epoch ms, or undefined. Blob GC's grace window reads it: mtimes are
 *  HOST-clock data, so the comparison partner is the host clock too, never the DB clock. */
export function fileMtimeMs(path: string): number | undefined {
  return backend.fileMtimeMs(path);
}

/** Bump a file's mtime to now. A deduped blob `put` calls this so the grace window in
 *  `retainOnly` treats the payload as freshly wanted; missing is not an error. */
export function touchFile(path: string): void {
  backend.touchFile(path);
}

/** Entry names directly under `path` (files and directories alike); [] when it does not exist. */
export function listDirNames(path: string): string[] {
  return backend.listDirNames(path);
}

/** A file's bytes, or undefined if it does not exist. Used where the whole payload is needed at
 *  once (an encrypted blob: AES-GCM verifies its tag over the complete ciphertext). */
export function readBinaryFile(path: string): Promise<Uint8Array | undefined> {
  return backend.readBinaryFile(path);
}

/** Stream a file's bytes, or undefined if it does not exist. The caller owns the stream and
 *  cancelling it closes the underlying handle. */
export function readBinaryStream(path: string): Promise<ReadableStream<Uint8Array> | undefined> {
  return backend.readBinaryStream(path);
}

// ---------------------------------------------------------------------------
// Standard streams
// ---------------------------------------------------------------------------

/** stdin as a byte stream (the MCP adapter's JSON-RPC transport, and `radia ack -`). */
export function stdin(): ReadableStream<Uint8Array> {
  return backend.stdin();
}

/** Write to stdout synchronously. Sync matters for the MCP transport: two interleaved async
 *  writes would corrupt the frame stream. */
export function writeStdout(text: string): void {
  backend.writeStdout(text);
}

export function writeStderr(text: string): void {
  backend.writeStderr(text);
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/**
 * Run `handler` on an interrupt or termination signal; returns an unsubscribe function.
 *
 * Without this, a SIGTERM kills the process before any `finally` runs, and the provisioned
 * credential outlives the space that minted it, 401ing the next command. SIGTERM does not
 * exist on Windows; SIGINT does, so the set is platform-dependent.
 */
export function onShutdown(handler: () => void): () => void {
  return backend.onShutdown(handler);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

/** Serve HTTP. Narrowed to what the runtime uses, so a port implements this signature rather
 *  than all of `Deno.serve`. `onListen` is suppressed. Startup logging is the caller's. */
export function serve(
  opts: ServeOptions,
  handler: (req: Request) => Response | Promise<Response>,
): { finished: Promise<void> } {
  return backend.serve(opts, handler);
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

/** GET a JSON document. The runtime's ONLY outbound HTTP, added for OIDC's JWKS/discovery
 *  fetches; narrowed to a single verb and a single content shape on purpose. The 10s timeout is
 *  load-bearing: this is called while an unauthenticated request waits, so a hung IdP must fail
 *  the sign-in rather than pin a handler. */
export function httpGetJson(url: string): Promise<unknown> {
  return backend.httpGetJson(url);
}
