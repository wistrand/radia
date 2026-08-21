// The browser entry point: boot a full space in a web page (agent_docs/plan-browser-space.md).
//
// The same runtime the server binary runs, composed for a host with no sockets and no files:
// PGlite for storage (its `idb://` filesystem is what makes the space survive a reload), the
// in-memory blob store, and `makeHandler` as the whole wire. There is no listening; the caller
// routes requests to the handler (the playground's fetch shim today, a Service Worker later).
//
// Bundled by `deno task bundle-browser` into `docs/playground/radia-space.js`, with
// `@electric-sql/pglite` left EXTERNAL: the page's import map resolves it to the vendored dist
// beside the bundle, so PGlite keeps loading its own wasm the way its loader expects.

import { setPlatformBackend } from "./platform.ts";
import { type BrowserBackendOptions, browserBackend } from "./platform_browser.ts";
import { Space, type SpaceContext } from "./core/space.ts";
import { PgliteAdapter } from "./storage/pglite.ts";
import { MemoryBlobStore } from "./storage/blobs.ts";
import { makeHandler } from "./server/http.ts";

export interface BrowserSpaceOptions {
  /** PGlite data directory. `idb://<name>` persists in IndexedDB; absent is in-memory. */
  db?: string;
  /** The HTML served at `GET /` (the console, if the caller wants one). */
  ui?: string;
  /** Default false: open mode, where the console's labeled operator button is the sign-in.
   *  A single-person browser space is the one deployment where that posture is the point. */
  authRequired?: boolean;
  ctx?: Partial<SpaceContext>;
  platform?: BrowserBackendOptions;
}

/** Boot the space and return its wire. The handler IS the server; `stop()` is a page's shutdown. */
export async function bootBrowserSpace(o: BrowserSpaceOptions = {}): Promise<{
  space: Space;
  handler: (req: Request) => Promise<Response>;
  operatorToken: string;
  stop: () => Promise<void>;
}> {
  setPlatformBackend(browserBackend(o.platform));
  const storage = new PgliteAdapter(o.db);
  await storage.init();
  const space = new Space(storage, o.ctx ?? {}, new MemoryBlobStore());
  await space.loadKinds(); // a persisted (idb://) space restores its declarations
  space.persistent = !!o.db; // an `idb://` space survives the tab; an in-memory one does not
  await space.markStarted();
  const operatorToken = await space.mintOperatorToken();
  const handler = makeHandler(space, o.ui ?? "<!doctype html><title>radia space</title>a radia space is running here", o.authRequired ?? false);
  return {
    space,
    handler,
    operatorToken,
    stop: () => storage.close(),
  };
}
