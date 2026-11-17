/**
 * The audio assets shared by the plugin's endpoints.
 *
 * Rendering the loop is cheap enough to do at startup but expensive enough that
 * re-doing it per request would be rude. Everything is generated once per
 * process and cached; the buffers are treated as read-only.
 */

import { renderTrack } from './synth.ts';

/** JSON body served by `GET /api/meta`. */
export interface AudioMeta {
  title: string;
  bpm: number;
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  loop: boolean;
}

/** Everything the HTTP endpoints need, rendered on first access. */
export interface AudioAssets {
  meta: AudioMeta;
  /** Interleaved stereo f32le samples (`/stream/pcm` payload). */
  pcm: Buffer;
}

let cached: AudioAssets | null = null;

/** Interleave planar Float32 channels into contiguous little-endian f32 bytes. */
function interleaveF32LE(channelsData: Float32Array[]): Buffer {
  const channels = channelsData.length;
  const frames = channelsData[0].length;
  const buffer = Buffer.allocUnsafe(frames * channels * 4);
  let offset = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      buffer.writeFloatLE(channelsData[channel][frame], offset);
      offset += 4;
    }
  }
  return buffer;
}

function buildAudioAssets(): AudioAssets {
  const track = renderTrack();
  return {
    meta: {
      title: '',
      bpm: track.bpm,
      sampleRate: track.sampleRate,
      channels: track.channels,
      durationSeconds: track.durationSeconds,
      loop: true,
    },
    pcm: interleaveF32LE(track.channelsData),
  };
}

/** Render/encode the loop once per process; later calls return the same buffers. */
export function getAudioAssets(): AudioAssets {
  cached ??= buildAudioAssets();
  return cached;
}
