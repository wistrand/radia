// `radia update`: replace THIS binary with a release build.
//
// Phase 1 of agent_docs/plan-self-update.md. Checksum verification only; the SIGNATURE is designed
// there and deferred, on a checked finding rather than on effort (radia.sh, the release assets and
// any signing key all sit under one GitHub trust root, so a signature adds nothing against the
// party it is normally sold against). The asset names and the `SHA256SUMS` handling here are the
// same contract `docs/install.sh` reads, and `test/docs.test.ts` holds the three files to it.
//
// Three rules are inherited from that installer, each with a failure behind it:
//   - Run the downloaded binary BEFORE the rename. A wrong-architecture build then fails as a file
//     in a directory rather than as the `radia` on someone's PATH that exits 126 forever.
//   - Write the temp file in the TARGET directory. `/tmp` is usually another mount and `rename`
//     across filesystems fails `EXDEV`, which would turn an atomic replace into a copy.
//   - Never elevate. An unwritable destination prints the install line, never `sudo`.
//
// It contacts no space, holds no credential and imports nothing from `src/core`; like
// `radia credentials`, it is a verb about this MACHINE.

import { dirname, join } from "@std/path";
import { VERSION } from "../version.ts";
import {
  buildTarget,
  env,
  execPath,
  httpRequest,
  isStandalone,
  makeExecutable,
  pid,
  realPath,
  removeFile,
  renameFile,
  runCapture,
  UsageError,
  writeBinaryFile,
} from "../platform.ts";

const REPO = "wistrand/radia";
const INSTALL_LINE = "curl -fsSL https://radia.sh/install.sh | bash";

export interface UpdateOptions {
  /** Report and exit rather than replacing anything. */
  check: boolean;
  /** A tag to install instead of the latest, `v2026.8.1`. Downgrades are allowed on purpose: a bad
   *  release needs a way back that is not "find the old tag yourself". */
  release?: string;
}

export interface UpdateResult {
  code: number;
  lines: string[];
}

/**
 * The release base. `RADIA_BASE_URL` is the SAME override `docs/install.sh` takes, so a mirror (or
 * a test serving a fake release over loopback) is named once and understood by both.
 */
function releaseBase(release: string | undefined): string {
  const override = env("RADIA_BASE_URL");
  if (override) return override.replace(/\/+$/, "");
  return release
    ? `https://github.com/${REPO}/releases/download/${release}`
    : `https://github.com/${REPO}/releases/latest/download`;
}

/**
 * The tag out of the URL a release fetch RESOLVED to.
 *
 * GitHub redirects `releases/latest/download/X` to `releases/download/<tag>/X`, so one request
 * learns the version. That is how `--check` costs a single fetch and never touches
 * `api.github.com`, whose unauthenticated limit is 60 per hour shared per address and bites office
 * networks first. A mirror that does not redirect yields nothing, which the caller reports rather
 * than guesses at.
 */
function tagFromUrl(url: string): string | undefined {
  return /\/releases\/download\/([^/]+)\//.exec(url)?.[1];
}

/** `2026.8.2` as numbers, or undefined for anything that is not a release stamp. */
function parseVersion(v: string): number[] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Is `a` a later release than `b`? Unparseable either side answers false, so a tag this build
 *  cannot read is never reported as an update. */
function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

/**
 * The expected digest for one asset, or undefined.
 *
 * Undefined is a REFUSAL at the call site, not a skip: a `SHA256SUMS` that does not mention the
 * asset means nothing was verified, which is the installer's rule and the one worth copying most.
 * Leading `*` (binary mode) and `./` are stripped the way `sha256sum -c` accepts them.
 */
