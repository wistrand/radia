// Musical facts computed from a parsed score, and the reason the review stage in this example is
// not decoration.
//
// A MODEL CANNOT HEAR THE WAV. Any "the agents listened to it and improved it" claim would be
// false: nothing in this pipeline has ears. What a model reads well is the score, which is text, and
// what it reasons about badly is whether it is right. So the critic is handed MEASUREMENTS
// alongside the notes, every one of them a fact about the score rather than an opinion of it, and
// its critique has to point at one.
//
// The second reason this exists: it makes the review ASSERTABLE. "A revision improved the piece" is
// otherwise a matter of taste and untestable, which in this repo means it would quietly stop
// working. Here the smoke can require that a named number moved the right way.
//
// The faults measured are the ones PARALLEL AUTHORING creates. Three writers each hold the brief and
// none of them sees the others' parts, so nothing they do individually can catch a clash between
// them: that is a coordination gap, and closing it is the review stage's whole job.

import { isUnpitched, type ParsedPart, type Score } from "./score.ts";

/** Semitone classes of the major scale and the natural minor, from the tonic. */
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const TONIC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** `C major`, `A minor`, `F# minor`. Unknown text yields null, and every key-dependent measure is
 *  then skipped rather than guessed: reporting "0 notes outside the key" for a key we failed to
 *  parse would be a lie in the direction of approval. */
