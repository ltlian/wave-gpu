/**
 * Minimal 16-bit PCM RIFF/WAVE encoder.
 *
 * Layout: the canonical 44-byte header (RIFF + fmt + data, PCM format tag 1)
 * followed by `frames × channels` little-endian signed 16-bit samples. The byte
 * length is therefore always `44 + frames * channels * 2`, which is what the
 * WAV endpoint advertises as `Content-Length` and what byte-range requests over.
 * Nothing here allocates beyond the one output Buffer.
 */

import { WAV_HEADER_BYTES } from '../shared/audio.ts';

const BYTES_PER_SAMPLE = 2; // 16-bit
const PCM_FORMAT = 1;

/**
 * Encode planar float channels as a complete 16-bit PCM WAV file.
 *
 * @param channelsData one `Float32Array` per channel, all the same length
 * @param sampleRate samples per second per channel
 * @returns the complete `.wav` file contents
 */
export function encodeWav16(channelsData: Float32Array[], sampleRate: number): Buffer {
  const channels = channelsData.length;
  if (channels === 0) throw new Error('encodeWav16: at least one channel is required');
  const frames = channelsData[0].length;
  for (let channel = 1; channel < channels; channel += 1) {
    if (channelsData[channel].length !== frames) {
      throw new Error('encodeWav16: all channels must have the same number of frames');
    }
  }

  const blockAlign = channels * BYTES_PER_SAMPLE;
  const dataBytes = frames * blockAlign;
  const file = Buffer.alloc(WAV_HEADER_BYTES + dataBytes); // zero-filled: header padding stays 0

  file.write('RIFF', 0, 'ascii');
  file.writeUInt32LE(WAV_HEADER_BYTES - 8 + dataBytes, 4); // size of everything after this field
  file.write('WAVE', 8, 'ascii');
  file.write('fmt ', 12, 'ascii');
  file.writeUInt32LE(16, 16); // fmt chunk size for PCM
  file.writeUInt16LE(PCM_FORMAT, 20);
  file.writeUInt16LE(channels, 22);
  file.writeUInt32LE(sampleRate, 24);
  file.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  file.writeUInt16LE(blockAlign, 32);
  file.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34); // bits per sample
  file.write('data', 36, 'ascii');
  file.writeUInt32LE(dataBytes, 40);

  let offset = WAV_HEADER_BYTES;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = channelsData[channel][frame];
      const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
      // Asymmetric scaling is the usual full-scale convention: -1 maps to
      // -32768 but +1 maps to +32767, so int16 never wraps around.
      file.writeInt16LE(Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff)), offset);
      offset += BYTES_PER_SAMPLE;
    }
  }
  return file;
}
