/**
 * Entry point #4: a local file the user drops or picks.
 *
 * The file never goes through our code as audio. We hand the browser a
 * same-origin `blob:` URL and let the existing `<audio>` pipeline demux and
 * decode it, then tap the element with `MediaElementAudioSourceNode`:
 *
 *   File → URL.createObjectURL → <audio src="blob:…"> → MediaElementAudioSourceNode
 *
 * That is deliberately format-agnostic: MP3, AAC/M4A, Ogg/Opus, FLAC, WAV…
 * are all whatever the browser's media stack supports — no parser or decoder
 * here, and no full-file decode in JS memory. It also streams straight from
 * disk, so long files are fine.
 *
 * The element is reused across files (a `MediaElementAudioSourceNode` can only
 * be created once per element), and the previous object URL is revoked on load.
 */

import type { AudioSource, FileInfo, SourceStats } from '../../types.ts';

const ZERO_STATS: SourceStats = { bytes: 0, chunks: 0 };

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface FileSource extends AudioSource {
  /** Point the element at `file` and wait until metadata (duration) is known. */
  load(file: File): Promise<FileInfo>;
  readonly file: FileInfo | null;
}

export function createFileSource(onError: (message: string) => void = () => {}): FileSource {
  const element = document.createElement('audio');
  element.loop = true;
  element.preload = 'metadata';

  let node: MediaElementAudioSourceNode | null = null;
  let connected = false;
  /** True while a stop() is interrupting a pending play(); not a failure. */
  let stopping = false;
  let objectUrl: string | null = null;
  let info: FileInfo | null = null;

  function revokeUrl(): void {
    if (objectUrl !== null) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  return {
    id: 'file',
    stats: ZERO_STATS,

    get file() {
      return info;
    },

    async load(file: File): Promise<FileInfo> {
      revokeUrl();
      objectUrl = URL.createObjectURL(file);
      element.src = objectUrl;
      const loading: FileInfo = { name: file.name, size: file.size, durationSeconds: 0 };
      info = loading;

      // `loadedmetadata` gives us the duration; an `error` event means the
      // browser could not demux/decode this container.
      try {
        await new Promise<void>((resolve, reject) => {
          const cleanup = (): void => {
            element.removeEventListener('loadedmetadata', onMetadata);
            element.removeEventListener('error', onError_);
          };
          const onMetadata = (): void => {
            cleanup();
            resolve();
          };
          const onError_ = (): void => {
            cleanup();
            reject(new Error('the browser could not decode this file (unsupported format?)'));
          };
          element.addEventListener('loadedmetadata', onMetadata, { once: true });
          element.addEventListener('error', onError_, { once: true });
          // Setting src already started loading; `load()` makes it deterministic
          // when switching from a previous file.
          element.load();
        });
      } catch (error) {
        // Leave the source clean: no stale metadata for the next start().
        info = null;
        revokeUrl();
        element.removeAttribute('src');
        element.load();
        throw error;
      }

      const loaded: FileInfo = {
        ...loading,
        durationSeconds: Number.isFinite(element.duration) ? element.duration : 0,
      };
      info = loaded;
      return loaded;
    },

    async start(context, destination) {
      if (info === null) throw new Error('no audio file loaded yet — drop or pick one first');
      // Created once per element; Chromium throws if this is called twice.
      if (node === null) node = context.createMediaElementSource(element);
      stopping = false;
      node.connect(destination);
      connected = true;
      try {
        await element.play();
      } catch (error) {
        if (stopping) return; // pause() interrupted the pending play(): expected
        const message = `file playback was blocked (${describeError(error)}) — press Start again after interacting with the page`;
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

    dispose() {
      stopping = true;
      element.pause();
      element.removeAttribute('src');
      element.load();
      revokeUrl();
      info = null;
    },
  };
}
