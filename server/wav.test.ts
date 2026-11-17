import assert from 'node:assert/strict';
import test from 'node:test';

import { WAV_HEADER_BYTES } from '../shared/audio.ts';
import { encodeWav16 } from './wav.ts';

const SAMPLE_RATE = 48_000;

/** Read every interleaved int16 sample that follows the header. */
function readSamples(wav: Buffer): number[] {
  const samples: number[] = [];
  for (let offset = WAV_HEADER_BYTES; offset + 1 < wav.length; offset += 2) {
    samples.push(wav.readInt16LE(offset));
  }
  return samples;
}

test('encodeWav16: writes the canonical 44-byte RIFF/WAVE header', () => {
  const frames = 3;
  const wav = encodeWav16(
    [Float32Array.from([0, 0.5, -0.5]), Float32Array.from([1, -1, 0])],
    SAMPLE_RATE,
  );

  assert.ok(Buffer.isBuffer(wav));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8); // RIFF size = file bytes after this field
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt32LE(16), 16); // fmt chunk size
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 2); // channels
  assert.equal(wav.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(wav.readUInt32LE(28), SAMPLE_RATE * 2 * 2); // byte rate
  assert.equal(wav.readUInt16LE(32), 4); // block align
  assert.equal(wav.readUInt16LE(34), 16); // bits per sample
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), frames * 2 * 2); // data chunk size
});

test('encodeWav16: byte length is exactly 44 + frames*channels*2', () => {
  for (const channels of [1, 2]) {
    for (const frames of [0, 1, 960, 576_000]) {
      const channelsData = Array.from({ length: channels }, () => new Float32Array(frames));
      const wav = encodeWav16(channelsData, SAMPLE_RATE);
      assert.equal(
        wav.length,
        WAV_HEADER_BYTES + frames * channels * 2,
        `channels=${channels} frames=${frames}`,
      );
      assert.equal(wav.readUInt32LE(40), frames * channels * 2);
    }
  }
});

test('encodeWav16: interleaves channels frame by frame', () => {
  const wav = encodeWav16(
    [Float32Array.from([0.25, 0.5]), Float32Array.from([-0.25, -0.5])],
    SAMPLE_RATE,
  );
  // Frame 0: L,R then frame 1: L,R.
  assert.deepEqual(readSamples(wav), [8192, -8192, 16384, -16384]);
});

test('encodeWav16: int16 little-endian values round-trip and clamp', () => {
  const wav = encodeWav16(
    [Float32Array.from([-1, -0.5, 0, 0.5, 1, -2, 2])],
    SAMPLE_RATE,
  );
  // Asymmetric full scale: -1 → -32768, +1 → 32767; anything beyond ±1 clamps.
  assert.deepEqual(readSamples(wav), [-32768, -16384, 0, 16384, 32767, -32768, 32767]);
});

test('encodeWav16: rejects an empty channel list or mismatched channel lengths', () => {
  assert.throws(() => encodeWav16([], SAMPLE_RATE), /at least one channel/);
  assert.throws(
    () => encodeWav16([Float32Array.from([0, 1]), Float32Array.from([0])], SAMPLE_RATE),
    /same number of frames/,
  );
});
