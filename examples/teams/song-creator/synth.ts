// A parsed score becomes audio. Our own renderer, no emulator and no dependency: an example that
// needs a binary the repo cannot ship is one most readers can never run.
//
// DETERMINISM IS THE PROPERTY WORTH PROTECTING, and it is why the noise voice runs off a seeded
// generator rather than `Math.random`. Identical scores render to identical bytes, so the smoke can
// assert a digest instead of "not silent", the audio is content-addressable like every other
// artifact, and two renders of one score dedupe rather than filling the blob store.
//
// It is a tracker with a mixer, not an orchestra: band-limited oscillators, a resonant two-pole
// filter per note, a stereo unison stack, a drum kit synthesised per hit, and one room every part
// sends to. Measured at 1.05s for thirty seconds of a four-part mix (35ms per second of audio,
// against 15ms for the single-oscillator version this replaced), so the cost of rendering still
// never enters the design: a round of this team takes minutes. The README says plainly that it
// sounds like a synth record rather than an orchestra, because it does, and hiding that would be
// the example over-promising.
//
// Rejected: sampling. One second of a real piano is bigger than this whole example, and a renderer
// that needs assets is one a reader cannot run from a checkout.
//
// WHAT MAKES A SYNTHESISER SOUND LIKE AN ORGAN, since this engine was one for a day and the answer
// is four things rather than a lack of quality: a sustain that holds most of the note's level, a
// filter that has stopped moving once the decay is over, layers at EXACT octaves (a drawbar is
// nothing else), and notes identical to one another. The fixes are in the voice table and in
// `humanize`, `filterLfo`, `pwm` and `SHIMMER_RATIO`; the guard is in the smoke, under "drawbar".

import { isUnpitched, type ParsedPart, type Score, toHz, wholeNoteSeconds } from "./score.ts";

export interface Voice {
  /** `string` is not an oscillator: see `pluckString`. */
  wave: "saw" | "square" | "triangle" | "sine" | "noise" | "string";
  /** Seconds. Attack and decay shape the start; release runs past the note's end. */
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  /** Relative loudness before the mix is normalised. */
  gain: number;
  /** -1 hard left, 0 centre, 1 hard right. Separating the parts is most of what makes three
   *  simultaneous voices legible rather than a smear. */
  pan: number;
  /** Brightness, 0 dark to 1 open, as a filter cutoff (`toneHz`). Rolling the bass off is what
   *  stops it competing with the lead for the same brightness. */
  tone: number;
  /** How many copies of the oscillator to stack, spread by `detune` cents. Two or three slightly
   *  out-of-tune copies beat against each other, which is most of what "thick" means in a synth and
   *  what one bare oscillator can never sound like. Default 1. */
  unison?: number;
  /** Cents between the outermost unison copies. Past about 25 it stops being one note. */
  detune?: number;
  /** How far the unison stack is spread across the stereo field, 0 to 1, around `pan`. A stack that
   *  is wide as well as detuned is the difference between a thick mono note and one the mix has
   *  room inside; it costs a second filter per note, because the two sides no longer carry the same
   *  signal. Default 0. */
  spread?: number;
  /** A sine an octave below, at this level. What gives a bass weight a triangle alone does not have,
   *  and it costs one more oscillator rather than a bigger engine. Default 0. */
  sub?: number;
  /** A copy an octave ABOVE, at this level, detuned so it beats against the note rather than
   *  reinforcing it. Air a low filter would otherwise take all of. EXACT octaves are what a drawbar
   *  organ is made of, and an exact one here made every sustained part sound like one, so this is
   *  offset by `SHIMMER_CENTS` and used sparingly. Default 0. */
  shimmer?: number;
  /** Where `tone` ends up by the end of the decay. A filter that closes as the note sounds is the
   *  difference between a pluck and a beep, and it is the single cheapest thing that stops this
   *  sounding like a test tone. Default: no movement. */
  toneEnd?: number;
  /** Filter emphasis at the cutoff, 0 to 0.95. A little makes a moving filter sing rather than just
   *  darken, which is what a sweep is for. Default 0. */
  resonance?: number;
  /** A one-pole high-pass after the main filter, same brightness scale. What makes a hat a hat and
   *  keeps a snare's rattle out of the bass. Default: none. */
  hpTone?: number;
  /** Duty cycle of the `square` wave, 0.5 being a true square. Anything else is a pulse, which is
   *  thinner and more nasal, and a duty cycle that MOVES (`pwm`) is the difference between a synth
   *  and a drawbar: a static square held at full sustain is an organ stop. */
  pulseWidth?: number;
  /** Pulse-width modulation: rate in Hz, depth as a fraction of the cycle. */
  pwm?: { rate: number; depth: number };
  /** A slow sweep of the cutoff around wherever the envelope has left it, rate in Hz and depth in
   *  octaves. What keeps a HELD note moving after the envelope has settled; without it every long
   *  note is a fixed timbre, which is the other half of sounding like an organ. */
  filterLfo?: { rate: number; depth: number };
  /** How much each note differs from the last, 0 to 1: a few cents of tuning, a few percent of
   *  level, attack and cutoff, drawn per note from a seeded generator. An organ's notes are
   *  identical to each other and an instrument's are not, and this is the cheapest way to say so.
   *  Deterministic, so it costs nothing the digest depends on. */
  humanize?: number;
  /** Pitch wobble: rate in Hz, depth in cents, and the seconds it takes to reach that depth. Applied
   *  after the attack so the note starts in tune, and ramped in because vibrato that is fully
   *  present from the first millisecond is a tremolo stop rather than a player. */
  vibrato?: { rate: number; depth: number; delay?: number };
  /** Frequency multiplier at the note's onset, falling to 1 over `time` seconds. A kick is a pitch
   *  drop with a body, and without one it is a hum with a click on the front. */
  pitchEnv?: { from: number; time: number };
  /** Noise blended in at this level. A snare is a tuned body and a rattle at once, which one
   *  waveform cannot be. Default 0. */
  noiseMix?: number;
  /** Sound this voice at a fixed frequency, whatever the note says. A drum's pitch names the drum,
   *  so a kick written at C2 and at E2 has to be one kick. */
  fixedHz?: number;
  /** Soft saturation before the mix, 0 to 1. Harmonics a filter cannot add back, and what makes a
   *  kick hit rather than merely move. Default 0. */
  drive?: number;
  /**
   * Gain into a HARD clipper, before the filter. 0 for none.
   *
   * Distortion, where `drive` is saturation, and the difference is not a matter of degree: a soft
   * curve applied to a saw mostly compresses it, because a saw is already full of harmonics and
   * rounding its ramp REMOVES them. Measured, a heavy voice built on `drive` alone came out with a
   * thousandth of the upper-harmonic energy of the plain synth lead: darker, not dirtier. Clipping
   * the waveform FLAT is what adds the odd harmonics a driven amplifier is heard by.
   *
   * It runs before the filter for the same reason an amp feeds a speaker: the cabinet is what tames
   * what the gain stage just made. That filter is also what keeps the aliasing in hand, since a
   * hard clipper generates harmonics past Nyquist that no oscillator correction can help with.
   */
  crunch?: number;
  /** How much of this voice goes to the room, 0 to 1. A send rather than a global wet level,
   *  because a kick in a hall is a mess and a pad without one is a wall. Default 0. */
  send?: number;
  /** For `wave: "string"`: seconds for the string to fall 60dB, which sets how long it RINGS as
   *  opposed to how long it is played. The envelope still decides when the note stops (a player
   *  damps a string); this decides what it sounds like while it lasts. */
  stringDecay?: number;
  /** For `wave: "string"`: the loop filter, 0 dark to 1 bright. It is the whole reason to model a
   *  string rather than filter a saw: the signal passes this filter once per round trip, so a
   *  partial ten times the fundamental is filtered ten times as often and dies ten times as fast.
   *  That is what a struck string does and what a one-shot filter sweep can only imitate. */
  damping?: number;
  /** For `wave: "string"`: where the string is plucked, 0 at the bridge to 0.5 at the middle. It
   *  combs the excitation, so a partial with a node at that point is missing, which is why picking
   *  near the bridge is thin and bright and over the hole is round. */
  pluck?: number;
}

