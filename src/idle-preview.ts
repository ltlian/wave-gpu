/**
 * Idle preview: when no audio is flowing (before the first Start, or while a
 * source is switching) the visualizer still gets something to draw. This is
 * deliberately not "fake audio" — it never enters the audio graph.
 */

const TAU = Math.PI * 2;

export interface IdlePreview {
  write(out: Float32Array, timeMs: number): void;
}

export function createIdlePreview(sampleCount: number): IdlePreview {
  return {
    write(out, timeMs) {
      const seconds = timeMs / 1000;
      for (let i = 0; i < sampleCount; i++) {
        const x = i / sampleCount;
        const taper = Math.sin(Math.PI * x);
        const value =
          0.42 * Math.sin(TAU * (x * 2 + seconds * 0.12)) +
          0.18 * Math.sin(TAU * (x * 5.3 - seconds * 0.21)) +
          0.07 * Math.sin(TAU * (x * 13.7 + seconds * 0.37));
        out[i] = value * taper;
      }
    },
  };
}
