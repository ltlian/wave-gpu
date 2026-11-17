/**
 * Read path A: an `AnalyserNode` polled once per animation frame.
 *
 * It is the cheap, universal tap: no worklet, no SharedArrayBuffer, no COOP/COEP
 * requirements. `getFloatTimeDomainData()` returns a sliding window of the most
 * recent `fftSize` frames — not a queue — so polling slower than the window just
 * skips samples (which is fine for drawing) and polling faster repeats them.
 */

import { FRAME_SAMPLES } from '../../../shared/audio.ts';
import type { SampleTap } from '../../types.ts';

export function createAnalyserTap(): SampleTap {
  let node: AnalyserNode | null = null;
  let rms = 0;
  let peak = 0;

  return {
    id: 'analyser',
    get rms() {
      return rms;
    },
    get peak() {
      return peak;
    },
    /** The analyser has no concept of render quanta. */
    get blocks() {
      return 0;
    },

    attach(master, _destination) {
      if (node !== null) return;
      const analyser = master.context.createAnalyser();
      analyser.fftSize = FRAME_SAMPLES;
      analyser.smoothingTimeConstant = 0.8;
      master.connect(analyser);
      node = analyser;
    },

    read(out) {
      if (node === null) return false;
      // The camera-frame buffer the engine passes in is an ordinary
      // heap-backed Float32Array; the DOM signature cannot express "not
      // backed by a SharedArrayBuffer", so narrow it explicitly.
      node.getFloatTimeDomainData(out as Float32Array<ArrayBuffer>);
      let sumSquares = 0;
      let max = 0;
      for (let i = 0; i < out.length; i += 1) {
        const value = out[i];
        sumSquares += value * value;
        const magnitude = value < 0 ? -value : value;
        if (magnitude > max) max = magnitude;
      }
      rms = out.length > 0 ? Math.sqrt(sumSquares / out.length) : 0;
      peak = max;
      return true;
    },

    dispose() {
      if (node === null) return;
      try {
        node.disconnect();
      } catch {
        // already disconnected
      }
      node = null;
    },
  };
}
