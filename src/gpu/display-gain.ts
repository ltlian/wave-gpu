/**
 * Display-only auto-gain for the waveform view.
 *
 * A column of the visualizer only covers 8 samples (~0.17 ms at 48 kHz) and the
 * synth loop is bass-heavy, so raw column excursions are tiny even when the
 * audio is loud — drawing them directly gives a flat line. This module tracks a
 * rolling peak of the whole frame (fast attack so transients are picked up
 * immediately, slow decay so the picture doesn't pump) and scales a *copy* of
 * the samples so the loudest one reaches ±1.
 *
 * It is deliberately separate from the audio and from the readout: the caller
 * hands in a scratch buffer, this module mutates only that buffer, and the raw
 * samples / FrameMeta values stay exactly as measured. The applied gain is
 * exposed (`gain`) purely so the UI can show what the display is doing.
 */

export interface DisplayGainOptions {
  /** Per-frame coefficient while the peak is rising (0..1; higher = faster). */
  attack: number;
  /** Per-frame coefficient while the peak is falling (0..1; higher = faster). */
  decay: number;
  /**
   * Lower bound for the tracked peak. Near-silence would otherwise ask for an
   * enormous gain and amplify the noise floor into the whole canvas.
   */
  floor: number;
  /** Upper bound for the gain, so the floor can't be exceeded by accident. */
  maxGain: number;
}

/**
 * Coefficients are per applied frame, tuned for 60 fps: the attack responds
 * within one or two frames (so a loud transient cannot be clipped by a gain that
 * lags behind), the decay takes roughly a third of a second to come back down,
 * which reads as a steady waveform instead of a pumping one.
 */
export const DEFAULT_DISPLAY_GAIN_OPTIONS: Readonly<DisplayGainOptions> = {
  attack: 0.7,
  decay: 0.06,
  floor: 0.045,
  maxGain: 20,
};

export interface DisplayGain {
  /** The gain applied by the last `apply()` call (1 before the first call). */
  readonly gain: number;
  /** The rolling peak currently tracked (pre-floor, raw sample units). */
  readonly peak: number;
  /**
   * Measure `samplesInOut`, fold the result into the rolling peak, scale the
   * buffer in place so its loudest sample reaches full scale and clamp every
   * sample to ±1. Returns the applied gain. Identity when the samples are
   * silent and the floor already dominates.
   */
  apply(samplesInOut: Float32Array): number;
  /** Forget the rolling peak (e.g. when starting a new track). */
  reset(): void;
}

export function createDisplayGain(options: Partial<DisplayGainOptions> = {}): DisplayGain {
  const { attack, decay, floor, maxGain } = { ...DEFAULT_DISPLAY_GAIN_OPTIONS, ...options };
  let peak = floor;
  let gain = 1;

  function updatePeak(measured: number): void {
    const coefficient = measured > peak ? attack : decay;
    peak += (measured - peak) * coefficient;
    if (peak < 0) peak = 0; // defensive: options could be nonsense
  }

  return {
    get gain(): number {
      return gain;
    },
    get peak(): number {
      return peak;
    },
    apply(samplesInOut: Float32Array): number {
      // Measure the raw frame first; the rolling peak must not depend on the
      // gain we are about to apply. Non-finite values are neutralised so one
      // bad frame can never poison the shader with NaN.
      let measured = 0;
      for (let i = 0; i < samplesInOut.length; i++) {
        const value = samplesInOut[i];
        if (!Number.isFinite(value)) {
          samplesInOut[i] = 0;
          continue;
        }
        const magnitude = value < 0 ? -value : value;
        if (magnitude > measured) measured = magnitude;
      }

      updatePeak(measured);

      const effectivePeak = peak < floor ? floor : peak;
      const unclamped = 1 / effectivePeak;
      gain = unclamped > maxGain ? maxGain : unclamped;

      for (let i = 0; i < samplesInOut.length; i++) {
        const scaled = samplesInOut[i] * gain;
        samplesInOut[i] = scaled > 1 ? 1 : scaled < -1 ? -1 : scaled;
      }
      return gain;
    },
    reset(): void {
      peak = floor;
      gain = 1;
    },
  };
}
