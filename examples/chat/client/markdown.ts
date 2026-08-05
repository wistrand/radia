// Rendering the model's markdown into a terminal, while it is still arriving.
//
// The whole difficulty is that the answer is a STREAM. `**bold**` shows up split across arrivals, a
// fence opens in one chunk and closes six seconds later, and a table is unreadable until its last
// row. Buffering to the end and rendering once would solve all of it and lose the thing that makes a
// chat feel alive, so this holds back as little as it can get away with:
//
//   AT A LINE START, up to ten characters, because that is enough to tell `# `, `- `, `1. `, `> `,
//   ```` ``` ````, `---` and `|` apart from a paragraph, and a chunk is normally much longer than
//   ten characters anyway. A newline or the end of the answer decides early.
//   MID-LINE, one character, which is all it takes to separate `*` from `**`.
//   INSIDE A LINK OR A TABLE, as much as the construct needs, bounded. Neither is readable half
//   drawn, so there is nothing to lose by waiting, and the bound is what stops a malformed one from
//   swallowing the answer.
//
// Nothing here knows about a terminal beyond ANSI codes and a width, so it is driven by a callback
// and tested with a string. `terminal.ts` decides whether to use it at all: off a TTY the answer is
// passed through untouched, because redirected output must stay byte-identical to the model's own
// text.

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const STRIKE = "\x1b[9m";
const CODE = "\x1b[36m";

/** How much of a line start to hold before deciding what kind of line it is. */
const LOOKAHEAD = 10;
/** A `[text](url)` longer than this is not a link, it is prose with a bracket in it. */
const MAX_LINK = 256;
/** A table this big is a data dump; render it raw rather than holding the answer hostage. */
const MAX_TABLE_LINES = 200;

export interface AnswerStream {
  push(text: string): void;
  end(): void;
}

/** Straight through, for a pipe. Same interface, no decisions. */
export function passthrough(out: (s: string) => void): AnswerStream {
  return { push: out, end: () => {} };
}

export interface MarkdownOptions {
  /** Emit ANSI styling. False renders structure (bullets, aligned tables) in plain text. */
  colour?: boolean;
  /** Used for rules and table cells. */
  width?: number;
}

export class MarkdownStream implements AnswerStream {
  private buf = "";
  private lineStart = true;
  private ended = false;
  private mode: "text" | "fence" | "table" = "text";
  /** Inline styles currently open, innermost last. A close re-applies the rest, because `\x1b[0m`
   *  ends everything and bold inside a blockquote has to survive the bold closing. */
  private readonly inline: string[] = [];
  /** Styles opened for THIS line only (a heading's bold, a quote's dim), closed at the newline. */
  private lineStyles = 0;
  private fenceMarker = "";
  private table: string[] = [];
  /** The last character DEALT WITH, which is not always still in `buf`. Chunk boundaries are why
   *  this exists: `snake_case` arriving one character at a time put the `_` at index 0 of an
   *  otherwise empty buffer, so the look-back found nothing, read it as a word boundary, and
   *  italicised the rest of the identifier. Rendered whole, the same text was correct. */
  private prev = " ";
  private readonly colour: boolean;
  private readonly width: number;

  constructor(private readonly out: (s: string) => void, opts: MarkdownOptions = {}) {
    this.colour = opts.colour ?? true;
    this.width = opts.width ?? 80;
  }

  push(text: string): void {
    this.buf += text;
    this.drain();
  }

  end(): void {
    this.ended = true;
    this.drain();
    if (this.mode === "table") this.flushTable();
    this.closeAll();
  }

  // ---- emitting ----

  private style(code: string): void {
    if (this.colour) this.out(code);
  }

  private open(code: string): void {
    this.inline.push(code);
    this.style(code);
  }

  private close(code: string): void {
    const i = this.inline.lastIndexOf(code);
    if (i < 0) return;
    this.inline.splice(i, 1);
    this.style(RESET + this.inline.join(""));
  }

  private toggle(code: string): void {
    if (this.inline.includes(code)) this.close(code);
    else this.open(code);
  }

