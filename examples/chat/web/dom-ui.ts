/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// The chat's output port, implemented for a browser (agent_docs/plan-chat-web-ui.md phase 2).
//
// The terminal implementation is `client/terminal.ts`; this one renders the same calls into a
// document. Neither knows about the other, and the protocol half knows about neither.
//
// STYLING TRAVELS AS ANSI, here too, and that is deliberate rather than lazy. `ChatUI` says the
// result of `dim` belongs to the implementation that produced it, so this one picks the format its
// OTHER input already uses: `MarkdownStream` emits ANSI, so one converter serves the answer stream
// and every `write` call instead of two. The set of codes is closed (bold, dim, italic, strike,
// code, reset) because we are the only producer.
//
// NOTHING IS BUILT WITH innerHTML. Text arrives as text nodes and styling as spans, so a model's
// answer, a tool's output and a filename are incapable of becoming markup.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { type AnswerStream, MarkdownStream } from "../client/markdown.ts";
import type { ChatUI } from "../client/ui.ts";

/** ANSI SGR codes to classes. Anything not here styles nothing: an unknown code is dropped rather
 *  than guessed at, and dropping it loses styling while guessing loses text. */
const STYLE: Record<string, string> = { "1": "b", "2": "dim", "3": "i", "9": "s", "36": "code" };

/** Visible length, ignoring styling. `trunc` counts what a person sees. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * An ANSI stream, rendered into an element as text nodes and nested spans.
 *
 * Stateful across writes on purpose: a style opened by one `write` is closed by another, and the
 * markdown renderer's "reset, then re-apply what is still open" is exactly a stack unwind here.
 */
class AnsiSink {
  private readonly stack: HTMLElement[] = [];

  constructor(private readonly root: HTMLElement) {}

  private top(): HTMLElement {
    return this.stack[this.stack.length - 1] ?? this.root;
  }

  write(s: string): void {
    const re = /\x1b\[([0-9;]*)m/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) this.text(s.slice(last, m.index));
      this.code(m[1]);
      last = re.lastIndex;
    }
    if (last < s.length) this.text(s.slice(last));
  }

  private text(t: string): void {
    if (t) this.top().appendChild(document.createTextNode(t));
  }

  private code(c: string): void {
    if (c === "" || c === "0") {
      this.stack.length = 0; // reset closes everything; the caller re-opens what is still open
      return;
    }
    const cls = STYLE[c];
    if (!cls) return;
    const el = document.createElement("span");
    el.className = cls;
    this.top().appendChild(el);
    this.stack.push(el);
  }
}

/** Media a browser can safely PAINT, and the same list the space uses to decide the question on its
 *  main origin (`RENDERABLE` in src/server/handlers/artifacts.ts). Everything else is a link. */