/** Instruments are matched by NAME, so a brief may invent one and still render: an unknown name
 *  falls back rather than failing, because a model naming its part "pad" should not stop the song. */
const VOICES: Record<string, Voice> = {
  // Triangle plus a sine an octave down, a pair of near-copies for width, and a filter that shuts
  // almost immediately: the weight is the sub, the shape is the envelope, and rolling the top off
  // keeps it out of the lead's way. Barely any room, because reverb on a bass is mud.
  bass: {
    wave: "triangle",
    attack: 0.004,
    decay: 0.26,
    // WELL UNDER HALF. A bass that holds most of its level for the length of the note is a pedal
    // stop: the note has to fall away after it is struck, or every long one sits there.
    sustain: 0.38,
    release: 0.14,
    gain: 1.0,
    pan: 0,
    tone: 0.50,
    toneEnd: 0.18,
    resonance: 0.12,
    unison: 2,
    detune: 6,
    spread: 0.12,
    sub: 0.60,
    drive: 0.35,
    humanize: 0.5,
    send: 0.05,
  },
  // Three detuned saws spread across the field under a closing resonant filter, which is the sound
  // people mean by "synth lead". The vibrato is deliberately small: enough to stop a held note
  // sitting perfectly still.
  lead: {
    wave: "saw",
    attack: 0.006,
    decay: 0.38,
    sustain: 0.34,
    release: 0.22,
    gain: 0.62,
    pan: 0.32,
    tone: 0.92,
    toneEnd: 0.30,
    resonance: 0.30,
    // The cutoff keeps drifting after the envelope has settled, a third of an octave every four
    // seconds, so a held note is still changing when the ear gets to it.
    filterLfo: { rate: 0.24, depth: 0.33 },
    humanize: 0.7,
    unison: 3,
    detune: 18,
    // WIDTH COSTS BEATING, and the two have to be balanced rather than maximised. Panning the stack
    // hard means each side hears mostly one copy, so the beating that makes a held note move nearly
    // stops: at a spread of 0.55 the smoke's held note measured 9% amplitude movement against the
    // 10% it demands. Kept at 0.38, where the sides still share the whole stack.
    spread: 0.38,
    drive: 0.10,
    send: 0.22,
    vibrato: { rate: 5.2, depth: 8, delay: 0.35 },
  },
  // Squares, sitting darker and opposite the lead on purpose: same room, other side, less air. Two
  // copies measured almost perfectly still on a held note (3% amplitude movement against the lead's
  // 11%), because a square's odd harmonics beat in step rather than against each other, so it takes
  // the same three the lead has.
  harmony: {
    wave: "square",
    attack: 0.012,
    decay: 0.42,
    sustain: 0.30,
    release: 0.24,
    gain: 0.46,
    pan: -0.32,
    tone: 0.70,
    toneEnd: 0.28,
    resonance: 0.20,
    unison: 3,
    detune: 13,
    spread: 0.35,
    // A PULSE THAT SWEEPS, not a square that sits. A square held at a fixed width and a flat
    // sustain is a drawbar, and it was the most organ-like thing in this table; moving the duty
    // cycle slowly is what a two-oscillator synth does instead.
    pulseWidth: 0.42,
    pwm: { rate: 0.17, depth: 0.16 },
    filterLfo: { rate: 0.19, depth: 0.28 },
    humanize: 0.7,
    drive: 0.10,
    send: 0.20,
  },
  // A pad is all attack and width: slow in, four copies spread nearly hard, a filter that OPENS
  // rather than shuts and then keeps drifting, and a good share of the room.
  //
  // NO SHIMMER. An octave-up copy at a fixed level is a drawbar, which is exactly what a stack of
  // exact octaves is for, and on sustained notes it read as an organ however the filter moved. The
  // air comes from the filter opening instead.
  pad: {
    wave: "saw",
    attack: 0.35,
    decay: 0.9,
    sustain: 0.55,
    release: 0.7,
    gain: 0.38,
    pan: -0.15,
    tone: 0.18,
    toneEnd: 0.46,
    resonance: 0.18,
    unison: 4,
    detune: 24,
    spread: 0.85,
    filterLfo: { rate: 0.11, depth: 0.42 },
    humanize: 0.6,
    send: 0.32,
  },
  drums: {
    wave: "noise",
    attack: 0.001,
    decay: 0.06,
    sustain: 0.0,
    release: 0.05,
    gain: 0.6,
    pan: 0.15,
    tone: 0.9,
    send: 0.12,
  },
};
const FALLBACK: Voice = {
  wave: "saw",
  attack: 0.006,
  decay: 0.14,
  sustain: 0.55,
  release: 0.16,
  gain: 0.55,
  pan: 0,
  tone: 0.70,
  toneEnd: 0.40,
  resonance: 0.15,
  unison: 2,
  detune: 10,
  spread: 0.30,
  drive: 0.15,
  send: 0.15,
};

