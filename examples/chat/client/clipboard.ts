// Reading the system clipboard, because the terminal will not do it for us.
//
// A TTY carries text. When the clipboard holds an image, the terminal's own paste shortcut has
// nothing to send and sends NOTHING: no error, no character, a key that appears broken. The only
// way to get those bytes is for the application to ask the desktop itself, which is what this does.
//
// Effects live here rather than in the editor: `edit.ts` decodes a keystroke into an intent and
// stays pure, `terminal.ts` owns raw mode and the redraw, and this module owns the one thing that
// leaves the process. Spawning is allowed: examples are applications, not the runtime, so the
// `platform.ts` seam does not apply (see CLAUDE.md, Conventions).

/** What came off the clipboard. `uris` is the file-manager case: "copy" there offers paths, not bytes. */
export type Clipboard =
  | { kind: "text"; text: string }
  | { kind: "bytes"; mediaType: string; bytes: Uint8Array }
  | { kind: "uris"; paths: string[] };

/** Types worth taking as BYTES, best first. Everything else is treated as text or ignored: this
 *  list is what the vision worker accepts (`--vision-types`), so the chat never stores an
 *  attachment it would then have to refuse to look at. */
const BINARY_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
];

/** How long a clipboard read may take before it is killed.
 *
 * NOT optional. The prompt is in raw mode with a half-drawn line while this runs, so a reader that
 * blocks (no clipboard manager, a compositor that stopped answering, an X11 owner that died holding
 * the selection) does not make the paste slow, it makes the REPL unusable with no way out. Two
 * seconds is far above a real read and far below a person's patience. */
const TIMEOUT_MS = 2000;