function expectedDigest(sums: string, asset: string): string | undefined {
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-f]{64})\s+(\S.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[2].replace(/^\*/, "").replace(/^\.\//, "").trim() === asset) return m[1];
  }
  return undefined;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Web streams, so unpacking needs no dependency and no temp file. */
async function gunzip(gz: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function get(url: string): Promise<Response> {
  let res: Response;
  try {
    res = await httpRequest(url, { redirect: "follow" });
  } catch (e) {
    throw new UsageError(`cannot reach ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new UsageError(
      res.status === 404
        ? `${url} does not exist (HTTP 404). Check the release tag, or see https://github.com/${REPO}/releases`
        : `${url} returned HTTP ${res.status}`,
    );
  }
  return res;
}

/** A write that failed because this user does not own the binary. Names the path and offers an
 *  install somewhere they do; never `sudo`, which would hand a downloaded file root. */
function unwritable(e: unknown, dest: string): UsageError | undefined {
  const msg = (e as Error)?.message ?? String(e);
  if (!/permission denied|EACCES|EPERM|read-only|Read-only/i.test(msg)) return undefined;
  return new UsageError(
    `cannot replace ${dest}: permission denied.\n` +
      `  Another user owns this binary, or it sits on a read-only path.\n` +
      `  Install one you own instead:\n` +
      `    RADIA_INSTALL_DIR=$HOME/.local/bin ${INSTALL_LINE}`,
  );
}

export async function runUpdate(opts: UpdateOptions): Promise<UpdateResult> {
  if (!isStandalone()) {
    throw new UsageError(
      "`radia update` replaces a compiled binary, and this is running from a checkout.\n" +
        "  Update the source with git, or build a binary with `deno task compile`.",
    );
  }

  const target = buildTarget();
  const asset = `radia-${target}.gz`;
  const base = releaseBase(opts.release);

  const sumsRes = await get(`${base}/SHA256SUMS`);
  const sums = await sumsRes.text();
  const latest = opts.release ?? tagFromUrl(sumsRes.url);

  // Before any version talk: a release that does not publish this target is a refusal, and saying
  // so during `--check` beats promising an update that fails at the download.
  const want = expectedDigest(sums, asset);
  if (!want) {
    throw new UsageError(
      `the release's SHA256SUMS does not list ${asset}, so nothing about it can be verified.\n` +
        `  This build is for ${target}; the release may not publish that target.`,
    );
  }

  if (latest && !opts.release && !isNewer(latest, VERSION)) {
    return { code: 0, lines: [`radia ${VERSION} is current (latest is ${latest})`] };
  }
  if (opts.check) {
    return latest
      ? { code: 1, lines: [`radia ${latest} is available; this is ${VERSION}`, "  run: radia update"] }
      // A mirror that did not redirect: the tag is not in the URL, so there is nothing to compare.
      : { code: 0, lines: [`${base} serves ${asset}, and its version is not in the URL.`, "  run `radia update` to install what it serves"] };
  }

  const gz = new Uint8Array(await (await get(`${base}/${asset}`)).arrayBuffer());
  const got = await sha256Hex(gz);
  if (got !== want) {
    throw new UsageError(
      `checksum mismatch for ${asset}\n  expected ${want}\n  got      ${got}\n` +
        "This is either a corrupted download or an asset the release did not publish.",
    );
  }

  const dest = realPath(execPath());
  const tmp = join(dirname(dest), `.radia-update-${pid()}.tmp`);
  let reported = "";
  try {
    await writeBinaryFile(tmp, await gunzip(gz));
    makeExecutable(tmp);
    // The pre-flight, and the reason it runs from a temp NAME beside the destination rather than
    // from `/tmp`: the rename below has to stay on one filesystem.
    const probe = await runCapture(tmp, ["version"], 15_000);
    if (probe.code !== 0) {
      throw new UsageError(`the downloaded binary does not run on this machine (${target}). Nothing was replaced.`);
    }
    reported = probe.stdout.trim().split(/\s+/)[1] ?? "";
    if (latest && reported && !isSameRelease(reported, latest)) {
      throw new UsageError(`the downloaded binary reports ${reported} rather than ${latest}. Nothing was replaced.`);
    }
    renameFile(tmp, dest);
  } catch (e) {
    removeFile(tmp);
    throw unwritable(e, dest) ?? e;
  }
  return { code: 0, lines: [`updated radia ${VERSION} -> ${reported || latest || "?"}`, `  ${dest}`] };
}

function isSameRelease(a: string, b: string): boolean {
  return a.replace(/^v/, "") === b.replace(/^v/, "");
}