  /** Open a style that belongs to the current line, so the newline can take it back down. */
  private openForLine(code: string): void {
    this.open(code);
    this.lineStyles++;
  }

  private closeAll(): void {
    while (this.inline.length > 0) this.close(this.inline[this.inline.length - 1]);
    this.lineStyles = 0;
  }

  private endLine(): void {
    for (let i = 0; i < this.lineStyles; i++) this.close(this.inline[this.inline.length - 1]);
    this.lineStyles = 0;
    this.out("\n");
    this.lineStart = true;
    this.prev = " "; // a line break is a word boundary
  }

  // ---- the loop ----

  private drain(): void {
    for (;;) {
      if (this.mode === "fence") {
        if (!this.drainFence()) return;
        continue;
      }
      if (this.mode === "table") {
        if (!this.drainTable()) return;
        continue;
      }
      if (this.lineStart) {
        if (!this.startLine()) return;
        continue;
      }
      if (!this.drainInline()) return;
    }
  }

  /** Decide what kind of line this is. False means "not enough input yet". */
  private startLine(): boolean {
    const nl = this.buf.indexOf("\n");
    if (this.buf.length < LOOKAHEAD && nl < 0 && !this.ended) return false;
    if (this.buf.length === 0) return false;

    // A blank line ends a paragraph, and with it any inline span left hanging by a model that
    // opened `**` and never closed it. Without this one asterisk italicises the rest of the answer.
    if (this.buf[0] === "\n") {
      this.closeAll();
      this.buf = this.buf.slice(1);
      this.out("\n");
      return true;
    }

    const head = nl >= 0 ? this.buf.slice(0, nl) : this.buf;
    const indent = head.match(/^ {0,12}/)![0];
    const rest = head.slice(indent.length);

    // A fence. `~~~` counts, and the marker length is remembered so a longer fence inside a shorter
    // one does not close it.
    const fence = rest.match(/^(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)/);
    if (fence) {
      this.fenceMarker = fence[1][0].repeat(3);
      this.mode = "fence";
      this.buf = nl >= 0 ? this.buf.slice(nl + 1) : "";
      this.lineStart = true;
      const lang = fence[2];
      this.style(DIM);
      this.out(`${indent}${"─".repeat(Math.max(4, Math.min(this.width, 60) - indent.length - lang.length - 1))}${lang ? ` ${lang}` : ""}`);
      this.style(RESET + this.inline.join(""));
      this.out("\n");
      return true;
    }

    // A horizontal rule, before the list check: `---` is three of a list marker in a row.
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(rest)) {
      this.buf = nl >= 0 ? this.buf.slice(nl + 1) : "";
      this.style(DIM);
      this.out(`${indent}${"─".repeat(Math.max(4, Math.min(this.width, 60) - indent.length))}`);
      this.style(RESET + this.inline.join(""));
      this.out("\n");
      return true;
    }

    // A table, which cannot be aligned until it is complete, so it is collected whole.
    if (rest.startsWith("|")) {
      this.mode = "table";
      this.table = [];
      return true;
    }

    const heading = rest.match(/^(#{1,6})\s+/);
    if (heading) {
      this.consume(indent.length + heading[0].length);
      this.lineStart = false;
      this.openForLine(BOLD);
      return true;
    }

    const bullet = rest.match(/^([-*+])\s+/);
    if (bullet) {
      this.consume(indent.length + bullet[0].length);
      this.lineStart = false;
      this.style(DIM);
      this.out(`${indent}• `);
      this.style(RESET + this.inline.join(""));
      return true;
    }

    const ordered = rest.match(/^(\d{1,9})([.)])\s+/);
    if (ordered) {
      this.consume(indent.length + ordered[0].length);
      this.lineStart = false;
      this.style(DIM);
      this.out(`${indent}${ordered[1]}. `);
      this.style(RESET + this.inline.join(""));
      return true;
    }

    const quote = rest.match(/^>\s?/);
    if (quote) {
      this.consume(indent.length + quote[0].length);
      this.lineStart = false;
      this.style(DIM);
      this.out(`${indent}│ `);
      this.style(RESET + this.inline.join(""));
      this.openForLine(DIM);
      return true;
    }

    // An ordinary paragraph line. The indent is real text; everything after it is inline.
    this.consume(indent.length);
    this.out(indent);
    this.lineStart = false;
    return true;
  }

