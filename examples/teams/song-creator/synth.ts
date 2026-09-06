// A parsed score becomes audio. Our own renderer, no emulator and no dependency: an example that
// needs a binary the repo cannot ship is one most readers can never run.
//
// DETERMINISM IS THE PROPERTY WORTH PROTECTING, and it is why the noise voice runs off a seeded
// generator rather than `Math.random`. Identical scores render to identical bytes, so the smoke can
// assert a digest instead of "not silent", the audio is content-addressable like every other
// artifact, and two renders of one score dedupe rather than filling the blob store.
//
// It is a tracker, not an orchestra: four waveforms, an envelope per note, one filter, and a pan per
// part. Measured at 81ms for thirty seconds of stereo, so the cost of rendering never enters the
// design. The README says plainly that it sounds like a chiptune, because it does, and hiding that
// would be the example over-promising.

import { isUnpitched, type ParsedPart, type Score, toHz, wholeNoteSeconds } from "./score.ts";

export interface Voice {
  wave: "saw" | "square" | "triangle" | "sine" | "noise";
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
  /** One-pole low-pass coefficient, 1 for none. Rolling the bass off is what stops it competing
   *  with the lead for the same brightness. */
  tone: number;
  /** How many copies of the oscillator to stack, spread by `detune` cents. Two or three slightly
   *  out-of-tune copies beat against each other, which is most of what "thick" means in a synth and
   *  what one bare oscillator can never sound like. Default 1. */
  unison?: number;
  /** Cents between the outermost unison copies. Past about 25 it stops being one note. */
  detune?: number;
  /** A sine an octave below, at this level. What gives a bass weight a triangle alone does not have,
   *  and it costs one more oscillator rather than a bigger engine. Default 0. */
  sub?: number;
  /** Where `tone` ends up by the end of the decay. A filter that closes as the note sounds is the
   *  difference between a pluck and a beep, and it is the single cheapest thing that stops this
   *  sounding like a test tone. Default: no movement. */
  toneEnd?: number;
  /** Pitch wobble: rate in Hz and depth in cents, applied after the attack so the note starts in
   *  tune. A little on a lead reads as expression; a lot reads as broken. */
  vibrato?: { rate: number; depth: number };
}

/** Instruments are matched by NAME, so a brief may invent one and still render: an unknown name
 *  falls back rather than failing, because a model naming its part "pad" should not stop the song. */
const VOICES: Record<string, Voice> = {
  // Triangle plus a sine an octave down, and a filter that shuts almost immediately: the weight is
  // the sub, the shape is the envelope, and rolling the top off keeps it out of the lead's way.
  bass: {
    wave: "triangle",
    attack: 0.004,
    decay: 0.12,
    sustain: 0.62,
    release: 0.10,
    gain: 1.0,
    pan: 0,
    tone: 0.42,
    toneEnd: 0.14,
    sub: 0.55,
  },
  // Three detuned saws under a closing filter, which is the sound people mean by "synth lead". The
  // vibrato is deliberately small: enough to stop a held note sitting perfectly still.
  lead: {
    wave: "saw",
    attack: 0.006,
    decay: 0.16,
    sustain: 0.50,
    release: 0.18,
    gain: 0.62,
    pan: 0.32,
    tone: 0.92,
    toneEnd: 0.34,
    unison: 3,
    detune: 14,
    vibrato: { rate: 5.2, depth: 7 },
  },
  // Squares beat harder than saws, so two are plenty, and it sits darker than the lead on purpose.
  harmony: {
    wave: "square",
    attack: 0.012,
    decay: 0.18,
    sustain: 0.42,
    release: 0.20,
    gain: 0.46,
    pan: -0.32,
    tone: 0.62,
    toneEnd: 0.28,
    unison: 2,
    detune: 9,
  },
  // A pad is all attack and width: slow in, wide detune, and a filter that OPENS rather than shuts.
  pad: {
    wave: "saw",
    attack: 0.20,
    decay: 0.40,
    sustain: 0.75,
    release: 0.45,
    gain: 0.38,
    pan: -0.15,
    tone: 0.12,
    toneEnd: 0.45,
    unison: 3,
    detune: 22,
  },
  drums: { wave: "noise", attack: 0.001, decay: 0.06, sustain: 0.0, release: 0.05, gain: 0.6, pan: 0.15, tone: 0.9 },
};
const FALLBACK: Voice = { wave: "saw", attack: 0.006, decay: 0.14, sustain: 0.55, release: 0.16, gain: 0.55, pan: 0, tone: 0.7, toneEnd: 0.4, unison: 2, detune: 10 };

