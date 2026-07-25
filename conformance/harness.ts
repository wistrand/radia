// The conformance harness. It registers every (adapter x suite) pair as a Deno.test, so
// a behavior is only "done" when it passes on EVERY registered adapter. This is the
// standing guard against storage-adapter drift (CLAUDE.md invariant). Running two
// adapters from the first commit is what keeps that guard real rather than aspirational.

import type { StorageAdapter } from "../src/storage/adapter.ts";
import type { BlobStore } from "../src/storage/blobs.ts";

export interface AdapterFactory {
  name: string;
  create: () => StorageAdapter;
}

export interface Suite {
  name: string;
  /** Receives a freshly init()'d adapter; the harness closes it afterward. */
  run: (adapter: StorageAdapter) => Promise<void>;
}

export function conformance(factories: AdapterFactory[], suites: Suite[]): void {
  for (const f of factories) {
    for (const s of suites) {
      Deno.test(`[${f.name}] ${s.name}`, async () => {
        const adapter = f.create();
        await adapter.init();
        try {
          await s.run(adapter);
        } finally {
          await adapter.close();
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Blob port
//
// Artifact bytes live behind a SECOND port (src/storage/blobs.ts), so it gets the same
// treatment as the record store: every implementation runs the same suite, from the first
// commit, or the in-memory and filesystem paths drift the way embedded/hosted would.
// ---------------------------------------------------------------------------

export interface BlobFactory {
  name: string;
  create: () => BlobStore;
}

export interface BlobSuite {
  name: string;
  run: (store: BlobStore) => Promise<void>;
}

export function blobConformance(factories: BlobFactory[], suites: BlobSuite[]): void {
  for (const f of factories) {
    for (const s of suites) {
      Deno.test(`[blobs:${f.name}] ${s.name}`, async () => {
        await s.run(f.create());
      });
    }
  }
}
