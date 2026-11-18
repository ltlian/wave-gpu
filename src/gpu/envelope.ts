/**
 * Per-column amplitude summary shared by the Canvas2D and SVG backends.
 *
 * Both backends bucket the 2048-sample frame into `columns` groups, smooth the
 * column edges, and normalise the result so the loudest column reaches a fixed
 * drawn half-height. Keeping that logic here means the two renderers cannot
 * drift apart — only their drawing differs.
 */

import { FRAME_SAMPLES } from '../../shared/audio.ts';

/** Drawn half-height for the loudest column (matches visualizer.ts). */
const TARGET_HALF = 0.42;
/** Below this, a frame is treated as silent and drawn flat. */
const MIN_PEAK = 1e-5;

export interface ColumnEnvelope {
  readonly columns: number;
  /** Smoothed half-amplitudes, one per column. */
  readonly amplitudes: Float32Array;
  /** Maps the loudest column to `TARGET_HALF`; 0 when the frame is silent. */
  ampScale: number;
  compute(samples: Float32Array): void;
}

export function createColumnEnvelope(columns: number): ColumnEnvelope {
  const samplesPerColumn = FRAME_SAMPLES / columns;
  const amplitudes = new Float32Array(columns);
  const smoothed = new Float32Array(columns);

  const envelope: ColumnEnvelope = {
    columns,
    amplitudes,
    ampScale: 0,
    compute(samples: Float32Array): void {
      for (let column = 0; column < columns; column++) {
        const base = column * samplesPerColumn;
        let minimum = 1;
        let maximum = -1;
        let sum = 0;
        for (let i = 0; i < samplesPerColumn; i++) {
          const value = samples[base + i];
          if (value < minimum) minimum = value;
          if (value > maximum) maximum = value;
          sum += value;
        }
        const centre = sum / samplesPerColumn;
        const left = Math.abs(maximum - centre);
        const right = Math.abs(centre - minimum);
        amplitudes[column] = left > right ? left : right;
      }

      // One neighbour pass keeps column edges from looking like a picket fence.
      for (let column = 0; column < columns; column++) {
        const left = amplitudes[column > 0 ? column - 1 : column];
        const right = amplitudes[column < columns - 1 ? column + 1 : column];
        smoothed[column] = (left + amplitudes[column] * 2 + right) * 0.25;
      }
      amplitudes.set(smoothed);

      let peak = 0;
      for (let column = 0; column < columns; column++) {
        if (smoothed[column] > peak) peak = smoothed[column];
      }
      envelope.ampScale = peak > MIN_PEAK ? TARGET_HALF / peak : 0;
    },
  };

  return envelope;
}
