/**
 * Entry point #2: fetch the whole track, decode it, loop the `AudioBuffer`.
 *
 * `decodeAudioData()` gives us all the PCM in memory and resamples it to the
 * context's sample rate; playing it is then sample-accurate and gapless, at the
 * cost of downloading the whole file first. The decoded buffer is cached, so
 * switching away and back does not download or decode again.
 */

import type { AudioSource, SourceStats } from '../../types.ts';

const TRACK_URL = '/audio/track.wav';
const ZERO_STATS: SourceStats = { bytes: 0, chunks: 0 };

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createDecodedBufferSource(
  onError: (message: string) => void = () => {},
): AudioSource {
  let decoded: AudioBuffer | null = null;
  let loading: Promise<AudioBuffer> | null = null;
  let node: AudioBufferSourceNode | null = null;
  /** Bumped by stop() so a start() still awaiting the fetch can bail out. */
  let generation = 0;

  async function load(context: AudioContext): Promise<AudioBuffer> {
    if (decoded !== null) return decoded;
    loading ??= (async () => {
      const response = await fetch(TRACK_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error(`${TRACK_URL} responded HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      // decodeAudioData() detaches `bytes`, so always pass a fresh ArrayBuffer.
      return context.decodeAudioData(bytes);
    })();
    try {
      const buffer = await loading;
      decoded = buffer;
      return buffer;
    } finally {
      loading = null;
    }
  }

  return {
    id: 'decode',
    stats: ZERO_STATS,

    async start(context, destination) {
      const current = ++generation;
      let buffer: AudioBuffer;
      try {
        buffer = await load(context);
      } catch (error) {
        if (current !== generation) return; // stopped while loading
        const message = `could not decode ${TRACK_URL}: ${describeError(error)}`;
        onError(message);
        throw new Error(message);
      }
      if (current !== generation) return; // stopped while loading: don't play

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(destination);
      source.start();
      node = source;
    },

    stop() {
      generation += 1;
      if (node === null) return;
      const source = node;
      node = null;
      try {
        source.stop();
      } catch {
        // already stopped
      }
      try {
        source.disconnect();
      } catch {
        // already disconnected
      }
    },
  };
}