/**
 * Which drum, from the written pitch. A percussion part uses the same notation as any other, and its
 * pitches choose a sound rather than a note, so the register is the instrument: low is a kick, the
 * middle is a snare, high is a hat, and the top of the hat range is an open one. Without this a kit
 * is one noise burst repeated and the rhythm has no shape; with it, `C2/4 F#2/8 F#2/8 D2/4` reads as
 * kick, two hats, snare. The boundaries are the ones `prompts/drums.md` hands the drummer.
 */
export function drumVoiceFor(midi: number): Voice {
  // A kick is PITCHED and it FALLS: a body at 52Hz that starts three and a half times higher and
  // drops within a twentieth of a second. The drop is the beater; without it a kick is a hum with a
  // click on the front, and noise alone is the click with no weight behind it.
  if (midi < 40) {
    return {
      wave: "triangle",
      attack: 0.001,
      decay: 0.26,
      sustain: 0.0,
      release: 0.08,
      gain: 1.15,
      pan: 0,
      tone: 0.38,
      toneEnd: 0.12,
      resonance: 0.08,
      fixedHz: 52,
      pitchEnv: { from: 3.4, time: 0.055 },
      drive: 0.55,
      send: 0.04,
    };
  }
  // A snare is two things at once: a tuned body around 190Hz and a rattle over it. High-passed, so
  // the rattle never fights the kick, and sent to the room hardest of the kit, which is what makes
  // a backbeat sound like it is in a place.
  if (midi < 60) {
    return {
      wave: "triangle",
      attack: 0.001,
      decay: 0.15,
      sustain: 0.0,
      release: 0.10,
      gain: 0.72,
      pan: 0.08,
      tone: 0.82,
      toneEnd: 0.45,
      resonance: 0.22,
      hpTone: 0.035,
      fixedHz: 188,
      noiseMix: 0.85,
      drive: 0.30,
      send: 0.28,
    };
  }
  // Hats are high-passed noise, and the top of the range is the OPEN one: same sound, held. The
  // drummer's prompt asks for an open hat where a phrase turns, and before this the kit had no way
  // to sound one.
  if (midi < 78) {
    return { wave: "noise", attack: 0.001, decay: 0.035, sustain: 0.0, release: 0.03, gain: 0.34, pan: 0.26, tone: 0.98, hpTone: 0.50, send: 0.10 };
  }
  return { wave: "noise", attack: 0.001, decay: 0.30, sustain: 0.0, release: 0.18, gain: 0.30, pan: 0.30, tone: 0.97, hpTone: 0.42, send: 0.30 };
}

/**
 * How a `timbre` reshapes every PITCHED voice. Overrides rather than a second voice table: the
 * relationships between the parts (the bass rolled off, the lead panned wide, the harmony quieter)
 * are the arrangement and must survive a change of sound, so a timbre may say what the oscillator
 * and the envelope do and may not say how the parts sit against each other.
 *
 * A family, never an instrument. The engine is a tracker with four waveforms, so it can be a plucked
 * string or a driven one and it cannot be a harp; naming families is the honest promise.
 * The drums are untouched: a kit is a kit whatever the piece is played on.
 *
 * PAN, GAIN AND SPREAD ARE ALL PLACEMENT, so none of them belongs here. Width was the one that had
 * to be learned: `heavy` set a spread of 0.75, which is how a rhythm guitar is double-tracked and
 * which also pushed the BASS to the edges of a mix that needs it in the middle. The same shape of
 * error as the high-pass it used to carry, and the rule that prevents both is that a timbre says
 * what a voice sounds like and never where it sits.
 */
