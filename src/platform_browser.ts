// The browser host: a `PlatformBackend` built from Web APIs alone (agent_docs/plan-browser-space.md).
//
// Nothing here touches `Deno.*`, and nothing in `src/` imports this file: only the browser entry
// (`src/browser.ts`) wires it in via `setPlatformBackend`, so every other host pays nothing.
//
// What the runtime actually asks a browser for is small: the credential file, the seal key and
// the KEK are the only "files" (startup-scale, text), so they live in localStorage when it exists
// and in a Map when it does not (workers, and Deno test runs of the built bundle, have no
// localStorage). Binary file ops exist only for `FileBlobStore`, which a browser space does not
// use (blobs stay in memory or, later, IndexedDB); they get the in-memory Map so nothing throws.

import type { PlatformBackend, ServeOptions } from "./platform.ts";

export interface BrowserBackendOptions {
  /** Environment for `env()` lookups (`RADIA_DIR` etc.). Empty by default: the browser has no
   *  ambient environment, and defaults handle absence everywhere. */
  env?: Record<string, string>;
  /** localStorage key prefix for the runtime's small text files. */
  storagePrefix?: string;
}

export function browserBackend(opts: BrowserBackendOptions = {}): Partial<PlatformBackend> {
  const prefix = opts.storagePrefix ?? "radia.fs:";
  // localStorage throws on access in some contexts (opaque origins, permissionless Deno), so the
  // probe is a try, and the fallback is process-lifetime memory.
  const store: Storage | undefined = (() => {
    try {
      const s = (globalThis as { localStorage?: Storage }).localStorage;
      s?.getItem(prefix); // a read that throws now rather than later
      return s;
    } catch {
      return undefined;
    }
  })();
  const textFallback = new Map<string, string>();
  const bin = new Map<string, Uint8Array>();
  const k = (path: string | URL) => String(path);

  const readText = (path: string | URL): string | undefined =>
    store?.getItem(prefix + k(path)) ?? textFallback.get(k(path));
  const writeText = (path: string, text: string): void => {
    if (store) store.setItem(prefix + path, text);
    else textFallback.set(path, text);
  };

  return {
    args: () => [],
    exit: (code) => {
      // A page has no process to end; surfacing the attempt beats pretending one ended.
      throw new Error(`exit(${code}) called in a browser host`);
    },
    env: (name) => opts.env?.[name],
    osName: () => "browser",
    readTextFile: readText,
    writeTextFile: writeText,
    withFileLockSync: (_path, fn) => fn(), // one tab, one writer: nothing to lock against
    appendTextFile: (path, text) => writeText(path, (readText(path) ?? "") + text),
    mkdirp: () => {},
    removeFile: (path) => {
      store?.removeItem(prefix + path);
      textFallback.delete(path);
    },
    restrictToOwner: () => {}, // the browser profile IS the owner boundary
    writeBinaryFile: (path, bytes) => {
      bin.set(path, bytes);
      return Promise.resolve();
    },
    renameFile: (from, to) => {
      const v = bin.get(from);
      if (v !== undefined) {
        bin.set(to, v);
        bin.delete(from);
      }
    },
    fileSize: (path) => bin.get(path)?.byteLength,
    fileMtimeMs: () => undefined,
    touchFile: () => {},
    listDirNames: () => [],
    readBinaryFile: (path) => Promise.resolve(bin.get(path)),
    readBinaryStream: (path) => {
      const v = bin.get(path);
      if (v === undefined) return Promise.resolve(undefined);
      return Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(v);
            c.close();
          },
        }),
      );
    },
    stdin: () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.close(); // no terminal: an empty, closed stream, not a hang
        },
      }),
    writeStdout: (text) => console.log(text.replace(/\n$/, "")),
    stdoutIsTerminal: () => false,
    consoleColumns: () => undefined,
    writeStderr: (text) => console.error(text.replace(/\n$/, "")),
    onShutdown: (handler) => {
      // `pagehide` is the closest thing a page has to SIGTERM. Best effort by nature: the
      // runtime already treats shutdown cleanup as best effort on every host.
      const target = globalThis as unknown as { addEventListener?: typeof addEventListener; removeEventListener?: typeof removeEventListener };
      if (!target.addEventListener) return () => {};
      const fn = () => handler();
      target.addEventListener("pagehide", fn);
      return () => target.removeEventListener?.("pagehide", fn);
    },
    serve: (_opts: ServeOptions) => {
      // Deliberate: the browser build's wire is `makeHandler` called directly (a fetch shim or a
      // Service Worker); a listening socket does not exist here and must not appear to.
      throw new Error("no HTTP server in a browser host: call makeHandler directly");
    },
  };
}