/**
 * Which drum, from the written pitch. A percussion part uses the same notation as any other, and its
 * pitches choose a sound rather than a note, so the register is the instrument: low is a kick, the
 * middle is a snare, high is a hat. Without this a kit is one noise burst repeated and the rhythm
 * has no shape; with it, `C2/4 F#2/8 F#2/8 D2/4` reads as kick, two hats, snare.
 */
export function drumVoiceFor(midi: number): Voice {
  // A kick is PITCHED, not noise: a low triangle with a fast decay is what gives it a body, and the
  // noise wave alone gives a click with no weight behind it.
  if (midi < 40) return { wave: "triangle", attack: 0.001, decay: 0.10, sustain: 0.0, release: 0.06, gain: 1.1, pan: 0, tone: 0.12 };
  if (midi < 60) return { wave: "noise", attack: 0.001, decay: 0.09, sustain: 0.0, release: 0.08, gain: 0.7, pan: 0.1, tone: 0.5 };
  return { wave: "noise", attack: 0.001, decay: 0.03, sustain: 0.0, release: 0.03, gain: 0.35, pan: 0.25, tone: 0.95 };
}

export function voiceFor(instrument: string): Voice {
  const key = instrument.toLowerCase();
  // Percussion first, and by the SHARED predicate: `score.ts` decides what is unpitched, so a part
  // the analysis excludes from harmony is the same one sounded as noise here. Naming it `percussion`
  // used to fall through to a pitched voice while the analysis already treated it as a drum.
  if (isUnpitched(instrument)) return VOICES.drums;
  for (const name of Object.keys(VOICES)) if (key.includes(name)) return VOICES[name];
  return FALLBACK;
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

function waveAt(wave: Voice["wave"], phase: number, noise: () => number): number {
  switch (wave) {
    case "saw":
      return 2 * phase - 1;
    case "square":
      return phase < 0.5 ? 1 : -1;
    case "triangle":
      return 1 - 4 * Math.abs(phase - 0.5);
    case "sine":
      return Math.sin(2 * Math.PI * phase);
    case "noise":
      return noise();
  }
}

export interface RenderOptions {
  sampleRate?: number;
  /** Seconds of silence kept after the last release, so a page's player does not clip the tail. */
  tail?: number;
}

export interface Rendered {
  wav: Uint8Array;
  seconds: number;
  sampleRate: number;
  peak: number;
}

/**
 * Render every part to one stereo mix.
 *
 * Notes are summed rather than voice-stolen: three parts are three simultaneous oscillators and a
 * part that overlaps itself simply doubles. Normalisation is by the measured peak with a fixed
 * headroom, which keeps the result deterministic where a compressor would not.
 */
export function render(parts: ParsedPart[], score: Score, o: RenderOptions = {}): Rendered {
  const sr = o.sampleRate ?? 44100;
  const whole = wholeNoteSeconds(score);
  const tail = o.tail ?? 0.6;

  let end = 0;
  for (const p of parts) {
    const v = voiceFor(p.instrument);
    for (const n of p.notes) if (n.midi !== null) end = Math.max(end, (n.at + n.dur) * whole + v.release);
  }
  const seconds = end + tail;
  const frames = Math.max(1, Math.ceil(seconds * sr));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);

  parts.forEach((part, index) => {
    const partVoice = voiceFor(part.instrument);
    // A DRUM PART CHANGES VOICE PER NOTE, since its pitch names the drum. Every other part holds one
    // voice for the whole line, which is what an instrument is.
    const kit = isUnpitched(part.instrument);
    // Seeded per part index, so adding a part never changes an earlier part's noise.
    const noise = noiseGen(0x5eed + index * 7919);
    let lp = 0;

    for (const note of part.notes) {
      if (note.midi === null) continue;
      const v = kit ? drumVoiceFor(note.midi) : partVoice;
      const lgain = v.gain * Math.min(1, 1 - v.pan) * 0.5 + v.gain * 0.5 * (v.pan < 0 ? -v.pan : 0);
      const rgain = v.gain * Math.min(1, 1 + v.pan) * 0.5 + v.gain * 0.5 * (v.pan > 0 ? v.pan : 0);
      // A kick is a fixed low thump rather than the written pitch: the note picked the drum, so
      // sounding it at C2 or E2 would make one drum two.
      const hz = kit ? (v.wave === "triangle" ? 55 : toHz(note.midi)) : toHz(note.midi);
      const start = Math.floor(note.at * whole * sr);
      const held = note.dur * whole;
      const total = held + v.release;
      const count = Math.ceil(total * sr);

      // UNISON: copies of the oscillator spread evenly across `detune` cents. They drift in and out
      // of phase with each other, which is the beating that makes a stack sound wide where one
      // oscillator sounds like a test tone. Phases start spread rather than together, or the first
      // milliseconds of every note are one loud copy.
      const stack = Math.max(1, Math.round(v.unison ?? 1));
      const spread = v.detune ?? 0;
      const ratios: number[] = [];
      const phases: number[] = [];
      for (let u = 0; u < stack; u++) {
        const offset = stack === 1 ? 0 : ((u / (stack - 1)) - 0.5) * spread;
        ratios.push(Math.pow(2, offset / 1200));
        phases.push(stack === 1 ? 0 : u / stack);
      }
      const perVoice = 1 / Math.sqrt(stack); // keep a stack from being louder than one oscillator
      const sub = v.sub ?? 0;
      let subPhase = 0;

      for (let i = 0; i < count; i++) {
        const f = start + i;
        if (f >= frames) break;
        const t = i / sr;
        // ADSR: attack, decay to sustain, hold, then release from wherever it was.
        let env: number;
        if (t < v.attack) env = t / v.attack;
        else if (t < v.attack + v.decay) env = 1 - (1 - v.sustain) * ((t - v.attack) / v.decay);
        else if (t < held) env = v.sustain;
        else env = v.sustain * Math.max(0, 1 - (t - held) / v.release);

        // THE FILTER MOVES. Held at `tone` through the attack, then travelling to `toneEnd` across
        // the decay: a lead that starts bright and darkens is a pluck, and one that does not is a
        // beep. Static when the voice names no destination.
        const cutoff = v.toneEnd === undefined
          ? v.tone
          : t < v.attack
          ? v.tone
          : v.tone + (v.toneEnd - v.tone) * Math.min(1, (t - v.attack) / Math.max(v.decay, 1e-6));

        // Vibrato after the attack, so a note starts in tune and then breathes.
        const wobble = v.vibrato && t > v.attack ? Math.pow(2, (v.vibrato.depth * Math.sin(2 * Math.PI * v.vibrato.rate * (t - v.attack))) / 1200) : 1;

        let raw = 0;
        for (let u = 0; u < stack; u++) {
          phases[u] = (phases[u] + (hz * ratios[u] * wobble) / sr) % 1;
          raw += waveAt(v.wave, phases[u], noise) * perVoice;
        }
        if (sub > 0) {
          subPhase = (subPhase + hz / 2 / sr) % 1;
          raw += Math.sin(2 * Math.PI * subPhase) * sub;
        }
        raw *= env;
        lp += cutoff * (raw - lp);
        left[f] += lp * lgain;
        right[f] += lp * rgain;
      }
    }
  });

  let peak = 0;
  for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  // A silent score normalises to silence rather than dividing by zero and producing NaN, which is
  // the one input that would write a file no player can open.
  const norm = peak > 1e-6 ? 0.89 / peak : 0;

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
  for (let i = 0; i < frames; i++) {
    dv.setInt16(44 + i * 4, Math.max(-32768, Math.min(32767, Math.round(left[i] * norm * 32767))), true);
    dv.setInt16(44 + i * 4 + 2, Math.max(-32768, Math.min(32767, Math.round(right[i] * norm * 32767))), true);
  }
  return { wav, seconds, sampleRate: sr, peak };
}

/**
 * The page that plays it, deliberately inert.
 *
 * A shared workspace is served from the isolated artifact origin under `default-src 'none'`, so this
 * page may load its own files and can reach nothing else: no CDN, no fetch, no analytics. That is a
 * constraint to write for rather than discover, and for an audio player it costs nothing.
 */
export function page(title: string, meta: { description: string; key: string; bpm: number; parts: string[]; seconds: number }): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; margin-bottom: .2rem; }
  p.brief { color: #666; margin-top: 0; }
  audio { width: 100%; margin: 1.5rem 0; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: .3rem 1rem; margin: 0; }
  dt { color: #666; }
  dd { margin: 0; }
</style>
<h1>${esc(title)}</h1>
<p class="brief">${esc(meta.description)}</p>
<audio controls preload="metadata" src="song.wav"></audio>
<dl>
  <dt>key</dt><dd>${esc(meta.key)}</dd>
  <dt>tempo</dt><dd>${meta.bpm} bpm</dd>
  <dt>parts</dt><dd>${esc(meta.parts.join(", "))}</dd>
  <dt>length</dt><dd>${meta.seconds.toFixed(1)}s</dd>
</dl>
`;
}