  private consume(n: number): void {
    this.buf = this.buf.slice(n);
  }

  /** Inline spans. False means "not enough input to decide the next character". */
  private drainInline(): boolean {
    // One character of lookahead, so `*` and `**` are distinguishable. At the end there is nothing
    // more coming, so the last character is decided on its own.
    const limit = this.ended ? this.buf.length : this.buf.length - 1;
    let i = 0;
    let plain = "";
    const flush = () => {
      if (plain) {
        this.out(plain);
        plain = "";
      }
    };
    while (i < limit) {
      const c = this.buf[i];
      const next = this.buf[i + 1];

      if (c === "\n") {
        flush();
        this.consume(i + 1);
        this.endLine();
        return true;
      }

      // An escape passes the next character through untouched, which is the only way a model can
      // write a literal asterisk.
      if (c === "\\" && next && "*_`~[".includes(next)) {
        plain += next;
        this.prev = next;
        i += 2;
        continue;
      }

      if (c === "`") {
        flush();
        this.toggle(CODE);
        i++;
        continue;
      }
      if (c === "*" && next === "*") {
        flush();
        this.toggle(BOLD);
        i += 2;
        continue;
      }
      if (c === "~" && next === "~") {
        flush();
        this.toggle(STRIKE);
        i += 2;
        continue;
      }
      if (c === "*") {
        flush();
        this.toggle(ITALIC);
        i++;
        continue;
      }
      // `_` only delimits at a word boundary, or snake_case names come out half italic. This is the
      // one inline rule that exists because of how code looks rather than how markdown is specified.
      if (c === "_" && this.wordBoundary(i)) {
        flush();
        this.toggle(ITALIC);
        i++;
        continue;
      }
      if (c === "[") {
        flush();
        this.consume(i);
        return this.drainLink();
      }
      plain += c;
      this.prev = c;
      i++;
    }
    flush();
    this.consume(i);
    return false;
  }

  /** True when `_` at `i` sits at the edge of a word, which is where markdown lets it delimit. */
  private wordBoundary(i: number): boolean {
    const before = i === 0 ? this.prev : this.buf[i - 1];
    const after = this.buf[i + 1] ?? " ";
    const word = (ch: string) => /[A-Za-z0-9]/.test(ch);
    return this.inline.includes(ITALIC) ? !word(after) : !word(before) && word(after);
  }

