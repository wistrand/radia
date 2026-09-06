// The score notation, its parser and its validator: the one piece that decides whether a model can
// reliably author music for this pipeline.
//
// WHY A COMPACT TEXT AND NOT JSON. A model emitting a few hundred notes as objects spends most of
// its output on punctuation and makes the mistakes that go with volume: missing fields, duplicated
// keys, pitches out of range. One line per bar of `C4/4 E4/8 r/8` is a fraction of the tokens and
// has fewer places to be wrong. It is also readable in a diff, which matters when the next stage is
// a model reading the previous stage's work.
//
// WHY BARS ARE PART OF THE SYNTAX. `|` between bars costs the writer nothing and buys the check
// that catches the most common musical error by far: a bar whose durations do not sum to the meter.
// Without it a rhythmic slip shifts everything after it and the only symptom is that the song
// sounds wrong, which no test can assert. With it the renderer refuses and NAMES THE BAR, which is
// what turns a bad phrase into a fix task a model can act on.
//
// Nothing here knows about audio. Parsing and validation are shared by the renderer and its smoke
// so the two cannot disagree about what a valid score is: a validator that drifts from the thing it
// validates is the promise-versus-enforcement split this project has been bitten by repeatedly
// (agent_docs/plan-audit-remediation.md).

/** Semitone offsets within an octave, C-based. */
const STEPS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** One sounded or silent event. `midi` is null for a rest. */
export interface Note {
  /** MIDI number, 12 = C0, 60 = C4 (middle C). Null for a rest. */
  midi: number | null;
  /** Start, in whole notes from the beginning of the phrase. */
  at: number;
  /** Length, in whole notes: 0.25 is a quarter. */
  dur: number;
  /** 1-based, for error messages a model can act on. */
  bar: number;
}

export interface Meter {
  beats: number;
  /** The note value that gets one beat: 4 for quarter, 8 for eighth. */
  unit: number;
}

export interface ParseError {
  bar: number;
  token?: string;
  detail: string;
}

/** MIDI range this renderer will sound. Wider than any part needs, narrow enough that a hallucinated
 *  octave is caught rather than rendered as inaudible rumble or a click. */
export const MIDI_MIN = 24; // C1
export const MIDI_MAX = 96; // C7

/** `C4`, `F#3`, `Bb5` -> MIDI. Null when it is not a pitch at all. */
export function toMidi(pitch: string): number | null {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(pitch);
  if (!m) return null;
  const step = STEPS[m[1].toUpperCase()];
  const accidental = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + step + accidental;
}

/** Equal temperament, A4 = 440. */
export function toHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Parse one part's phrase.
 *
 * Every error is collected rather than thrown on the first, because a model fixing one mistake at a
 * time costs a turn per mistake; the whole list in one refusal costs one turn for all of them.
 */