const TIMBRES: Record<string, Partial<Voice>> = {
  // Struck and left to ring: instant attack, no sustain, a long decay. This is the one the brief
  // could not previously reach, and the reason a run asked for a harp and got three detuned saws.
  // A REAL STRING, not a filtered pluck-shaped envelope. The amplitude envelope stops holding the
  // note (a player damps a string), and `stringDecay` decides what it sounds like while it rings:
  // bright for a moment, then round, changing the whole time. Its predecessor's brightness measured
  // identical at 20ms and at 1s, which is the sound of a filter that has finished its sweep.
  plucked: {
    wave: "string",
    attack: 0.001,
    decay: 0.05,
    sustain: 0.95,
    release: 0.5,
    unison: 2,
    detune: 4,
    tone: 0.95,
    toneEnd: 0.9,
    resonance: 0.05,
    stringDecay: 2.4,
    damping: 0.75,
    pluck: 0.22,
    shimmer: 0,
    drive: 0.08,
    vibrato: undefined,
  },
  // Bowed or breathed: the note arrives late and holds. The unison stays, because two near-copies
  // are what stop a sustained sine reading as a test tone, and a sine holding flat with an octave
  // over it is the closest thing in this file to a drawbar, so it gets a moving filter instead.
  // Driven and saturated: distorted strings, an overdriven organ, anything heavy. A FAMILY like the
  // others, and one this engine can actually be, because saturation is what it does well: two
  // copies detuned and panned hard is how a rhythm guitar is double-tracked, the distortion runs
  // BEFORE the filter the way an amp feeds a speaker, and the high-pass keeps the low end clear for
  // the bass. It exists because a death metal request rendered on the same three saws as a dance
  // track, and the arranger had no word for what it wanted.
  heavy: {
    // A STRING INTO THE AMPLIFIER, which is the actual signal path: a pickup hears a struck string,
    // the gain stage clips it, the cabinet rolls it off. A saw into a clipper is a fuzz pedal with
    // nothing in front of it, and it buzzed at a constant timbre for as long as the note lasted.
    // Damped harder and ringing shorter than the acoustic one: that is a palm mute.
    wave: "string",
    attack: 0.001,
    decay: 0.06,
    sustain: 0.9,
    release: 0.1,
    stringDecay: 2.0,
    damping: 0.8,
    pluck: 0.12,
    unison: 2,
    detune: 11,
    tone: 0.62,
    toneEnd: 0.50,
    resonance: 0.05,
    // NO HIGH-PASS, though a guitar wants one. A timbre reshapes EVERY pitched part, so the 140Hz
    // cut that keeps a rhythm guitar out of the bass's way also took the fundamental off the bass
    // itself (E2 is 82Hz) and the mix measured 5dB quieter with a hole where its weight had been.
    // A filter set in absolute Hz cannot serve two registers; the roles' own `tone` settings do it.
    crunch: 0.55,
    drive: 0,
    humanize: 0.5,
    filterLfo: undefined,
    vibrato: undefined,
    send: 0.12,
  },
  soft: {
    wave: "sine",
    attack: 0.14,
    decay: 0.30,
    sustain: 0.70,
    release: 0.45,
    unison: 2,
    detune: 7,
    resonance: 0.08,
    filterLfo: { rate: 0.15, depth: 0.30 },
    humanize: 0.8,
    drive: 0,
    vibrato: { rate: 4.6, depth: 5, delay: 0.45 },
  },
};

/** The voice for one part, under this piece's timbre. `timbre` is optional so the renderer, the
 *  smoke and any caller holding only an instrument name all keep working: absent or unknown is the
 *  synth set, because a piece should not fail to sound over a word nobody defined. */
export function voiceFor(instrument: string, timbre?: string): Voice {
  const key = instrument.toLowerCase();
  // Percussion first, and by the SHARED predicate: `score.ts` decides what is unpitched, so a part
  // the analysis excludes from harmony is the same one sounded as noise here. Naming it `percussion`
  // used to fall through to a pitched voice while the analysis already treated it as a drum.
  if (isUnpitched(instrument)) return VOICES.drums;
  let base = FALLBACK;
  for (const name of Object.keys(VOICES)) {
    if (key.includes(name)) {
      base = VOICES[name];
      break;
    }
  }
  const over = timbre ? TIMBRES[timbre.toLowerCase()] : undefined;
  return over ? { ...base, ...over } : base;
}

/** The timbres a brief may name, for the kind's `usage` and the smoke. */
export const TIMBRE_NAMES = ["synth", ...Object.keys(TIMBRES)];

/** Per-note variation, seeded by WHERE the note is rather than by a running counter, so a note
 *  sounds the same however the parts around it change. Same reason as the noise source below: a
 *  render has to be repeatable to be content-addressable. */
function jitter(part: number, note: number): () => number {
  let x = (part * 0x9e3779b1 + note * 0x85ebca6b + 0x2545f491) >>> 0;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

/** A deterministic noise source. `Math.random` here would make every render of one score a different
 *  artifact and quietly cost the digest assertion the smoke rests on. */
function noiseGen(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 2147483648) - 1;
  };
}

/**
 * `tone` (0 dark, 1 open) as a cutoff in Hz.
 *
 * The same curve the one-pole coefficient this field used to be already described
 * (`c = 1 - e^(-2*pi*f/sr)`), so every number in the voice table still means what it meant when it
 * was tuned by ear. Clamped below Nyquist, since the filter is stable there and nothing above it is
 * audible anyway.
 */
function toneHz(tone: number, sr: number): number {
  const c = Math.min(0.999, Math.max(0.0001, tone));
  return Math.min(sr * 0.45, Math.max(30, -Math.log(1 - c) * sr / (2 * Math.PI)));
}

/**
 * A two-pole state-variable filter, topology-preserving, so it is stable at any cutoff and can be
 * swept per note without recomputing anything but `g`.
 *
 * Two poles rather than one is most of why this stopped sounding like a beep: a one-pole rolls off
 * at 6dB and leaves everything it was meant to remove faintly present, and it cannot resonate, so a
 * filter sweep only darkened where it should sing. Coefficients move at control rate (every 16
 * samples), which is inaudible and keeps `tan` out of the sample loop.
 */
interface Svf {
  ic1: number;
  ic2: number;
}

/** One sample through the filter, returning the low-pass output. Returns a number rather than the
 *  band and high outputs nothing here uses, because this runs 44100 times a second per side. */
