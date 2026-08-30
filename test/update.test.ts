// `radia update`, the self-replace verb (agent_docs/plan-self-update.md phase 1).
//
// The whole path runs against a loopback server serving a FAKE release, reusing `RADIA_BASE_URL`
// so the override has one name and two consumers (this and `docs/install.sh`). No network, no
// GitHub, and the binary being "replaced" is a file in a temp directory.
//
// The platform seam is injected rather than mocked at the module boundary: `setPlatformBackend`
// takes a Partial, so these cases replace exactly the four operations that would otherwise touch
// this developer's real binary (`execPath`, `isStandalone`, `buildTarget`, `runCapture`) and let
// the real file operations run against a temp directory. That is the point: the rename, the chmod
// and the temp-file placement are the parts worth exercising for real.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { setPlatformBackend, UsageError } from "../src/platform.ts";
import { runUpdate } from "../src/surfaces/update.ts";
import { VERSION } from "../src/version.ts";

const TARGET = "x86_64-unknown-linux-gnu";
const ASSET = `radia-${TARGET}.gz`;

const enc = new TextEncoder();

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Release {
  /** What the fake binary prints for `version`. */
  reports: string;
  /** Serve `latest/download` as a redirect naming this tag, the way GitHub does. */
  tag?: string;
  /** Corrupt the published digest, so the download cannot match it. */
  badChecksum?: boolean;
  /** Publish a SHA256SUMS that does not mention this target's asset. */
  omitAsset?: boolean;
}

