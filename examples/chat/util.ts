// Small shared helpers: worker argument parsing, and the media handling every artifact writer
// needs. Two areas, both too small to deserve a file of their own.

// ---- worker arguments ----
//
// Config arrives as ARGUMENTS rather than environment variables on purpose: the tool-worker runs
// without `--allow-env` (so a process that can read files cannot read secrets), and a worker that
// took its config from the environment could not run that way.

/** The value after `--name`, or undefined. */
export function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

/** Every value for a repeatable flag: `--dir a --dir b` -> ["a", "b"]. */
export function argAll(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < Deno.args.length; i++) if (Deno.args[i] === name) out.push(Deno.args[i + 1]);
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` when this worker is asked to stop, then exit.
 *
 * For withdrawing what the worker advertised — a `model` record, in practice — so a stopped worker
 * stops being routed to instead of leaving an offer nobody serves. Best effort by nature: it covers
 * SIGINT/SIGTERM (how a launcher stops a fleet, and how Ctrl-C stops one by hand) and nothing else,
 * so a `kill -9` or a crash still leaves the advertisement behind.
 *
 * The withdrawal is given a short deadline of its own: a worker that cannot reach the space must
 * still exit rather than hang on shutdown, which is the failure that makes people reach for -9 and
 * lose the graceful path entirely.
 */
export function onStop(fn: () => Promise<unknown>): void {
  let stopping = false;
  const handler = async () => {
    if (stopping) return; // a second Ctrl-C must not start a second withdrawal
    stopping = true;
    try {
      await Promise.race([fn(), sleep(2000)]);
    } catch { /* shutting down anyway */ }
    Deno.exit(0);
  };
  // SIGTERM does not exist on Windows and registering it throws, taking the worker down at startup.
  const signals: Deno.Signal[] = Deno.build.os === "windows" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
  for (const sig of signals) Deno.addSignalListener(sig, handler);
}

// ---- artifact media ----
//
// The media type is DECLARED, never sniffed: whatever is passed here ends up in the artifact
// record and then in a `Content-Type` header. That is safe only because the server refuses to
// render anything scriptable inline (design-data-model 2.4), so a wrong or lying type changes
// what a download is called, never whether it executes.

/** Media type implied by a filename's extension; text/plain when unknown. */
export function mediaTypeFor(filename: string | undefined): string {
  const ext = (filename ?? "").toLowerCase().split(".").pop() ?? "";
  return ({
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    json: "application/json",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    md: "text/markdown",
    txt: "text/plain",
    html: "text/html",
    js: "text/javascript",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
    pdf: "application/pdf",
    zip: "application/zip",
  } as Record<string, string>)[ext] ?? "text/plain";
}

/** Text to bytes, decoding base64 when that is how the caller encoded them. */
export function bytesFrom(text: string, encoding?: unknown): Uint8Array {
  if (encoding !== "base64") return new TextEncoder().encode(text);
  const binary = atob(String(text).trim().replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Decode a `data:` URL into bytes plus its declared media type. */
export function bytesFromDataUrl(url: string): { bytes: Uint8Array; mediaType: string } | null {
  const m = url.match(/^data:([^;,]+);base64,(.*)$/s);
  return m ? { bytes: bytesFrom(m[2], "base64"), mediaType: m[1] } : null;
}
