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

import { type ParsedPart, type Score, toHz, wholeNoteSeconds } from "./score.ts";

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
}

/** Instruments are matched by NAME, so a brief may invent one and still render: an unknown name
 *  falls back rather than failing, because a model naming its part "pad" should not stop the song. */
const VOICES: Record<string, Voice> = {
  bass: { wave: "triangle", attack: 0.005, decay: 0.09, sustain: 0.75, release: 0.10, gain: 1.0, pan: 0, tone: 0.25 },
  lead: { wave: "saw", attack: 0.004, decay: 0.07, sustain: 0.55, release: 0.14, gain: 0.75, pan: 0.35, tone: 0.75 },
  harmony: { wave: "square", attack: 0.010, decay: 0.10, sustain: 0.45, release: 0.16, gain: 0.55, pan: -0.35, tone: 0.55 },
  pad: { wave: "sine", attack: 0.08, decay: 0.20, sustain: 0.70, release: 0.30, gain: 0.5, pan: -0.15, tone: 0.4 },
  drums: { wave: "noise", attack: 0.001, decay: 0.06, sustain: 0.0, release: 0.05, gain: 0.6, pan: 0.15, tone: 0.9 },
};
const FALLBACK: Voice = { wave: "saw", attack: 0.006, decay: 0.09, sustain: 0.55, release: 0.14, gain: 0.6, pan: 0, tone: 0.6 };

export function voiceFor(instrument: string): Voice {
  const key = instrument.toLowerCase();
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
    const v = voiceFor(part.instrument);
    // Seeded per part index, so adding a part never changes an earlier part's noise.
    const noise = noiseGen(0x5eed + index * 7919);
    const lgain = v.gain * Math.min(1, 1 - v.pan) * 0.5 + v.gain * 0.5 * (v.pan < 0 ? -v.pan : 0);
    const rgain = v.gain * Math.min(1, 1 + v.pan) * 0.5 + v.gain * 0.5 * (v.pan > 0 ? v.pan : 0);
    let lp = 0;

    for (const note of part.notes) {
      if (note.midi === null) continue;
      const hz = toHz(note.midi);
      const start = Math.floor(note.at * whole * sr);
      const held = note.dur * whole;
      const total = held + v.release;
      const count = Math.ceil(total * sr);
      const step = hz / sr;
      let phase = 0;
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

        phase = (phase + step) % 1;
        const raw = waveAt(v.wave, phase, noise) * env;
        lp += v.tone * (raw - lp);
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
