/**
 * Deterministic synthesizer for the example track.
 *
 * The loop is 12 s, 48 kHz, stereo, 100 BPM in 4/4 — exactly 20 beats / 5 bars,
 * so it restarts on a downbeat. Four voices make it sound like a piece of music
 * rather than a test tone: a four-on-the-floor kick, off-beat closed hats, a
 * plucked saw-ish bass and a soft additive pad, one chord per bar
 * (Am – F – C – G – Em).
 *
 * Determinism matters because the dev server and the two tests must agree on
 * the exact bytes: the only randomness is a seeded LCG (no `Math.random`, no
 * `Date.now`), so every process renders sample-identical audio.
 *
 * Looping: voices are rendered into `TRACK_FRAMES + TAIL_FRAMES` frames and the
 * one-second overhang is folded back over the first second. Release tails that
 * run past the end reappear at the start, so the loop seam is continuous
 * instead of a click.
 */

import {
  SAMPLE_RATE,
  TRACK_BPM,
  TRACK_FRAMES,
  TRACK_SECONDS,
} from '../shared/audio.ts';

/** One rendered loop, planar per channel (what `encodeWav16` / the PCM stream consume). */
export interface Track {
  sampleRate: number;
  channels: number;
  bpm: number;
  durationSeconds: number;
  frames: number;
  channelsData: [Float32Array, Float32Array];
}

const CHANNELS = 2;
const BPM = TRACK_BPM;
const DURATION_SECONDS = TRACK_SECONDS;
const FRAMES = TRACK_FRAMES; // 576_000
const TAIL_FRAMES = SAMPLE_RATE; // 1 s of render headroom, folded back after mixing
const BEAT_SECONDS = 60 / BPM; // 0.6 s at 100 BPM
const BEAT_FRAMES = Math.round(SAMPLE_RATE * BEAT_SECONDS); // 28_800
const EIGHTH_FRAMES = BEAT_FRAMES / 2;
const BAR_SECONDS = BEAT_SECONDS * 4;
const BAR_FRAMES = BEAT_FRAMES * 4; // 115_200
const BEATS = FRAMES / BEAT_FRAMES; // 20 — an exact beat count, so the loop is beat-accurate
const BARS = FRAMES / BAR_FRAMES; // 5
const TAU = Math.PI * 2;

/**
 * One chord per bar; the fifth bar resolves back into the first.
 * Bass roots sit in the 41–66 Hz range so the bass carries the low end; the
 * pad tones are voiced around A3–G4 so it stays out of the bass's way.
 */
const PROGRESSION: readonly { bass: number; tones: readonly [number, number, number] }[] = [
  { bass: 55.0, tones: [220.0, 261.63, 329.63] }, // Am: A1 | A3 C4 E4
  { bass: 43.65, tones: [174.61, 220.0, 261.63] }, // F:  F1 | F3 A3 C4
  { bass: 65.41, tones: [261.63, 329.63, 392.0] }, // C:  C2 | C4 E4 G4
  { bass: 49.0, tones: [196.0, 246.94, 293.66] }, // G:  G1 | G3 B3 D4
  { bass: 41.2, tones: [164.81, 196.0, 246.94] }, // Em: E1 | E3 G3 B3
];

/**
 * Bass riff per bar, placed on eighth notes (0 = downbeat). `interval` is a
 * frequency multiplier: 1 = root, 1.5 = fifth, 2 = octave.
 */
const BASS_PATTERN: readonly { eighth: number; interval: number; beats: number; amp: number }[] = [
  { eighth: 0, interval: 1, beats: 0.5, amp: 1.0 },
  { eighth: 2, interval: 1, beats: 0.4, amp: 0.72 },
  { eighth: 3, interval: 1.5, beats: 0.4, amp: 0.55 },
  { eighth: 5, interval: 1, beats: 0.4, amp: 0.85 },
  { eighth: 6, interval: 1, beats: 0.3, amp: 0.6 },
  { eighth: 7, interval: 2, beats: 0.25, amp: 0.55 },
];

/**
 * Seeded 32-bit linear congruential generator (Numerical Recipes constants),
 * returning floats in [0, 1). A tiny PRNG keeps the noise sources (hats)
 * deterministic without pulling in a dependency.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * Four-on-the-floor kick: a pitch-swept sine (the classic "thump" is a fast
 * downward pitch envelope, not a fixed low tone) plus a short click transient
 * that helps it cut through on small speakers. Rendered on every beat.
 */