/** Read an environment variable without requiring `--allow-env` to have been granted. */
function env(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** A clipboard reader: which display server it belongs to, how to ask for the offered types, and
 *  how to ask for one of them. */
interface Reader {
  name: string;
  /**
   * Is this reader's display server the one actually running?
   *
   * Installed is NOT the same as usable, and conflating them breaks the most ordinary mixed case
   * there is: a distro that ships `wl-clipboard` on a machine logged into X11. `wl-paste` is then on
   * PATH, spawns happily, and fails with "Failed to connect to a Wayland server" for every read. A
   * probe that only asked "did it spawn" picked it, the banner named it, and Ctrl-V did nothing
   * forever — the exact silent no-op this whole feature exists to remove.
   */
  available: () => boolean;
  list: string[];
  read: (type: string) => string[];
  /** Present on hosts where images need a different tool than text (macOS). */
  image?: { bin: string; args: string[]; mediaType: string };
}

const READERS: Reader[] = [
  // Wayland (wl-clipboard). `--no-newline` matters: without it a trailing byte is appended to
  // whatever was copied, which corrupts a PNG and silently changes a text paste.
  {
    name: "wl-paste",
    available: () => Deno.build.os === "linux" && env("WAYLAND_DISPLAY") !== undefined,
    list: ["wl-paste", "--list-types"],
    read: (t) => ["wl-paste", "--no-newline", "--type", t],
  },
  // X11. FIRST match wins and Wayland is listed above, which is the right order under XWayland,
  // where both variables are set and the Wayland clipboard is the real one.
  {
    name: "xclip",
    available: () => Deno.build.os === "linux" && env("DISPLAY") !== undefined,
    list: ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
    read: (t) => ["xclip", "-selection", "clipboard", "-t", t, "-o"],
  },
  // macOS. `pbpaste` is text-only, so images need `pngpaste`, which is NOT installed by default
  // (`brew install pngpaste`). Without it an image on the pasteboard reads as nothing, which is
  // where the caller's message has to say so rather than claiming the clipboard is empty.
  {
    name: "pbpaste",
    available: () => Deno.build.os === "darwin",
    list: [],
    read: () => ["pbpaste"],
    image: { bin: "pngpaste", args: ["-"], mediaType: "image/png" },
  },
];

/**
 * Run a command, with a hard deadline.
 *
 * `null` means the tool is NOT THERE (could not spawn); a result with `ok: false` means it ran and
 * declined. Keeping those apart is not pedantry: `wl-paste --list-types` exits 1 on an EMPTY
 * clipboard, so conflating them made an idle clipboard look like a machine with no clipboard tool,
 * and the banner then told the truth's opposite ("no reader") to someone who had one installed.
 */
async function run(cmd: string[]): Promise<{ ok: boolean; out: Uint8Array } | null> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "piped", stderr: "null" }).spawn();
  } catch {
    return null; // not on PATH, or --allow-run does not cover it
  }
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, TIMEOUT_MS);
  try {
    const { success, stdout } = await child.output();
    return { ok: success, out: stdout };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The bytes a command produced, or null unless it actually succeeded. */
async function output(cmd: string[]): Promise<Uint8Array | null> {
  const res = await run(cmd);
  return res?.ok ? res.out : null;
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** The first reader that EXISTS. Probed once: which clipboard this host has is a property of the
 *  session (Wayland, X11, macOS, or none), not of the moment. What the clipboard happens to hold at
 *  startup says nothing about that, which is why the probe asks whether the tool ran at all. */
let probed: Reader | null | undefined;
async function reader(): Promise<Reader | null> {
  if (probed !== undefined) return probed;
  for (const r of READERS) {
    if (!r.available()) continue; // wrong display server: installed, and useless here
    // A reader with no listing (pbpaste) is confirmed the same way: by whether it spawns.
    if (await run(r.list.length > 0 ? r.list : r.read("public.utf8-plain-text")) !== null) return (probed = r);
  }
  return (probed = null);
}

/** Which clipboard reader this host has, for the banner. `null` when there is none, which is worth
 *  SAYING: a key that silently does nothing is the failure this whole module exists to remove. */
export async function clipboardReader(): Promise<string | null> {
  return (await reader())?.name ?? null;
}

/** Set when an image tool this host NEEDS is not installed (macOS without `pngpaste`), so a caller
 *  can say which one instead of reporting an empty clipboard. */
let missingImageTool: string | null = null;

/** The tool that would let images work here, if one is missing. Null when nothing is. */
export function missingClipboardTool(): string | null {
  return missingImageTool;
}

/**
 * Read the clipboard, preferring bytes we can actually use.
 *
 * Order is deliberate: a screenshot offers `image/png` AND a text rendering on some desktops, and
 * taking the text would turn "paste this picture" into pasting the word "image". Files copied in a
 * file manager arrive as `text/uri-list`, which is a path rather than bytes and is handled by the
 * caller, since reading a path is the caller's business and not the clipboard's.
 */
export async function readClipboard(): Promise<Clipboard | null> {
  const r = await reader();
  if (!r) return null;

  const types = r.list.length > 0
    ? decode((await output(r.list)) ?? new Uint8Array()).split("\n").map((t) => t.trim().toLowerCase()).filter(Boolean)
    : [];

  for (const want of BINARY_TYPES) {
    if (!types.includes(want)) continue;
    const bytes = await output(r.read(want));
    if (bytes && bytes.length > 0) return { kind: "bytes", mediaType: want, bytes };
  }
  // macOS: no listing to consult, so the image tool is simply tried. Its ABSENCE is reported rather
  // than swallowed: a Mac with a screenshot on the pasteboard and no `pngpaste` would otherwise get
  // "clipboard: empty", which is false and sends the person looking in the wrong place.
  if (r.image && types.length === 0) {
    const res = await run([r.image.bin, ...r.image.args]);
    if (res === null) missingImageTool = r.image.bin;
    else if (res.ok && res.out.length > 0) return { kind: "bytes", mediaType: r.image.mediaType, bytes: res.out };
  }

  if (types.includes("text/uri-list")) {
    const raw = await output(r.read("text/uri-list"));
    // A comment line is legal in uri-list and `file://` is the only scheme worth following here:
    // an http:// URI is a link the person pasted, and it belongs in the message as text.
    const paths = decode(raw ?? new Uint8Array())
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("file://"))
      .map((u) => {
        try {
          return decodeURIComponent(new URL(u).pathname);
        } catch {
          return "";
        }
      })
      .filter(Boolean);
    if (paths.length > 0) return { kind: "uris", paths };
  }

  // The offered type is used VERBATIM: `wl-paste --type text/plain` fails against a clipboard
  // offering `text/plain;charset=utf-8`, so trimming the parameter loses the only type on offer.
  const textType = types.find((t) => t.startsWith("text/plain")) ?? types.find((t) => t === "utf8_string" || t === "string");
  const raw = await output(r.read(textType ?? "text/plain;charset=utf-8"));
  if (raw === null) return null;
  const text = decode(raw);
  return text ? { kind: "text", text } : null;
}
