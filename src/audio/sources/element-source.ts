/**
 * Entry point #1: an `<audio>` element.
 *
 * The browser owns the HTTP request, the demux and the decoding; all we do is
 * re-route the element's output through the audio graph with
 * `MediaElementAudioSourceNode`. This is the least code and the least control:
 * playback is not sample-accurate and buffering latency is the browser's.
 *
 * Note the node is created *once per element*: Chromium throws
 * ("already connected previously") if `createMediaElementSource` is called
 * twice for the same element, so it is cached and merely disconnected on stop.
 */

import type { AudioSource, SourceStats } from '../../types.ts';

const TRACK_URL = '/audio/track.wav';
const ZERO_STATS: SourceStats = { bytes: 0, chunks: 0 };

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createElementSource(onError: (message: string) => void = () => {}): AudioSource {
  const element = document.createElement('audio');
  element.src = TRACK_URL;
  element.loop = true;
  element.preload = 'auto';

  let node: MediaElementAudioSourceNode | null = null;
  let connected = false;
  /** True while a stop() is interrupting a pending play(); not a failure. */
  let stopping = false;
  let reportedLoadError = false;

  element.addEventListener('error', () => {
    if (reportedLoadError) return;
    reportedLoadError = true;
    onError(`could not load ${TRACK_URL} in the <audio> element (is the dev server running?)`);
  });

  return {
    id: 'element',
    stats: ZERO_STATS,

    async start(context, destination) {
      // Created once per element and reused across starts (see file comment).
      if (node === null) node = context.createMediaElementSource(element);
      stopping = false;
      element.loop = true;
      node.connect(destination);
      connected = true;
      try {
        await element.play();
      } catch (error) {
        if (stopping) return; // pause() interrupted the pending play(): expected
        const message = `element playback was blocked (${describeError(error)}) — press Start again after interacting with the page`;
        onError(message);
        throw new Error(message);
      }
    },

    stop() {
      stopping = true;
      element.pause();
      if (node === null || !connected) return;
      try {
        node.disconnect();
      } catch {
        // already disconnected
      }
      connected = false;
    },
  };
}
