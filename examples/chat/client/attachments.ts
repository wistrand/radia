// Clipboard bytes that become artifacts only if the line is actually sent.
//
// WHY THIS EXISTS. Ctrl-V used to upload on the keystroke, so a mis-paste was permanent: an
// `artifact` record written with no retention is permanent (the chat stamps none), and
// pasting the wrong screenshot then deleting the marker, or abandoning the line with Ctrl-C, left it
// stored in the space anyway. The keystroke now only STAGES the bytes; Enter is what writes them.
//
// THE LINE IS THE RECORD OF INTENT. Each staged item is keyed by the placeholder sitting in the
// line, so removing the placeholder removes the upload, and editing it into something
// unrecognisable does too. Failing closed on a mangled placeholder is the right direction: the
// alternative is storing something the person can no longer see.
//
// No I/O here on purpose, the same split `edit.ts` uses: the upload is injected, so the whole
// decision path is a pure function driven from `smoke-edit.ts`.

export interface StagedItem {
  bytes: Uint8Array;
  mediaType: string;
  filename: string;
}

/** Stores bytes and returns the marker that goes in the message. */
export type Upload = (item: StagedItem) => Promise<string>;

export interface Staging {
  /** Hold bytes and return the placeholder to insert. Writes nothing. */
  stage(item: StagedItem): string;
  /** Turn every placeholder still present in `line` into a real artifact, in the order they were
   *  staged. Anything the person removed first is dropped, unwritten. */
  commit(line: string, onError?: (message: string) => void): Promise<string>;
  /** Abandon everything staged: the line was cancelled or cleared. */
  clear(): void;
  /** How many are waiting on an Enter that has not happened. */
  readonly size: number;
}

function humanSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export function staging(upload: Upload): Staging {
  const pending = new Map<string, StagedItem>();
  let seq = 0;
  return {
    stage(item) {
      // Deliberately NOT the `[attached …]` shape `attach` returns, because the two say different
      // things: that one is stored, this one is not stored yet. A person scanning the line should be
      // able to tell which without counting on the tense of a word.
      const mark = `[attach ${++seq}: ${item.filename} · ${item.mediaType} · ${humanSize(item.bytes.byteLength)}]`;
      pending.set(mark, item);
      return mark;
    },
    async commit(line, onError) {
      if (pending.size === 0) return line;
      let out = line;
      for (const [mark, item] of pending) {
        if (!out.includes(mark)) continue; // deleted before sending: the case this exists for
        try {
          out = out.replaceAll(mark, await upload(item));
        } catch (e) {
          // The line still goes, minus the attachment. Losing a whole turn to a failed upload is
          // worse than sending the text, and leaving the marker would claim something that is not
          // there.
          onError?.(`attach failed for ${item.filename}: ${e instanceof Error ? e.message : e}`);
          out = out.replaceAll(mark, "");
        }
      }
      pending.clear();
      return out;
    },
    clear() {
      pending.clear();
    },
    get size() {
      return pending.size;
    },
  };
}