export function parseKey(key: string): { tonic: number; scale: number[] } | null {
  const m = /^([A-Ga-g])([#b]?)\s+(major|minor)$/.exec(key.trim());
  if (!m) return null;
  const tonic = (TONIC[m[1].toUpperCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12) % 12;
  return { tonic, scale: m[3] === "major" ? MAJOR : MINOR };
}

/** Chord tones by quality, from the root. Small and practical: what a brief actually names. */
const QUALITY: Record<string, number[]> = {
  "": [0, 4, 7],
  "maj": [0, 4, 7],
  "m": [0, 3, 7],
  "min": [0, 3, 7],
  "dim": [0, 3, 6],
  "aug": [0, 4, 8],
  "7": [0, 4, 7, 10],
  "m7": [0, 3, 7, 10],
  "maj7": [0, 4, 7, 11],
  "6": [0, 4, 7, 9],
  "m6": [0, 3, 7, 9],
  "sus2": [0, 2, 7],
  "sus4": [0, 5, 7],
};

/** `D`, `Bm`, `A7`, `F#m7`, `Gsus4` as pitch classes. Null for anything unparsed, and every
 *  chord-dependent measure is then skipped rather than guessed. */
export function chordTones(symbol: string): number[] | null {
  const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(symbol.trim());
  if (!m) return null;
  const root = (TONIC[m[1].toUpperCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12) % 12;
  const q = QUALITY[m[3].trim()];
  return q ? q.map((i) => (root + i) % 12) : null;
}

export interface Finding {
  /** What is wrong, in the terms the critic is asked to use. */
  kind: "dissonance" | "parallel" | "out-of-key" | "leap" | "silence" | "off-chord" | "monotony";
  parts: string[];
  bar: number;
  detail: string;
}

export interface Metrics {
  /** Sounding pairs a semitone, tritone or major seventh apart, which is where two parts written
   *  independently collide. */
  dissonance: number;
  /** Consecutive same-direction motion at a fifth or an octave between one pair of parts: the
   *  classic voice-leading fault, and one no single part writer can see. */
  parallels: number;
  /** Notes outside the declared key that are NOT passing: on a strong beat, held for a beat or
   *  more, or jumped into. A short chromatic stepped through is colour, not a mistake, and counting
   *  it drove the writing toward the plainest possible scale. Null when the key could not be parsed. */
  outOfKey: number | null;
  /** Notes on a STRONG beat that are not in that bar's chord, when the brief names a progression.
   *  This is what stops three parts written apart from disagreeing about the harmony: a run where
   *  the bass played D major while the tune played D minor scored zero here only because there was
   *  no progression to score against. Null when the brief names none. */
  offChord: number | null;
  /** Ways a part is DULL rather than wrong: one note length throughout, a line that only steps or
   *  only leaps, a range too narrow to have a shape. Counted as faults because the review loop
   *  optimises whatever it counts, and a loop that counts only mistakes converges on the blandest
   *  score that has none. */
  bland: number;
  /** Melodic jumps wider than an octave that are not answered by a step back the other way. A leap
   *  is the gesture a tune is remembered for; only an unresolved one is a fault. */
  leaps: number;
  /** Bars in which nothing sounds at all. */
  emptyBars: number;
  /** Lowest part's final pitch class relative to the tonic; 0 means it resolves home. */
  endsOnTonic: boolean | null;
  perPart: {
    instrument: string;
    notes: number;
    lowest: number | null;
    highest: number | null;
    /** Distinct note lengths, and the share held by the commonest. A part at 1.00 is a metronome. */
    durations: number;
    uniformity: number;
    /** Share of intervals that are steps (two semitones or less). Near 1 is a line that never
     *  leaps; near 0 is the root-and-fifth pump a bass falls into. Meaningless on a drum part. */
    stepRatio: number;
    /** A drum or percussion part: its notes pick a sound, not a pitch, so it is measured for rhythm
     *  and left out of every harmonic count. Reported so a zero beside it reads as skipped rather
     *  than as clean. */
    unpitched: boolean;
  }[];
  findings: Finding[];
}

/** Which pitches are sounding at time `t`, in whole notes. */
function soundingAt(parts: ParsedPart[], t: number): { part: string; midi: number }[] {
  const out: { part: string; midi: number }[] = [];
  for (const p of parts) {
    for (const n of p.notes) {
      if (n.midi !== null && t >= n.at - 1e-9 && t < n.at + n.dur - 1e-9) out.push({ part: p.instrument, midi: n.midi });
    }
  }
  return out;
}

/** The onset grid: every instant at which any part starts a note, which is where clashes are heard
 *  rather than at an arbitrary sampling rate. */
function onsets(parts: ParsedPart[]): number[] {
  const set = new Set<number>();
  for (const p of parts) for (const n of p.notes) if (n.midi !== null) set.add(Math.round(n.at * 96) / 96);
  return [...set].sort((a, b) => a - b);
}

function barAt(t: number, score: Score): number {
  const perBar = score.meter.beats / score.meter.unit;
  return Math.floor(t / perBar + 1e-9) + 1;
}

export function analyse(parts: ParsedPart[], score: Score, key: string): Metrics {
  const findings: Finding[] = [];
  const k = parseKey(key);
  const grid = onsets(parts);
  // UNPITCHED PARTS ARE NOT HARMONY. A drum's notes choose which drum, so measuring them for
  // clashes, parallels, key or chord tones counts nonsense as faults: a kit landing on a kick and a
  // snare a semitone apart is a rhythm, not a mistake, and it would have flooded the count and
  // hijacked the resolution test, which reads the LOWEST part. They are still measured for DULLNESS,
  // because one note length repeated for eight bars is exactly as dull on a drum as anywhere else.
  const pitched = parts.filter((p) => !isUnpitched(p.instrument));

  // DISSONANCE, judged only where a note BEGINS: a passing clash inside a held note is ordinary
  // music, while two parts starting a semitone apart is the thing to report.
  let dissonance = 0;
  for (const t of grid) {
    const sounding = soundingAt(pitched, t);
    for (let i = 0; i < sounding.length; i++) {
      for (let j = i + 1; j < sounding.length; j++) {
        const gap = Math.abs(sounding[i].midi - sounding[j].midi) % 12;
        if (gap === 1 || gap === 6 || gap === 11) {
          dissonance++;
          findings.push({
            kind: "dissonance",
            parts: [sounding[i].part, sounding[j].part],
            bar: barAt(t, score),
            detail: `${sounding[i].part} and ${sounding[j].part} sound ${gap === 6 ? "a tritone" : "a semitone"} apart`,
          });
        }
      }
    }
  }

  // PARALLELS between each pair of parts, across consecutive onsets.
  let parallels = 0;
  for (let a = 0; a < pitched.length; a++) {
    for (let b = a + 1; b < pitched.length; b++) {
      let prev: { x: number; y: number; interval: number } | null = null;
      for (const t of grid) {
        const s = soundingAt([pitched[a], pitched[b]], t);
        const x = s.find((n) => n.part === pitched[a].instrument)?.midi;
        const y = s.find((n) => n.part === pitched[b].instrument)?.midi;
        if (x === undefined || y === undefined) {
          prev = null;
          continue;
        }
        const interval = Math.abs(x - y) % 12;
        if (prev && (interval === 0 || interval === 7) && prev.interval === interval) {
          const sameDirection = (x - prev.x) * (y - prev.y) > 0;
          if (sameDirection) {
            parallels++;
            findings.push({
              kind: "parallel",
              parts: [pitched[a].instrument, pitched[b].instrument],
              bar: barAt(t, score),
              detail: `${pitched[a].instrument} and ${pitched[b].instrument} move in parallel ${interval === 0 ? "octaves" : "fifths"}`,
            });
          }
        }
        prev = { x, y, interval };
      }
    }
  }

  // OUT OF KEY, OFF CHORD and LEAPS, all per part.
  //
  // A note is judged by its ROLE, not only its pitch. A chromatic passed through on a weak beat is
  // what colour sounds like; the same pitch landed on and held is a wrong note. Counting both the
  // same way is what pushed three writers onto the plainest scale that scored zero.
  const beat = 1 / score.meter.unit;
  const barLen = score.meter.beats / score.meter.unit;
  // The strong beats: the first, and the halfway point of an even meter. Harmony is heard there.
  const strong = (t: number) => {
    const into = Math.round(((t % barLen) / beat) * 96) / 96;
    return Math.abs(into) < 1e-6 || (score.meter.beats % 2 === 0 && Math.abs(into - score.meter.beats / 2) < 1e-6);
  };
  const chordsGiven = Array.isArray(score.chords) && score.chords.length > 0;
  let outOfKey: number | null = k ? 0 : null;
  let offChord: number | null = chordsGiven ? 0 : null;
  let leaps = 0;
  for (const p of pitched) {
    const sounded = p.notes.filter((n) => n.midi !== null);
    for (let i = 0; i < sounded.length; i++) {
      const n = sounded[i];
      const prev = i > 0 ? sounded[i - 1].midi! : null;
      const next = i + 1 < sounded.length ? sounded[i + 1].midi! : null;
      const inFrom = prev === null ? null : Math.abs(n.midi! - prev);
      const outTo = next === null ? null : Math.abs(next - n.midi!);

      if (k && !k.scale.includes(((n.midi! - k.tonic) % 12 + 12) % 12)) {
        // PASSING means stepped into and stepped out of, briefly, off the strong beat. Anything
        // else outside the key is a decision the piece has to own.
        const passing = n.dur < beat + 1e-9 && !strong(n.at) && (inFrom ?? 99) <= 2 && (outTo ?? 99) <= 2;
        if (!passing) {
          outOfKey = (outOfKey ?? 0) + 1;
          findings.push({
            kind: "out-of-key",
            parts: [p.instrument],
            bar: n.bar,
            detail: `${p.instrument} lands on a note outside ${key} in bar ${n.bar} and stays on it`,
          });
        }
      }

      if (chordsGiven && strong(n.at) && n.dur >= beat - 1e-9) {
        const symbol = score.chords![Math.min(Math.floor(n.at / barLen + 1e-9), score.chords!.length - 1)];
        const tones = chordTones(symbol);
        if (tones && !tones.includes(((n.midi! % 12) + 12) % 12)) {
          offChord = (offChord ?? 0) + 1;
          findings.push({
            kind: "off-chord",
            parts: [p.instrument],
            bar: n.bar,
            detail: `${p.instrument} holds a note on a strong beat of bar ${n.bar} that is not in ${symbol}`,
          });
        }
      }

      // A LEAP IS ONLY A FAULT UNSANSWERED. Jumping an octave and turning back is a gesture; jumping
      // and carrying on in the same direction is the part losing its shape.
      if (inFrom !== null && inFrom > 12) {
        const answered = next !== null && Math.sign(next - n.midi!) !== Math.sign(n.midi! - prev!) && (outTo ?? 99) <= 4;
        if (!answered) {
          leaps++;
          findings.push({
            kind: "leap",
            parts: [p.instrument],
            bar: n.bar,
            detail: `${p.instrument} leaps more than an octave in bar ${n.bar} and does not come back`,
          });
        }
      }
    }
  }

  // EMPTY BARS: a whole bar in which nothing sounds is usually a rhythm that lost a bar rather than
  // an intended silence, and it is the one fault that survives every other check.
  const perBar = score.meter.beats / score.meter.unit;
  let bars = 0;
  for (const p of parts) for (const n of p.notes) bars = Math.max(bars, Math.ceil((n.at + n.dur) / perBar - 1e-9));
  let emptyBars = 0;
  for (let b = 0; b < bars; b++) {
    const mid = b * perBar + perBar / 2;
    if (soundingAt(parts, mid).length === 0) {
      emptyBars++;
      findings.push({ kind: "silence", parts: [], bar: b + 1, detail: `nothing sounds in bar ${b + 1}` });
    }
  }

  // MONOTONY, per part. Every other measure here answers "is anything wrong"; these answer "is
  // anything happening", and without them the loop drives the music toward the safest thing that
  // has no faults. Each one names a change a single player can make on its own.
  let bland = 0;
  // THE RHYTHM SECTION: every unpitched part, plus the lowest pitched one, which is the bass by the
  // same reading `endsOnTonic` uses. These are the parts a groove asks to hold a steady pulse.
  const bassLine = pitched.slice().sort((x, y) => lowOf(x) - lowOf(y))[0]?.instrument;
  const rhythmSection = new Set(parts.filter((p) => isUnpitched(p.instrument) || p.instrument === bassLine).map((p) => p.instrument));
  const shape = new Map<string, { durations: number; uniformity: number; stepRatio: number }>();
  for (const p of parts) {
    const sounded = p.notes.filter((n) => n.midi !== null);
    const lengths = new Map<number, number>();
    for (const n of p.notes) lengths.set(n.dur, (lengths.get(n.dur) ?? 0) + 1);
    const uniformity = p.notes.length ? Math.max(...lengths.values()) / p.notes.length : 1;
    const steps = sounded.slice(1).filter((n, i) => Math.abs(n.midi! - sounded[i].midi!) <= 2).length;
    const stepRatio = sounded.length > 1 ? steps / (sounded.length - 1) : 1;
    const low = sounded.length ? Math.min(...sounded.map((n) => n.midi!)) : 0;
    const high = sounded.length ? Math.max(...sounded.map((n) => n.midi!)) : 0;
    shape.set(p.instrument, { durations: lengths.size, uniformity, stepRatio });
    // A drum's PITCHES pick a drum, so its interval ratio and its range say nothing: a kit using
    // three sounds is not "narrow" and a snare answering a kick is not a leap. Rhythm is what a
    // percussion part can be dull at, so the two rhythm checks below still apply to it.
    const rhythmOnly = isUnpitched(p.instrument);

    // A GROOVE EXEMPTS THE RHYTHM SECTION FROM THIS ONE RULE. A pumping eighth-note bass under a
    // four-on-the-floor kit is the genre, not a failure to vary, and only the brief knows which was
    // meant. The lead and the inner voices are held to it either way.
    const steadyOnPurpose = score.groove === true && rhythmSection.has(p.instrument);
    if (!steadyOnPurpose && sounded.length >= 4 && uniformity > 0.85) {
      bland++;
      findings.push({
        kind: "monotony",
        parts: [p.instrument],
        bar: 1,
        detail: `${p.instrument} is ${Math.round(uniformity * 100)}% one note length: give it a rhythm, with longer and shorter notes`,
      });
    }
    // THE SAME BAR AGAIN. Repetition is how music is held together, so this fires only where a bar
    // repeats VERBATIM often enough to be a pump rather than a motif: the run that prompted this
    // had a bass playing one root-and-fifth bar four times in eight. A low step ratio was the first
    // test here and it was wrong: a bass arpeggiating through a good line barely steps at all.
    const cells = new Map<number, string[]>();
    for (const n of p.notes) (cells.get(n.bar) ?? cells.set(n.bar, []).get(n.bar)!).push(`${n.midi}/${n.dur}`);
    const seen = new Set<string>();
    let repeats = 0;
    for (const [, cell] of [...cells.entries()].sort((a, b) => a[0] - b[0])) {
      const sig = cell.join(" ");
      if (seen.has(sig)) repeats++;
      seen.add(sig);
    }
    // A BEAT REPEATS BY DEFINITION, so a kit is held to a far looser bound than a melody: it is
    // flagged only when it never varies AT ALL. Measured on a real run, a four-on-the-floor pattern
    // repeating six bars in eight was reported as a pump, which is the genre being told off for
    // being itself. A drummer should still put a fill somewhere, and 0.85 leaves room for exactly
    // that and nothing less.
    // For a kit the test is EXACT rather than a ratio: every bar identical. A ratio cannot express
    // "never varies" at short lengths, since six identical bars out of six is only 0.83.
    const pumping = rhythmOnly ? repeats === cells.size - 1 : repeats / cells.size > 0.3;
    if (cells.size >= 4 && pumping) {
      bland++;
      findings.push({
        kind: "monotony",
        parts: [p.instrument],
        bar: 1,
        detail: rhythmOnly
          ? `${p.instrument} plays the same bar ${repeats + 1} times over and never varies: put a fill somewhere`
          : `${p.instrument} plays the same bar ${repeats + 1} times over: vary it, or it is a pump rather than a part`,
      });
    }
    if (!rhythmOnly && sounded.length >= 6 && stepRatio > 0.95) {
      bland++;
      findings.push({
        kind: "monotony",
        parts: [p.instrument],
        bar: 1,
        detail: `${p.instrument} only ever steps: one deliberate leap would give it a shape`,
      });
    }
    if (!rhythmOnly && sounded.length >= 6 && high - low < 5) {
      bland++;
      findings.push({
        kind: "monotony",
        parts: [p.instrument],
        bar: 1,
        detail: `${p.instrument} covers under a fourth end to end: it has nowhere to rise to`,
      });
    }
  }

  // Does it come home? Judged on the lowest part, which is where an ear hears the resolution.
  let endsOnTonic: boolean | null = null;
  if (k) {
    const lowest = pitched.slice().sort((x, y) => lowOf(x) - lowOf(y))[0];
    const last = lowest?.notes.filter((n) => n.midi !== null).at(-1)?.midi ?? null;
    endsOnTonic = last === null ? null : ((last - k.tonic) % 12 + 12) % 12 === 0;
  }

  return {
    dissonance,
    parallels,
    outOfKey,
    offChord,
    bland,
    leaps,
    emptyBars,
    endsOnTonic,
    perPart: parts.map((p) => {
      const pitches = p.notes.filter((n) => n.midi !== null).map((n) => n.midi as number);
      const s = shape.get(p.instrument) ?? { durations: 0, uniformity: 1, stepRatio: 1 };
      return {
        instrument: p.instrument,
        notes: pitches.length,
        lowest: pitches.length ? Math.min(...pitches) : null,
        highest: pitches.length ? Math.max(...pitches) : null,
        durations: s.durations,
        uniformity: Number(s.uniformity.toFixed(2)),
        stepRatio: Number(s.stepRatio.toFixed(2)),
        unpitched: isUnpitched(p.instrument),
      };
    }),
    findings,
  };
}

function lowOf(p: ParsedPart): number {
  const pitches = p.notes.filter((n) => n.midi !== null).map((n) => n.midi as number);
  return pitches.length ? Math.min(...pitches) : 999;
}

/**
 * One number the smoke can require to move the right way, so "the review improved it" is a claim
 * about the score rather than about taste. Lower is better.
 *
 * DULLNESS COUNTS HERE, and that is the point of the weights. A loop optimises what it measures, so
 * a score built only from mistakes converges on the safest music that makes none: a real run
 * produced eight bars of unbroken quarter notes, in two keys at once, and scored better every round.
 * `offChord` is weighted like a clash because disagreeing about the harmony IS the clash; `bland`
 * is weighted lower than a wrong note but never zero.
 */
export function faults(m: Metrics): number {
  return m.dissonance +
    m.parallels * 2 +
    (m.outOfKey ?? 0) +
    (m.offChord ?? 0) +
    m.bland * 2 +
    m.leaps +
    m.emptyBars * 3 +
    (m.endsOnTonic === false ? 2 : 0);
}