function mixKick(left: Float32Array, right: Float32Array): void {
  const length = Math.round(0.5 * SAMPLE_RATE);
  for (let beat = 0; beat < BEATS; beat += 1) {
    const start = beat * BEAT_FRAMES;
    let phase = 0;
    for (let i = 0; i < length; i += 1) {
      const index = start + i;
      if (index >= left.length) break;
      const t = i / SAMPLE_RATE;
      // Exponential sweep from ~140 Hz down to 48 Hz over ~45 ms.
      phase += (TAU * (48 + 92 * Math.exp(-t / 0.045))) / SAMPLE_RATE;
      const env = Math.min(1, t / 0.0015) * Math.exp(-t * 8); // 1.5 ms attack, then decay
      const click = 0.12 * Math.sin(TAU * 1800 * t) * Math.exp(-t * 300);
      const value = (0.85 * Math.sin(phase) + click) * env;
      left[index] += value;
      right[index] += value;
    }
  }
}

/**
 * Off-beat closed hats plus quiet 16th "ghosts". Panning hats slightly wide
 * makes the stereo image move without making every hit identical.
 *
 * The highpass is a one-sample difference (`noise - previous`): for a hat burst
 * it emphasises the top end, which is what a closed hi-hat is, for free.
 */
function mixHats(left: Float32Array, right: Float32Array, random: () => number): void {
  const hit = (startFrame: number, amp: number, decay: number): void => {
    const length = Math.ceil(decay * 4 * SAMPLE_RATE); // ~4 time constants is inaudible
    let previous = 0;
    for (let i = 0; i < length; i += 1) {
      const index = startFrame + i;
      if (index >= left.length) break;
      const t = i / SAMPLE_RATE;
      const noise = random() * 2 - 1;
      const highpassed = noise - previous;
      previous = noise;
      const value = highpassed * amp * Math.exp(-t / decay);
      left[index] += value * 0.7; // hats sit slightly right of centre
      right[index] += value;
    }
  };
  for (let beat = 0; beat < BEATS; beat += 1) {
    const accent = beat % 4 === 3 ? 0.26 : 0.19; // a little lift into the next bar
    hit((beat + 0.5) * BEAT_FRAMES, accent, 0.028);
    if (beat % 2 === 1) {
      hit((beat + 0.25) * BEAT_FRAMES, 0.07, 0.012);
    }
  }
}

/**
 * Plucked saw-ish bass, centre-panned, with a short hold + release per note.
 *
 * A real sawtooth has every harmonic at 1/n; four sines at declining weights is
 * a cheap stand-in that stays mellow enough to sit under the pad. The phase is
 * accumulated per sample (rather than recomputed from a global time) so each
 * note starts at the same phase and thus sounds identical from bar to bar.
 */
function mixBass(left: Float32Array, right: Float32Array): void {
  for (let bar = 0; bar < BARS; bar += 1) {
    const root = PROGRESSION[bar].bass;
    for (const note of BASS_PATTERN) {
      const start = bar * BAR_FRAMES + note.eighth * EIGHTH_FRAMES;
      const hold = note.beats * BEAT_SECONDS;
      const release = 0.06;
      const length = Math.ceil((hold + release) * SAMPLE_RATE);
      const frequency = root * note.interval;
      let phase = 0;
      for (let i = 0; i < length; i += 1) {
        const index = start + i;
        if (index >= left.length) break;
        const t = i / SAMPLE_RATE;
        phase += (TAU * frequency) / SAMPLE_RATE;
        let env = Math.min(1, t / 0.004) * (0.35 + 0.65 * Math.exp(-t * 6)); // 4 ms pick attack
        if (t > hold) env *= Math.max(0, 1 - (t - hold) / release);
        const timbre =
          Math.sin(phase) +
          0.5 * Math.sin(2 * phase) +
          0.25 * Math.sin(3 * phase) +
          0.12 * Math.sin(4 * phase);
        const value = 0.35 * note.amp * env * timbre;
        left[index] += value;
        right[index] += value;
      }
    }
  }
}

/**
 * Soft additive pad: one chord per bar, slow swell, constant-power stereo
 * spread. Each voice is panned with cos/sin gains (constant-power panning keeps
 * the perceived loudness equal when a voice moves across the stereo field) and
 * gets a slow amplitude "shimmer" that is deliberately beat-agnostic, so the
 * pad breathes against the drums instead of pumping with them.
 */