/** A loopback server standing in for a GitHub release. Returns its base URL and a stop function. */
async function serveRelease(r: Release): Promise<{ base: string; stop: () => Promise<void> }> {
  const body = enc.encode(`#!/bin/sh\necho "radia ${r.reports}  api v0"\n`);
  const gz = await gzip(body);
  const digest = r.badChecksum ? "0".repeat(64) : await sha256Hex(gz);
  const sums = r.omitAsset ? `${digest}  radia-some-other-target.gz\n` : `${digest}  ${ASSET}\n`;

  const ac = new AbortController();
  const server = Deno.serve({ port: 0, signal: ac.signal, onListen: () => {} }, (req) => {
    const path = new URL(req.url).pathname;
    // GitHub answers `releases/latest/download/X` with a redirect to the tagged path, which is the
    // only way `--check` learns a version without an API call.
    if (r.tag && path === "/releases/latest/download/SHA256SUMS") {
      return new Response(null, { status: 302, headers: { location: `/releases/download/${r.tag}/SHA256SUMS` } });
    }
    if (path.endsWith("/SHA256SUMS")) return new Response(sums);
    if (path.endsWith(`/${ASSET}`)) return new Response(gz as BodyInit);
    return new Response("not found", { status: 404 });
  });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/releases/latest/download`;
  return {
    base,
    stop: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

/** A temp directory holding a file that stands in for the installed binary. */
function installedBinary(): { dir: string; path: string } {
  const dir = Deno.makeTempDirSync({ prefix: "radia-update-" });
  const path = join(dir, "radia");
  Deno.writeTextFileSync(path, "#!/bin/sh\necho 'radia 0.0.0  api v0'\n");
  Deno.chmodSync(path, 0o755);
  return { dir, path };
}

/**
 * Inject the four operations that would otherwise reach this developer's own installation.
 *
 * `runCapture` is faked rather than executing the downloaded file: the fake release's payload is a
 * shell script, and running it would test `/bin/sh` rather than this verb. What matters is that the
 * pre-flight HAPPENS and that its answer gates the rename, which the cases below assert directly.
 */
function inject(binary: string, probe: { code: number; stdout: string }) {
  setPlatformBackend({
    execPath: () => binary,
    isStandalone: () => true,
    buildTarget: () => TARGET,
    runCapture: () => Promise.resolve(probe),
  });
}

async function withRelease(r: Release, fn: (base: string) => Promise<void>) {
  const s = await serveRelease(r);
  const prev = Deno.env.get("RADIA_BASE_URL");
  Deno.env.set("RADIA_BASE_URL", s.base);
  try {
    await fn(s.base);
  } finally {
    if (prev === undefined) Deno.env.delete("RADIA_BASE_URL");
    else Deno.env.set("RADIA_BASE_URL", prev);
    await s.stop();
    // `setPlatformBackend` REPLACES the backend with `{...denoBackend, ...partial}`, so an empty
    // partial is a full restore. Without it every later test file in this process would inherit a
    // fake `execPath`, which is the worst kind of leak: silent, and only in the suite.
    setPlatformBackend({});
  }
}

Deno.test("update: replaces the binary in place after the pre-flight passes", async () => {
  const { dir, path } = installedBinary();
  inject(path, { code: 0, stdout: "radia 2099.1.0  api v0" });
  await withRelease({ reports: "2099.1.0", tag: "v2099.1.0" }, async () => {
    const r = await runUpdate({ check: false });
    assertEquals(r.code, 0);
    assert(r.lines[0].includes("2099.1.0"), `expected the new version in ${JSON.stringify(r.lines)}`);
    // The REAL rename ran: the file on disk is now the release payload, not the placeholder.
    assert(Deno.readTextFileSync(path).includes("radia 2099.1.0"), "the binary was not replaced");
    assert((Deno.statSync(path).mode! & 0o111) !== 0, "the replacement is not executable");
    // Nothing left beside it. A temp file that survives is a temp file in everyone's PATH directory.
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ["radia"]);
  });
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("update: a checksum that does not match leaves the binary alone", async () => {
  const { dir, path } = installedBinary();
  const before = Deno.readTextFileSync(path);
  inject(path, { code: 0, stdout: "radia 2099.1.0  api v0" });
  await withRelease({ reports: "2099.1.0", tag: "v2099.1.0", badChecksum: true }, async () => {
    const e = await assertRejects(() => runUpdate({ check: false }), UsageError);
    assert(e.message.includes("checksum mismatch"), e.message);
  });
  assertEquals(Deno.readTextFileSync(path), before, "a failed verification still replaced the binary");
  assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ["radia"], "the temp file outlived the failure");
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("update: a SHA256SUMS that does not list this asset is a refusal, not a skip", async () => {
  const { dir, path } = installedBinary();
  const before = Deno.readTextFileSync(path);
  inject(path, { code: 0, stdout: "radia 2099.1.0  api v0" });
  await withRelease({ reports: "2099.1.0", tag: "v2099.1.0", omitAsset: true }, async () => {
    const e = await assertRejects(() => runUpdate({ check: false }), UsageError);
    assert(e.message.includes("does not list"), e.message);
  });
  assertEquals(Deno.readTextFileSync(path), before);
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("update: a failed pre-flight leaves the binary alone", async () => {
  const { dir, path } = installedBinary();
  const before = Deno.readTextFileSync(path);
  // The shape of a wrong-architecture download: it verifies, it unpacks, and it cannot run.
  inject(path, { code: 126, stdout: "" });
  await withRelease({ reports: "2099.1.0", tag: "v2099.1.0" }, async () => {
    const e = await assertRejects(() => runUpdate({ check: false }), UsageError);
    assert(e.message.includes("does not run on this machine"), e.message);
  });
  assertEquals(Deno.readTextFileSync(path), before);
  assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ["radia"]);
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("update: a binary reporting a different version than the release is refused", async () => {
  const { dir, path } = installedBinary();
  const before = Deno.readTextFileSync(path);
  inject(path, { code: 0, stdout: "radia 1999.1.0  api v0" });
  await withRelease({ reports: "2099.1.0", tag: "v2099.1.0" }, async () => {
    const e = await assertRejects(() => runUpdate({ check: false }), UsageError);
    assert(e.message.includes("rather than v2099.1.0"), e.message);
  });
  assertEquals(Deno.readTextFileSync(path), before);
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("update --check: reports without touching anything, and exits 1 when newer", async () => {
  const { dir, path } = installedBinary();
  const before = Deno.readTextFileSync(path);
  inject(path, { code: 0, stdout: "radia 2099.1.0  api v0" });
  await withRelease({ reports: "2099.1.0", tag: "v2099.1.0" }, async () => {
    const r = await runUpdate({ check: true });
    assertEquals(r.code, 1, "an available update has to be distinguishable in a script");
    assert(r.lines[0].includes("v2099.1.0"), r.lines.join("\n"));
  });
  assertEquals(Deno.readTextFileSync(path), before);
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("update: a release that is not newer is current, and --check exits 0", async () => {
  const { dir, path } = installedBinary();
  inject(path, { code: 0, stdout: `radia ${VERSION}  api v0` });
  // The tag GitHub would redirect to IS this build's version, which is the ordinary case.
  await withRelease({ reports: VERSION, tag: `v${VERSION}` }, async () => {
    for (const check of [true, false]) {
      const r = await runUpdate({ check });
      assertEquals(r.code, 0);
      assert(r.lines[0].includes("is current"), r.lines.join("\n"));
    }
  });
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("update: running from a checkout refuses, because execPath names deno there", async () => {
  setPlatformBackend({ isStandalone: () => false });
  try {
    const e = await assertRejects(() => runUpdate({ check: false }), UsageError);
    assert(e.message.includes("running from a checkout"), e.message);
  } finally {
    setPlatformBackend({});
  }
});