  /**
   * `[text](url)` as the text plus a dim URL.
   *
   * NOT an OSC 8 hyperlink: a terminal that does not support them shows the text and silently drops
   * the address, and a URL you cannot see is worse in a transcript than one that is merely long.
   */
  private drainLink(): boolean {
    const m = this.buf.match(/^\[([^\]\n]*)\]\(([^)\s]*)\)/);
    if (m) {
      this.consume(m[0].length);
      this.out(m[1]);
      if (m[2]) {
        this.style(DIM);
        this.out(` ${m[2]}`);
        this.style(RESET + this.inline.join(""));
      }
      return true;
    }
    // Still arriving, unless it has gone on too long or run past the line it started on, in which
    // case it was never a link. Emit the bracket and carry on as ordinary text.
    const decided = this.ended || this.buf.length > MAX_LINK || this.buf.includes("\n");
    if (!decided) return false;
    this.out("[");
    this.consume(1);
    return true;
  }

  /** Code, verbatim. False means "not enough input to know whether this line closes the fence". */
  private drainFence(): boolean {
    const nl = this.buf.indexOf("\n");
    if (this.lineStart) {
      const head = nl >= 0 ? this.buf.slice(0, nl) : this.buf;
      if (nl < 0 && this.buf.length < this.fenceMarker.length && !this.ended) return false;
      if (head.trimStart().startsWith(this.fenceMarker)) {
        // WAIT FOR THE NEWLINE. Closing on the marker alone consumed a line terminator that had not
        // arrived yet, so the `\n` behind it was read as the start of a fresh line and printed a
        // blank one. Only visible when the fence and its newline land in different chunks.
        if (nl < 0 && !this.ended) return false;
        this.buf = nl >= 0 ? this.buf.slice(nl + 1) : "";
        this.mode = "text";
        this.lineStart = true;
        this.style(DIM);
        this.out("─".repeat(Math.max(4, Math.min(this.width, 60))));
        this.style(RESET + this.inline.join(""));
        this.out("\n");
        return true;
      }
      this.lineStart = false;
      this.style(CODE);
    }
    if (nl < 0) {
      if (!this.buf) return false;
      // Code streams a character at a time like anything else; only the line START has to wait.
      this.out(this.buf);
      this.buf = "";
      return false;
    }
    this.out(this.buf.slice(0, nl));
    this.buf = this.buf.slice(nl + 1);
    this.style(RESET + this.inline.join(""));
    this.out("\n");
    this.lineStart = true;
    return true;
  }

  /** Collect the table's lines. False means "waiting for the rest of it". */
  private drainTable(): boolean {
    const nl = this.buf.indexOf("\n");
    if (nl < 0) {
      if (!this.ended) return this.table.length > MAX_TABLE_LINES ? (this.flushTable(), true) : false;
      if (this.buf) this.table.push(this.buf);
      this.buf = "";
      this.flushTable();
      return false;
    }
    const line = this.buf.slice(0, nl);
    if (!line.trimStart().startsWith("|")) {
      this.flushTable();
      return true; // the line itself is re-read as an ordinary line start
    }
    this.table.push(line);
    this.buf = this.buf.slice(nl + 1);
    return true;
  }

  /**
   * Draw the collected table, aligned.
   *
   * Alignment is the entire reason a table waits: column widths are a property of the whole thing,
   * so a row rendered as it arrives can only be rendered wrong. If the cells do not fit the window
   * the rows are emitted as they were written, since a table wrapped at an arbitrary column is
   * harder to read than the source.
   */
  private flushTable(): void {
    const lines = this.table;
    this.table = [];
    this.mode = "text";
    this.lineStart = true;
    if (lines.length === 0) return;
    // Inline markers are STRIPPED inside a cell rather than styled. A column's width is a count of
    // visible characters, and ANSI codes are invisible but not zero-length, so styling a cell and
    // then padding it to a width miscounts by however many escape bytes it contains. Showing the
    // backticks instead (which is what happened) is worse than showing neither.
    const bare = (c: string) => c.replace(/`([^`]*)`/g, "$1").replace(/\*\*([^*]*)\*\*/g, "$1").replace(/\*([^*]*)\*/g, "$1");
    const cells = lines.map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => bare(c.trim())));
    const isRule = (row: string[]) => row.length > 0 && row.every((c) => /^:?-{1,}:?$/.test(c));
    const rows = cells.filter((r) => !isRule(r));
    const cols = Math.max(...rows.map((r) => r.length));
    const widths: number[] = [];
    for (let c = 0; c < cols; c++) widths[c] = Math.max(...rows.map((r) => (r[c] ?? "").length));
    const total = widths.reduce((n, w) => n + w + 3, 1);
    if (total > this.width) {
      for (const l of lines) this.out(`${l}\n`);
      return;
    }
    // A table whose header cells are all blank is a model formatting a list, not labelling columns.
    // Printing it drew an empty row and then a rule under nothing.
    const labelled = cells.length > 1 && isRule(cells[1]) && rows[0]?.some((c) => c.length > 0);
    if (cells.length > 1 && isRule(cells[1]) && !labelled) rows.shift();
    const header = labelled ? rows[0] : undefined;
    rows.forEach((row, i) => {
      if (header && i === 0) this.style(BOLD);
      this.out(row.map((c, n) => c.padEnd(widths[n])).join("  ").trimEnd());
      if (header && i === 0) this.style(RESET + this.inline.join(""));
      this.out("\n");
      if (header && i === 0) {
        this.style(DIM);
        this.out(widths.map((w) => "─".repeat(w)).join("  "));
        this.style(RESET + this.inline.join(""));
        this.out("\n");
      }
    });
  }
}