const PAINTABLE = /^(?:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/i;

export interface DomUiOptions {
  /** Where the transcript is appended. */
  transcript: HTMLElement;
  /** One line of transient state (what a worker is doing). */
  status: HTMLElement;
  /** Called after anything is appended, so the view can follow the tail. */
  onAppend?: () => void;
}

export function domUI(opts: DomUiOptions): ChatUI {
  const { transcript, status } = opts;
  let logBlock: HTMLElement | null = null;
  let logSink: AnsiSink | null = null;

  const appended = () => opts.onAppend?.();

  const block = (cls: string): HTMLElement => {
    const el = document.createElement("div");
    el.className = cls;
    transcript.appendChild(el);
    return el;
  };

  /** The log is where everything that is NOT the answer lands: round headers, tool calls, usage
   *  lines, errors. One element per run of writes, so an answer between two of them separates. */
  const log = (): AnsiSink => {
    // A new block whenever something else appended in the meantime (the page renders the person's
    // own message itself, since the protocol half never emits it), so ordering cannot interleave.
    if (!logSink || transcript.lastElementChild !== logBlock) {
      logBlock = block("log");
      logSink = new AnsiSink(logBlock);
    }
    return logSink;
  };

  const closeLog = () => {
    // An empty block is what a lone "\n" leaves behind; dropping it keeps the spacing honest.
    if (logBlock && !logBlock.textContent) logBlock.remove();
    logBlock = null;
    logSink = null;
  };

  return {
    write(s) {
      log().write(s);
      appended();
    },

    // A document has no cursor to strand, so the terminal's line discipline has nothing to do here.
    ensureLine() {},

    columns() {
      // Answers are rendered in a monospace block, and the markdown renderer pads tables and rules
      // to this number, so it has to be the real column count rather than a constant.
      const probe = document.createElement("span");
      probe.className = "log";
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
      probe.textContent = "0".repeat(80);
      transcript.appendChild(probe);
      const per = probe.getBoundingClientRect().width / 80;
      probe.remove();
      const w = transcript.clientWidth || 640;
      return Math.max(40, Math.min(120, Math.floor(per > 0 ? w / per : 80)));
    },

    trunc(s, n) {
      return plain(s).length <= n ? s : plain(s).slice(0, Math.max(0, n - 1)) + "…";
    },

    dim: (s) => `\x1b[2m${s}\x1b[0m`,

    // Out-of-band output cannot splice itself into an answer here: blocks are elements, so a notice
    // appended while an answer streams lands after it rather than inside it. That is the whole job
    // `holdLine` does on a terminal, which is why it is a no-op below.
    notice(s) {
      closeLog();
      const el = block("notice");
      new AnsiSink(el).write(s);
      closeLog();
      appended();
    },

    holdLine() {},

    answerStream(): AnswerStream {
      closeLog();
      const el = block("answer");
      const sink = new AnsiSink(el);
      // colour: true, because this sink converts ANSI to spans. The alternative (colour: false)
      // would flatten bold and code to nothing and gain a page nothing, since the renderer's
      // structure (bullets, tables, rules) is drawn with characters either way.
      const md = new MarkdownStream((s) => {
        sink.write(s);
        appended();
      }, { colour: true, width: this.columns() });
      return {
        push: (t) => md.push(t),
        end: () => {
          md.end();
          appended();
        },
      };
    },

    showStatus(prefix, s) {
      status.textContent = `${prefix}${plain(s)}`;
      status.hidden = false;
    },

    endStatus() {
      status.textContent = "";
      status.hidden = true;
    },

    statusLineOn: () => true,

    /**
     * An artifact, as something a person can actually open.
     *
     * Three lanes, split on what a browser may be trusted to paint (agent_docs/plan-chat-web-ui.md):
     * paintable media is fetched through the app's own relay and shown from a blob URL; everything
     * else opens on the ISOLATED artifact origin under a capability minted at click time, because a
     * capability lasts minutes and dies with the space; and saving is the same bytes with a
     * download attribute, so nothing navigates to them.
     */
    async showArtifact(client: RadiaClient, output: unknown): Promise<void> {
      const ref = output as { artifactId?: string; mediaType?: string; size?: number; filename?: string } | null;
      if (!ref || typeof ref.artifactId !== "string") return;
      const id = ref.artifactId;
      const mediaType = ref.mediaType ?? "application/octet-stream";
      closeLog();
      const el = block("artifact");
      const line = document.createElement("div");
      line.className = "artifact-line";
      line.appendChild(document.createTextNode(`${mediaType} · ${Math.max(1, Math.round((ref.size ?? 0) / 1024))} KB `));
      el.appendChild(line);

      // OPEN: minted on the click, never on render.
      const open = document.createElement("button");
      open.className = "link";
      open.textContent = "open";
      open.onclick = async () => {
        // The tab is opened INSIDE the gesture and pointed afterwards: a popup blocker eats a
        // window opened from a promise continuation.
        const w = globalThis.open("", "_blank");
        try {
          const cap = await client.artifactCapability(id);
          if (w) w.location.href = cap.url;
        } catch (e) {
          w?.close();
          this.notice(`could not open ${id}: ${(e as Error).message}`);
        }
      };
      line.appendChild(open);

      // SAVE: through the relay, as bytes with no type a navigation could honour.
      const save = document.createElement("button");
      save.className = "link";
      save.textContent = "save";
      save.onclick = async () => {
        try {
          const bytes = await client.getArtifact(id);
          const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
          const a = document.createElement("a");
          a.href = url;
          a.download = ref.filename ?? `${id}.${(mediaType.split("/")[1] ?? "bin").replace(/\W.*$/, "")}`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
        } catch (e) {
          this.notice(`could not save ${id}: ${(e as Error).message}`);
        }
      };
      line.appendChild(save);

      if (PAINTABLE.test(mediaType)) {
        try {
          const bytes = await client.getArtifact(id);
          const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType }));
          const kind = mediaType.split("/")[0];
          const media = document.createElement(kind === "image" ? "img" : kind === "video" ? "video" : "audio");
          media.className = "media";
          (media as HTMLMediaElement).controls = kind !== "image";
          media.src = url;
          el.appendChild(media);
        } catch (e) {
          line.appendChild(document.createTextNode(` (preview failed: ${(e as Error).message})`));
        }
      }
      closeLog();
      appended();
    },
  };
}