export function parsePhrase(text: string, meter: Meter): { notes: Note[]; errors: ParseError[] } {
  const notes: Note[] = [];
  const errors: ParseError[] = [];
  const perBar = meter.beats / meter.unit;
  let at = 0;
  // The note a pending `~` must continue. A tie is the ONE thing that lets a note cross a barline,
  // which is what an anticipation is: the note arrives before the downbeat and holds through it.
  // Without it every note in every part landed on or after a beat, and eight bars of that is why a
  // run the brief called pop came back sounding like an exercise.
  let tieFrom: Note | null = null;
  const bars = text.split("|").map((b) => b.trim()).filter((b) => b.length > 0);
  if (bars.length === 0) errors.push({ bar: 0, detail: "the phrase is empty: write at least one bar" });

  bars.forEach((bar, i) => {
    const barNo = i + 1;
    let sum = 0;
    for (const token of bar.split(/\s+/).filter(Boolean)) {
      const m = /^([A-Ga-g][#b]?-?\d|r)\/(\d+)(\.?)(~?)$/.exec(token);
      if (!m) {
        errors.push({
          bar: barNo,
          token,
          detail: "expected PITCH/DENOM like C4/4, a rest r/8, a dotted C4/4. or a tied C4/8~",
        });
        continue;
      }
      const denom = Number(m[2]);
      if (!Number.isInteger(Math.log2(denom)) || denom < 1 || denom > 64) {
        errors.push({ bar: barNo, token, detail: `denominator ${denom} is not a power of two between 1 and 64` });
        continue;
      }
      // A dot adds half again. It stays even though ties now exist, because a dotted quarter inside
      // one bar reads better as `C4/4.` than as two tokens a reader has to add up.
      const dur = (1 / denom) * (m[3] === "." ? 1.5 : 1);
      const ties = m[4] === "~";
      if (m[1] === "r") {
        if (tieFrom) {
          errors.push({ bar: barNo, token, detail: "a tie has to continue into the same pitch, and this is a rest" });
          tieFrom = null;
        }
        if (ties) errors.push({ bar: barNo, token, detail: "a rest cannot be tied: silence is already continuous" });
        notes.push({ midi: null, at, dur, bar: barNo });
      } else {
        const midi = toMidi(m[1]);
        if (midi === null) {
          errors.push({ bar: barNo, token, detail: "not a pitch" });
          continue;
        }
        if (midi < MIDI_MIN || midi > MIDI_MAX) {
          errors.push({ bar: barNo, token, detail: `${m[1]} is outside the playable range C1..C7` });
          continue;
        }
        // A TIE LENGTHENS THE HELD NOTE RATHER THAN ADDING ONE. Everything downstream then works
        // unchanged: the synth sounds one note, the analysis sees one onset, and the bar sum still
        // counts each token where it was written, so a tied bar is still checked against the meter.
        if (tieFrom && tieFrom.midi === midi) {
          tieFrom.dur += dur;
        } else {
          if (tieFrom) {
            errors.push({
              bar: barNo,
              token,
              detail: `a tie has to continue into the same pitch, and this is not the one it left`,
            });
          }
          const note: Note = { midi, at, dur, bar: barNo };
          notes.push(note);
          tieFrom = note;
        }
        if (!ties) tieFrom = null;
      }
      at += dur;
      sum += dur;
    }
    // THE CHECK THIS NOTATION EXISTS FOR. Floating point on halvings is exact, so this compares
    // cleanly, but the epsilon costs nothing and a dotted-note chain is where it would matter.
    if (Math.abs(sum - perBar) > 1e-9) {
      errors.push({
        bar: barNo,
        detail: `bar ${barNo} lasts ${sum.toFixed(4)} of a whole note; ${meter.beats}/${meter.unit} needs ` +
          `${perBar.toFixed(4)}. Add or remove rests so every bar is full.`,
      });
    }
  });
  if (tieFrom) {
    errors.push({
      bar: bars.length,
      detail: "the last note is tied but nothing follows it: drop the ~ or write the note it holds into",
    });
  }
  return { notes, errors };
}

export interface Part {
  /** Which voice this is, and what the renderer sounds it as. */
  instrument: string;
  phrase: string;
}

/** Instruments whose notes are HITS rather than pitches. Named here rather than in the renderer
 *  because two things must agree about it: the synth sounds them as noise, and the analysis has to
 *  keep them out of every harmonic measure. A drum part is written in the same notation, and its
 *  pitches choose which drum rather than which note. */
const UNPITCHED = ["drums", "drum", "percussion", "perc", "kit"];

/** Is this part unpitched? Matched on the NAME, the same way the renderer picks a voice, so a brief
 *  may invent `drums-b` and still be treated as percussion by both. */
export function isUnpitched(instrument: string): boolean {
  const key = instrument.toLowerCase();
  return UNPITCHED.some((n) => key.includes(n));
}

export interface Score {
  bpm: number;
  meter: Meter;
  parts: Part[];
  /** One entry per bar, naming that bar's harmony (`D`, `Bm`, `A7`). What players written apart need
   *  in order to agree about the harmony: prose guidance cannot carry a progression, and without one
   *  a run put the bass in D major under a tune in D minor. An entry may name SEVERAL chords
   *  separated by spaces (`"C G"`), which splits the bar evenly between them; a progression that can
   *  only turn over on a downbeat cannot write a pre-chorus, and every run before this one came back
   *  with one chord per bar because that was all the field could hold. Optional, and every
   *  chord-dependent measure is skipped when it is absent. Read it through `chordAt`, never by
   *  indexing: the index is the BAR, and a bar is no longer one chord. */
  chords?: string[];
  /**
   * This piece is built on a repeating pulse, so a steady rhythm section is the INTENT.
   *
   * The one place the brief overrules a measurement, and it exists because the two were found
   * fighting: an arranger asked a bass for "steady eighth notes throughout" and a kit for
   * four-on-the-floor, then the count called both of them dull. A metric cannot read intent, so the
   * brief states it. Deliberately narrow: it relaxes ONE rule (uniform note length) for the rhythm
   * section only, and every other measure still applies to every part.
   */
  groove?: boolean;
}

export interface ParsedPart extends Part {
  notes: Note[];
}

/**
 * Validate and parse a whole score. The renderer calls this and refuses on any error; the smoke
 * calls it to prove the reference score is valid before asserting anything about audio.
 */
export function parseScore(score: Score): { parts: ParsedPart[]; errors: string[] } {
  const errors: string[] = [];
  if (!(score.bpm >= 40 && score.bpm <= 240)) errors.push(`bpm ${score.bpm} is outside 40..240`);
  if (!(score.meter?.beats >= 1 && score.meter.beats <= 16)) errors.push(`meter beats ${score.meter?.beats} is outside 1..16`);
  if (![1, 2, 4, 8, 16].includes(score.meter?.unit)) errors.push(`meter unit ${score.meter?.unit} must be 1, 2, 4, 8 or 16`);
  if (!score.parts?.length) errors.push("a score needs at least one part");
  if (errors.length > 0) return { parts: [], errors };

  const parts: ParsedPart[] = [];
  for (const part of score.parts) {
    const { notes, errors: bad } = parsePhrase(part.phrase, score.meter);
    for (const e of bad) errors.push(`${part.instrument}: ${e.token ? `'${e.token}' ` : ""}${e.detail}`);
    parts.push({ ...part, notes });
  }
  // Parts of different lengths is not an error worth refusing: the shorter one simply stops. Saying
  // so is worth more than refusing, since a model asked to "fix" it would pad with rests it did not
  // mean and the result is the same silence.
  return { parts, errors };
}

/** The chord governing time `t`, in whole notes, or null when the brief named no progression. Bars
 *  past the end of the array hold the last one, so a phrase longer than the progression still has a
 *  harmony to be judged against rather than silently escaping the check. */
export function chordAt(score: Score, t: number): string | null {
  if (!Array.isArray(score.chords) || score.chords.length === 0) return null;
  const barLen = score.meter.beats / score.meter.unit;
  const bar = Math.min(Math.floor(t / barLen + 1e-9), score.chords.length - 1);
  const symbols = String(score.chords[bar] ?? "").trim().split(/\s+/).filter(Boolean);
  if (symbols.length === 0) return null;
  const into = Math.max(0, Math.min(barLen - 1e-9, t - bar * barLen));
  return symbols[Math.min(symbols.length - 1, Math.floor((into / barLen) * symbols.length + 1e-9))];
}

/** Seconds per whole note at this tempo, the one conversion the renderer needs from here. */
export function wholeNoteSeconds(score: Score): number {
  return (60 / score.bpm) * score.meter.unit;
}

/** How long the finished piece runs, which the smoke asserts and the page displays. */
export function durationSeconds(parsed: ParsedPart[], score: Score): number {
  const whole = wholeNoteSeconds(score);
  let end = 0;
  for (const p of parsed) for (const n of p.notes) end = Math.max(end, (n.at + n.dur) * whole);
  return end;
}