function svfLow(s: Svf, x: number, a1: number, a2: number, a3: number): number {
  const v3 = x - s.ic2;
  const v1 = a1 * s.ic1 + a2 * v3;
  const v2 = s.ic2 + a2 * s.ic1 + a3 * v3;
  s.ic1 = 2 * v1 - s.ic1;
  s.ic2 = 2 * v2 - s.ic2;
  return v2;
}

/**
 * PolyBLEP: the correction that makes a saw and a square band-limited.
 *
 * A naive saw is a step per cycle, and a step has infinite harmonics, so everything above Nyquist
 * folded back down as inharmonic grit that got worse the higher the note. That grit is what "cheap"
 * sounds like, and it is two lines to remove: subtract a polynomial approximation of the band-
 * limited step across the one sample either side of the discontinuity.
 */
function polyBlep(t: number, dt: number): number {
  if (dt <= 0) return 0;
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/**
 * A plucked string: Karplus-Strong, which is a delay line the length of one period with a low-pass
 * in its feedback, started full of noise.
 *
 * WHY A MODEL RATHER THAN A FILTER SWEEP. Every partial goes round the loop at its own rate, so it
 * meets the damping filter once per period and the high ones meet it far more often per second:
 * a struck string is bright for a moment and then round, and its spectrum keeps changing for the
 * whole ring. Measured on the voices this replaced, the ratio of energy above 2kHz to below it
 * stayed FLAT for two seconds (0.005 for `plucked`, 0.06 for `heavy`) because a filter that has
 * finished its envelope is a filter that has stopped moving. Twenty lines buy the thing itself.
 *
 * The delay is read fractionally so vibrato and detune bend the pitch instead of quantising it to
 * whole samples, and the excitation is combed by the pluck position.
 */
interface String1 {
  buf: Float32Array;
  idx: number;
  last: number;
  fb: number;
  damp: number;
}

function pluckString(hz: number, sr: number, noise: () => number, v: Voice): String1 {
  // Room for the pitch to bend a semitone DOWN, since a longer delay is a lower note.
  const n = Math.ceil(sr / Math.max(20, hz * 0.94)) + 4;
  const buf = new Float32Array(n);
  // LEVEL COMPENSATION, so a change of timbre is not a change of mix. `stringDecay` is a number of
  // ROUND TRIPS, and a high note makes more of them per second, so it dies sooner in wall-clock
  // time and carries less energy. Physically true, and left alone it remixed the piece: measured,
  // the bass-to-harmony ratio went from 1.6 under `synth` to 3.0 under `plucked`, which is a
  // rebalance no timbre is allowed to make (`TIMBRES`, on pan, gain and width).
  // The constant is the other half: a plucked note spends most of its length decaying, so it
  // carries about a third of the energy an oscillator holding a steady level does, and the parts
  // that kept an oscillator (the bass keeps its sine sub) drowned the ones that did not. Measured
  // against `synth` on the same phrase, then checked for FLATNESS across four octaves.
  const level = 2.6 * Math.sqrt(hz / 220);
  for (let i = 0; i < n; i++) buf[i] = noise() * level;
  // PLUCK POSITION as a comb: a partial with a node where the string was plucked cannot be excited.
  const p = Math.max(1, Math.round((v.pluck ?? 0.25) * (sr / hz)));
  const src = buf.slice();
  for (let i = 0; i < n; i++) buf[i] = src[i] - src[(i - p + n) % n];
  // Round-trip gain for a 60dB fall in `stringDecay` seconds: the loop runs hz times a second.
  const t = Math.max(0.05, v.stringDecay ?? 2);
  return { buf, idx: 0, last: 0, fb: Math.min(0.9999, Math.pow(0.001, 1 / (t * hz))), damp: Math.min(1, Math.max(0.02, v.damping ?? 0.5)) };
}

function stringAt(s: String1, hz: number, sr: number): number {
  const n = s.buf.length;
  const len = Math.min(n - 2, Math.max(2, sr / hz));
  const rp = (s.idx - len + n) % n;
  const i0 = Math.floor(rp);
  const frac = rp - i0;
  const out = s.buf[i0] * (1 - frac) + s.buf[(i0 + 1) % n] * frac;
  s.last += s.damp * (out - s.last);
  s.buf[s.idx] = s.last * s.fb;
  s.idx = (s.idx + 1) % n;
  return out;
}

function waveAt(wave: Voice["wave"], phase: number, dt: number, noise: () => number, width = 0.5): number {
  switch (wave) {
    case "saw":
      return 2 * phase - 1 - polyBlep(phase, dt);
    // A PULSE, of which a square is the one width. The offset term removes the DC a duty cycle
    // other than half carries, or moving the width would move the whole part's zero line.
    case "square":
      return (phase < width ? 1 : -1) - (2 * width - 1) +
        polyBlep(phase, dt) - polyBlep((phase + 1 - width) % 1, dt);
    // A triangle's harmonics fall off as the square of the partial, so it aliases too quietly to be
    // worth correcting; a sine has nothing to alias.
    case "triangle":
      return 1 - 4 * Math.abs(phase - 0.5);
    case "sine":
      return Math.sin(2 * Math.PI * phase);
    case "noise":
      return noise();
    // A string has state, so it cannot be a function of phase: `stringAt` runs it, and the note
    // loop branches before reaching here. Present so the switch stays exhaustive.
    case "string":
      return 0;
  }
}

/** Equal power, so a part panned wide is as loud as one in the middle. The old law summed to
 *  different energy at different positions, which made the pan a volume control as well. */
function panGains(pan: number): [number, number] {
  const p = (Math.min(1, Math.max(-1, pan)) + 1) * (Math.PI / 4);
  return [Math.cos(p), Math.sin(p)];
}

/**
 * Soft saturation: a Padé approximation of tanh, clamped where it stops approximating one.
 *
 * Rounds a peak instead of clipping it, which is what lets the mix run louder without the
 * normalisation having to duck everything. `shape` is only tanh-like up to about 3, where it
 * happens to reach exactly 1, so clamping there turns the approximation's own failure into the
 * limiter's ceiling. Scaled by `shape(d)` rather than by `d`, or a driven signal comes out QUIETER
 * than it went in: the first version of this cost the master 7dB and made the saturator read as a
 * volume drop.
 */
function shape(v: number): number {
  const c = Math.max(-3, Math.min(3, v));
  return c * (27 + c * c) / (27 + 9 * c * c);
}

/** Flat at the rails. The whole of a distortion pedal, and unlike `soften` it makes harmonics
 *  rather than removing them. */
function clip(x: number): number {
  return x > 1 ? 1 : x < -1 ? -1 : x;
}

function soften(x: number, drive: number): number {
  if (drive <= 0) return x;
  const d = 1 + Math.min(0.66, drive) * 3;
  return shape(x * d) / shape(d);
}

// A small room: four parallel combs into two allpasses per channel, the right side's delays offset
// so the two are not one mono signal wearing headphones. Freeverb's proportions, which are public
// and about as small as a reverb gets while still sounding like a place rather than a metal pipe.
const COMBS = [1116, 1188, 1277, 1356];
const ALLPASS = [556, 441];
const ROOM_OFFSET = 23;
const ROOM_FEEDBACK = 0.80;
const ROOM_DAMP = 0.28;

/** The send bus, in place: what comes back is what the room does with what it was sent. */
function room(channel: Float32Array, sr: number, right: boolean): void {
  const scale = sr / 44100;
  const off = right ? ROOM_OFFSET : 0;
  const mk = (n: number) => new Float32Array(Math.max(2, Math.round((n + off) * scale)));
  const combs = COMBS.map((n) => ({ buf: mk(n), idx: 0, filt: 0 }));
  const aps = ALLPASS.map((n) => ({ buf: mk(n), idx: 0 }));
  for (let i = 0; i < channel.length; i++) {
    const input = channel[i] * 0.25;
    let acc = 0;
    for (const c of combs) {
      const y = c.buf[c.idx];
      c.filt = y * (1 - ROOM_DAMP) + c.filt * ROOM_DAMP;
      c.buf[c.idx] = input + c.filt * ROOM_FEEDBACK;
      c.idx = (c.idx + 1) % c.buf.length;
      acc += y;
    }
    for (const a of aps) {
      const y = a.buf[a.idx];
      const out = y - acc;
      a.buf[a.idx] = acc + y * 0.5;
      a.idx = (a.idx + 1) % a.buf.length;
      acc = out;
    }
    channel[i] = acc;
  }
}

export interface RenderOptions {
  sampleRate?: number;
  /** Seconds of silence kept after the last release, so a page's player does not clip the tail.
   *  Long enough for the room to fall away, since cutting a reverb off is more obvious than a
   *  missing one. */
  tail?: number;
}

export interface Rendered {
  wav: Uint8Array;
  seconds: number;
  sampleRate: number;
  peak: number;
}

/** The octave copy is nine cents sharp, so it beats against the note about once a second instead of
 *  locking to it. A drawbar organ is exact octaves; that is the whole difference. */
const SHIMMER_RATIO = Math.pow(2, 9 / 1200);

/** How often filter coefficients are recomputed. Sixteen samples is a third of a millisecond: below
 *  anything a sweep can reveal, and it keeps `tan` out of the inner loop. */
const CONTROL = 16;

/**
 * Render every part to one stereo mix.
 *
 * Notes are summed rather than voice-stolen: three parts are three simultaneous oscillators and a
 * part that overlaps itself simply doubles. Normalisation is by the measured peak with a fixed
 * headroom, which keeps the result deterministic where a compressor would not.
 *
 * THE FILTER IS PER NOTE, not per part. One filter state carried across a part's notes meant a
 * note inherited wherever the previous one left off, and since notes are rendered in written order
 * rather than in time order, what it inherited was not even the note that came before it in the
 * mix. Each note now opens its own two filters, one per side of the stereo field.
 */
export function render(parts: ParsedPart[], score: Score, o: RenderOptions = {}): Rendered {
  const sr = o.sampleRate ?? 44100;
  const whole = wholeNoteSeconds(score);
  const tail = o.tail ?? 1.1;

  let end = 0;
  for (const p of parts) {
    const v = voiceFor(p.instrument, score.timbre);
    // Per NOTE for a kit, since its voice is per note: an open hat rings three times longer than
    // the part-level voice says, and asking the wrong voice would cut the last one short.
    const kit = isUnpitched(p.instrument);
    for (const n of p.notes) {
      if (n.midi === null) continue;
      end = Math.max(end, (n.at + n.dur) * whole + (kit ? drumVoiceFor(n.midi).release : v.release));
    }
  }
  const seconds = end + tail;
  const frames = Math.max(1, Math.ceil(seconds * sr));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  // The room is a SEND: every voice decides how much of itself goes there, so a kick can stay dry
  // in the same mix a pad is soaked in.
  const sendL = new Float32Array(frames);
  const sendR = new Float32Array(frames);
  let wetted = false;

  parts.forEach((part, index) => {
    const partVoice = voiceFor(part.instrument, score.timbre);
    // A DRUM PART CHANGES VOICE PER NOTE, since its pitch names the drum. Every other part holds one
    // voice for the whole line, which is what an instrument is.
    const kit = isUnpitched(part.instrument);
    // Seeded per part index, so adding a part never changes an earlier part's noise.
    const noise = noiseGen(0x5eed + index * 7919);

    let noteIndex = 0;
    for (const note of part.notes) {
      if (note.midi === null) continue;
      const v = kit ? drumVoiceFor(note.midi) : partVoice;
      const [panL, panR] = panGains(v.pan);
      // WHAT MAKES THIS AN INSTRUMENT RATHER THAN A KEYBOARD: every note is a few cents, a few
      // percent of level, a slightly different attack and a slightly different cutoff away from the
      // one before it. An organ's notes are identical to each other, and identical notes were most
      // of why a held chord here sounded like a drawbar.
      const r = jitter(index, noteIndex++);
      const h = v.humanize ?? 0;
      const vary = (spread: number) => 1 + (r() - 0.5) * spread * h;
      const gainJit = vary(0.20);
      const attack = Math.max(0.0005, v.attack * vary(0.5));
      const cutJit = vary(0.22);
      const tuneJit = (r() - 0.5) * 5 * h; // cents, the whole note off together
      // A drum sounds at its own frequency: the note picked the drum, so sounding it at C2 or E2
      // would make one drum two.
      const hz = v.fixedHz ?? toHz(note.midi);
      const start = Math.floor(note.at * whole * sr);
      const held = note.dur * whole;
      const total = held + v.release;
      const count = Math.ceil(total * sr);

      // UNISON: copies of the oscillator spread evenly across `detune` cents AND across the stereo
      // field. They drift in and out of phase with each other, which is the beating that makes a
      // stack sound wide where one oscillator sounds like a test tone; panning them apart is what
      // turns that beating into width instead of a thicker middle. Phases start spread rather than
      // together, or the first milliseconds of every note are one loud copy.
      const stack = Math.max(1, Math.round(v.unison ?? 1));
      const spread = v.detune ?? 0;
      const width = v.spread ?? 0;
      const ratios: number[] = [];
      const phases: number[] = [];
      const uL: number[] = [];
      const uR: number[] = [];
      for (let u = 0; u < stack; u++) {
        const offset = (stack === 1 ? 0 : ((u / (stack - 1)) - 0.5) * spread) + tuneJit;
        ratios.push(Math.pow(2, offset / 1200));
        phases.push(stack === 1 ? 0 : u / stack);
        const place = stack === 1 ? 0 : ((u / (stack - 1)) - 0.5) * 2 * width;
        const [l, r] = panGains(v.pan + place);
        uL.push(l);
        uR.push(r);
      }
      const perVoice = 1 / Math.sqrt(stack); // keep a stack from being louder than one oscillator
      // ONE STRING PER COPY, excited once at the note's onset. Two strings a few cents apart is a
      // twelve-string or a double-tracked guitar, and it costs a second delay line.
      const strings = v.wave === "string" ? ratios.map((r) => pluckString(hz * r, sr, noise, v)) : null;
      const sub = v.sub ?? 0;
      const shimmer = v.shimmer ?? 0;
      const noiseMix = v.noiseMix ?? 0;
      const send = v.send ?? 0;
      const drive = v.drive ?? 0;
      const crunch = v.crunch ?? 0;
      // 1 is unity into the clipper and nothing happens; the useful range is well past it, since a
      // note has to be driven above the rails before any of it flattens. FAR past it for a string:
      // an amplifier's sustain is its gain stage still clipping a decayed note, so the tail has to
      // arrive above the rails too. At 11x the heavy voice fell 30dB in a second like an unplugged
      // guitar; the number is what makes a held power chord hold.
      const crunchGain = 1 + crunch * 60;
      const k = 2 - 1.8 * Math.min(0.95, Math.max(0, v.resonance ?? 0));
      const hpCut = v.hpTone === undefined ? 0 : 1 - Math.exp(-2 * Math.PI * toneHz(v.hpTone, sr) / sr);
      let subPhase = 0;
      let shimmerPhase = 0;
      // One filter per side, because the two sides carry different signals once the stack is spread.
      const fL: Svf = { ic1: 0, ic2: 0 };
      const fR: Svf = { ic1: 0, ic2: 0 };
      let hpL = 0, hpR = 0;
      let g = 0, a1 = 0, a2 = 0, a3 = 0;

      for (let i = 0; i < count; i++) {
        const f = start + i;
        if (f >= frames) break;
        const t = i / sr;
        // ADSR: attack, decay to sustain, hold, then release from wherever it was.
        let env: number;
        if (t < attack) env = t / attack;
        else if (t < attack + v.decay) env = 1 - (1 - v.sustain) * ((t - attack) / v.decay);
        else if (t < held) env = v.sustain;
        else env = v.sustain * Math.max(0, 1 - (t - held) / v.release);

        // THE FILTER MOVES, AND KEEPS MOVING. Held at `tone` through the attack, travelling to
        // `toneEnd` across the decay, and then swept slowly by `filterLfo` for as long as the note
        // lasts. The envelope alone settles after the decay, and a held note whose timbre has
        // stopped changing is an organ stop however it started: that was most of what the first
        // version of this engine sounded like.
        if (i % CONTROL === 0) {
          const swept = v.toneEnd === undefined
            ? v.tone
            : t < attack
            ? v.tone
            : v.tone + (v.toneEnd - v.tone) * Math.min(1, (t - attack) / Math.max(v.decay, 1e-6));
          const lfo = v.filterLfo ? Math.pow(2, v.filterLfo.depth * Math.sin(2 * Math.PI * v.filterLfo.rate * t)) : 1;
          g = Math.tan(Math.PI * Math.min(0.49, toneHz(swept, sr) * cutJit * lfo / sr));
          a1 = 1 / (1 + g * (g + k));
          a2 = g * a1;
          a3 = g * a2;
        }

        // Vibrato after the attack, RAMPED IN over its delay: a wobble at full depth from the first
        // millisecond is a tremolo stop, not a player.
        const vib = v.vibrato && t > attack
          ? v.vibrato.depth * Math.min(1, (t - attack) / Math.max(1e-6, v.vibrato.delay ?? 0.3)) *
            Math.sin(2 * Math.PI * v.vibrato.rate * (t - attack))
          : 0;
        const wobble = vib === 0 ? 1 : Math.pow(2, vib / 1200);
        // The duty cycle, moving. A pulse whose width sweeps is the classic way a two-oscillator
        // synth stops sounding like a keyboard, and it costs one sine.
        const duty = v.pwm ? (v.pulseWidth ?? 0.5) + v.pwm.depth * Math.sin(2 * Math.PI * v.pwm.rate * t) : (v.pulseWidth ?? 0.5);
        const pulse = Math.min(0.92, Math.max(0.08, duty));
        // The pitch drop that makes a kick a kick, spent within its first fiftieth of a second.
        const bend = v.pitchEnv ? 1 + (v.pitchEnv.from - 1) * Math.max(0, 1 - t / v.pitchEnv.time) : 1;

        let rawL = 0, rawR = 0;
        for (let u = 0; u < stack; u++) {
          const f = hz * ratios[u] * wobble * bend;
          let s: number;
          if (strings) {
            s = stringAt(strings[u], f, sr) * perVoice;
          } else {
            const dt = f / sr;
            phases[u] = (phases[u] + dt) % 1;
            s = waveAt(v.wave, phases[u], dt, noise, pulse) * perVoice;
          }
          rawL += s * uL[u];
          rawR += s * uR[u];
        }
        // THE WHOLE NOTE DECAYS, not only the string. A string voice holds its amplitude envelope
        // open (the string is what runs out), which left the layers that are still oscillators —
        // the bass's sine sub above all — ringing at full level under a pluck that had died. The
        // bass then drowned every other part: measured against the arrangement's 2:1, the
        // bass-to-harmony ratio reached 7:1 under `plucked`, and the two plucked songs in the space
        // rendered nearly mono because the centred bass was all that was left.
        const layer = strings ? Math.exp((-6.908 * t) / Math.max(0.05, v.stringDecay ?? 2)) : 1;
        if (sub > 0) {
          subPhase = (subPhase + (hz * bend) / 2 / sr) % 1;
          const s = Math.sin(2 * Math.PI * subPhase) * sub * layer;
          rawL += s * panL;
          rawR += s * panR;
        }
        if (shimmer > 0) {
          const dt = (hz * wobble * bend * 2 * SHIMMER_RATIO) / sr;
          shimmerPhase = (shimmerPhase + dt) % 1;
          const s = waveAt(v.wave, shimmerPhase, dt, noise, pulse) * shimmer * layer;
          rawL += s * panL;
          rawR += s * panR;
        }
        if (noiseMix > 0) {
          // Two draws, so the rattle is not the same signal on both sides: a mono noise layer
          // collapses a snare into the middle however wide the body is panned.
          rawL += noise() * noiseMix * panL * layer;
          rawR += noise() * noiseMix * panR * layer;
        }
        rawL *= env;
        rawR *= env;

        if (crunch > 0) {
          rawL = clip(rawL * crunchGain);
          rawR = clip(rawR * crunchGain);
        }
        let outL = svfLow(fL, rawL, a1, a2, a3);
        let outR = svfLow(fR, rawR, a1, a2, a3);
        if (hpCut > 0) {
          hpL += hpCut * (outL - hpL);
          hpR += hpCut * (outR - hpR);
          outL -= hpL;
          outR -= hpR;
        }
        if (drive > 0) {
          outL = soften(outL, drive);
          outR = soften(outR, drive);
        }
        outL *= v.gain * gainJit;
        outR *= v.gain * gainJit;
        left[f] += outL;
        right[f] += outR;
        if (send > 0) {
          sendL[f] += outL * send;
          sendR[f] += outR * send;
          wetted = true;
        }
      }
    }
  });

  // The room, then the mix bus: block DC (asymmetric waves and a sub build an offset that eats
  // headroom nothing can hear), soften the peaks, and normalise what is left.
  if (wetted) {
    room(sendL, sr, false);
    room(sendR, sr, true);
    for (let i = 0; i < frames; i++) {
      left[i] += sendL[i];
      right[i] += sendR[i];
    }
  }
  let dcL = 0, dcR = 0, prevL = 0, prevR = 0;
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    const xl = left[i], xr = right[i];
    dcL = xl - prevL + 0.995 * dcL;
    dcR = xr - prevR + 0.995 * dcR;
    prevL = xl;
    prevR = xr;
    left[i] = dcL;
    right[i] = dcR;
    peak = Math.max(peak, Math.abs(dcL), Math.abs(dcR));
  }
  // A silent score normalises to silence rather than dividing by zero and producing NaN, which is
  // the one input that would write a file no player can open.
  const norm = peak > 1e-6 ? 1 / peak : 0;

  const wav = new Uint8Array(44 + frames * 4);
  const dv = new DataView(wav.buffer);
  const enc = new TextEncoder();
  wav.set(enc.encode("RIFF"), 0);
  dv.setUint32(4, 36 + frames * 4, true);
  wav.set(enc.encode("WAVEfmt "), 8);
  dv.setUint32(16, 16, true); // PCM chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 2, true); // stereo
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 4, true); // byte rate
  dv.setUint16(32, 4, true); // block align
  dv.setUint16(34, 16, true); // bits
  wav.set(enc.encode("data"), 36);
  dv.setUint32(40, frames * 4, true);
  const sample = (x: number) => Math.max(-32768, Math.min(32767, Math.round(soften(x * norm, 0.35) * 0.94 * 32767)));
  for (let i = 0; i < frames; i++) {
    dv.setInt16(44 + i * 4, sample(left[i]), true);
    dv.setInt16(44 + i * 4 + 2, sample(right[i]), true);
  }
  return { wav, seconds, sampleRate: sr, peak };
}