function mixPad(left: Float32Array, right: Float32Array): void {
  const voices: readonly { pan: number; gain: number }[] = [
    { pan: -0.65, gain: 0.105 },
    { pan: 0.0, gain: 0.085 },
    { pan: 0.65, gain: 0.105 },
  ];
  const attack = 0.35;
  const hold = BAR_SECONDS;
  const release = 0.7;

  for (let bar = 0; bar < BARS; bar += 1) {
    const start = bar * BAR_FRAMES;
    const chord = PROGRESSION[bar].tones;
    for (let v = 0; v < chord.length; v += 1) {
      const frequency = chord[v];
      const { pan, gain } = voices[v];
      const leftGain = Math.cos(((pan + 1) * Math.PI) / 4) * gain;
      const rightGain = Math.sin(((pan + 1) * Math.PI) / 4) * gain;
      const length = Math.ceil((hold + release) * SAMPLE_RATE);
      let phase = 0;
      for (let i = 0; i < length; i += 1) {
        const index = start + i;
        if (index >= left.length) break;
        const t = i / SAMPLE_RATE;
        phase += (TAU * frequency) / SAMPLE_RATE;
        const ramp = Math.min(1, t / attack);
        const swell = ramp * ramp * (3 - 2 * ramp); // smoothstep attack, no click
        const tail = t > hold ? Math.max(0, 1 - (t - hold) / release) : 1;
        const shimmer = 0.85 + 0.15 * Math.sin(TAU * 0.25 * t + v * 1.7); // slow, beat-agnostic
        const value = (Math.sin(phase) + 0.22 * Math.sin(2 * phase)) * swell * tail * tail * shimmer;
        left[index] += value * leftGain;
        right[index] += value * rightGain;
      }
    }
  }
}

/**
 * Fold the overhang onto the start, remove DC, and peak-normalise to exactly 0.8.
 *
 * - Folding is what makes the loop seamless: whatever was still ringing after
 *   12 s is added to the top of the loop where it belongs musically.
 * - DC removal keeps a constant offset out of the waveform (it would bias the
 *   visualiser and waste headroom). The whole mix is summed in float64.
 * - Peak-normalising to 0.8 leaves ~2 dB of headroom so browser resampling and
 *   the master gain cannot clip the example.
 */
function finalize(
  left: Float32Array,
  right: Float32Array,
): { left: Float32Array; right: Float32Array } {
  for (let i = 0; i < TAIL_FRAMES; i += 1) {
    left[i] += left[FRAMES + i];
    right[i] += right[FRAMES + i];
  }
  const outLeft = left.subarray(0, FRAMES);
  const outRight = right.subarray(0, FRAMES);

  let meanLeft = 0;
  let meanRight = 0;
  for (let i = 0; i < FRAMES; i += 1) {
    meanLeft += outLeft[i];
    meanRight += outRight[i];
  }
  meanLeft /= FRAMES;
  meanRight /= FRAMES;

  let peak = 0;
  for (let i = 0; i < FRAMES; i += 1) {
    outLeft[i] -= meanLeft;
    outRight[i] -= meanRight;
    const magnitude = Math.max(Math.abs(outLeft[i]), Math.abs(outRight[i]));
    if (magnitude > peak) peak = magnitude;
  }
  // One shared gain for both channels: normalising channels separately would
  // shift the stereo balance.
  const gain = peak > 0 ? 0.8 / peak : 0;
  for (let i = 0; i < FRAMES; i += 1) {
    outLeft[i] *= gain;
    outRight[i] *= gain;
  }
  return { left: outLeft, right: outRight };
}

/** Render the 12 s demo loop. Byte-identical on every call and in every process. */
export function renderTrack(): Track {
  const mixLeft = new Float32Array(FRAMES + TAIL_FRAMES);
  const mixRight = new Float32Array(FRAMES + TAIL_FRAMES);
  const random = makeRandom(0x5eed_1a2b);

  mixKick(mixLeft, mixRight);
  mixHats(mixLeft, mixRight, random);
  mixBass(mixLeft, mixRight);
  mixPad(mixLeft, mixRight);
  const { left, right } = finalize(mixLeft, mixRight);

  return {
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    bpm: BPM,
    durationSeconds: DURATION_SECONDS,
    frames: FRAMES,
    channelsData: [left, right],
  };
}
