/**
 * Tests for the byte-level PCM helpers. These matter because a streaming
 * response gives no guarantee about where chunk boundaries fall: a chunk can
 * split a float in half or split the left/right halves of one stereo frame.
 */

/// <reference types="node" />

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BYTES_PER_SAMPLE,
  STREAM_CHANNELS,
  STREAM_FRAME_BYTES,
  appendBytes,
  takeFrames,
} from './pcm.ts';

/** Encode samples the way the server does: interleaved little-endian f32. */
function encodeF32Le(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * BYTES_PER_SAMPLE);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i += 1) view.setFloat32(i * BYTES_PER_SAMPLE, values[i], true);
  return bytes;
}

function decode(values: readonly number[]): Float32Array {
  return new Float32Array(values);
}

const PAYLOAD = encodeF32Le([0.5, -0.25, 1, -1, 0.125, 0.75]); // 3 stereo frames

test('stream format constants describe a stereo f32le frame', () => {
  assert.equal(BYTES_PER_SAMPLE, 4);
  assert.equal(STREAM_CHANNELS, 2);
  assert.equal(STREAM_FRAME_BYTES, 8);
});

test('appendBytes decodes aligned whole frames and leaves no remainder', () => {
  const { samples, leftover } = appendBytes(new Uint8Array(0), PAYLOAD);
  assert.deepEqual(samples, decode([0.5, -0.25, 1, -1, 0.125, 0.75]));
  assert.equal(leftover.byteLength, 0);
});

test('appendBytes carries a partial frame into the next chunk', () => {
  const first = appendBytes(new Uint8Array(0), PAYLOAD.subarray(0, 5));
  assert.equal(first.samples.length, 0);
  assert.equal(first.leftover.byteLength, 5);

  const second = appendBytes(first.leftover, PAYLOAD.subarray(5, 11));
  assert.deepEqual(second.samples, decode([0.5, -0.25]));
  assert.equal(second.leftover.byteLength, 3);

  const third = appendBytes(second.leftover, PAYLOAD.subarray(11));
  assert.deepEqual(third.samples, decode([1, -1, 0.125, 0.75]));
  assert.equal(third.leftover.byteLength, 0);
});

test('every possible two-chunk split is reassembled exactly', () => {
  for (let split = 0; split <= PAYLOAD.byteLength; split += 1) {
    const head = appendBytes(new Uint8Array(0), PAYLOAD.subarray(0, split));
    assert.ok(head.leftover.byteLength < STREAM_FRAME_BYTES, `split ${split}: leftover < frame`);

    const tail = appendBytes(head.leftover, PAYLOAD.subarray(split));
    assert.ok(tail.leftover.byteLength < STREAM_FRAME_BYTES, `split ${split}: tail leftover`);

    const combined = new Float32Array(head.samples.length + tail.samples.length);
    combined.set(head.samples, 0);
    combined.set(tail.samples, head.samples.length);
    assert.deepEqual(combined, decode([0.5, -0.25, 1, -1, 0.125, 0.75]), `split ${split}`);
    assert.equal(
      tail.leftover.byteLength,
      (head.leftover.byteLength + PAYLOAD.byteLength - split) % STREAM_FRAME_BYTES,
      `split ${split}: only whole frames are consumed`,
    );
  }
});

test('feeding one byte at a time yields the same samples', () => {
  let leftover: Uint8Array = new Uint8Array(0);
  const collected: number[] = [];
  for (const byte of PAYLOAD) {
    const result = appendBytes(leftover, new Uint8Array([byte]));
    leftover = result.leftover;
    for (const sample of result.samples) collected.push(sample);
    assert.ok(leftover.byteLength < STREAM_FRAME_BYTES);
  }
  assert.deepEqual(decode(collected), decode([0.5, -0.25, 1, -1, 0.125, 0.75]));
  assert.equal(leftover.byteLength, 0);
});

test('a chunk boundary between L and R keeps the stereo frame intact', () => {
  // 1.0 encodes as 00 00 80 3f; split the middle of the frame (after L).
  const frame = encodeF32Le([1, -2.5]);
  const leftHalf = appendBytes(new Uint8Array(0), frame.subarray(0, 4));
  assert.equal(leftHalf.samples.length, 0);
  assert.equal(leftHalf.leftover.byteLength, 4);

  const wholeFrame = appendBytes(leftHalf.leftover, frame.subarray(4));
  assert.deepEqual(wholeFrame.samples, decode([1, -2.5]));
  assert.equal(wholeFrame.leftover.byteLength, 0);
});

test('values are decoded as little-endian f32, not host/machine order', () => {
  // 1.0 as IEEE-754 binary32 is 0x3F800000, so its bytes in f32le are 00 00 80 3f.
  const one = appendBytes(new Uint8Array(0), new Uint8Array([0x00, 0x00, 0x80, 0x3f]), BYTES_PER_SAMPLE);
  assert.deepEqual(one.samples, decode([1]));
  // -2.5 is 0xC0200000 → bytes 00 00 20 c0.
  const minusTwoAndAHalf = appendBytes(
    new Uint8Array(0),
    new Uint8Array([0x00, 0x00, 0x20, 0xc0]),
    BYTES_PER_SAMPLE,
  );
  assert.deepEqual(minusTwoAndAHalf.samples, decode([-2.5]));
  // 0.1 is not exactly representable; compare to the f32 value, not the f64 one.
  const tenth = appendBytes(new Uint8Array(0), encodeF32Le([0.1]), BYTES_PER_SAMPLE).samples;
  assert.equal(tenth[0], Math.fround(0.1));
  // Stereo f32le in wire order: [1, -2.5] → 00 00 80 3f 00 00 20 c0.
  const stereo = appendBytes(
    new Uint8Array(0),
    new Uint8Array([0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x20, 0xc0]),
  );
  assert.deepEqual(stereo.samples, decode([1, -2.5]));
});

test('appendBytes with no new bytes keeps the leftover untouched', () => {
  const leftover = new Uint8Array([1, 2, 3]);
  const result = appendBytes(leftover, new Uint8Array(0));
  assert.equal(result.samples.length, 0);
  assert.equal(result.leftover, leftover);
});

test('appendBytes rejects invalid frame sizes and oversized leftovers', () => {
  assert.throws(() => appendBytes(new Uint8Array(0), new Uint8Array(0), 0), RangeError);
  assert.throws(() => appendBytes(new Uint8Array(0), new Uint8Array(0), 3), RangeError);
  assert.throws(() => appendBytes(new Uint8Array(8), new Uint8Array(8)), RangeError);
});

test('appendBytes supports a mono frame size', () => {
  const payload = encodeF32Le([0.25, 0.5, -0.75]);
  const { samples, leftover } = appendBytes(new Uint8Array(0), payload, BYTES_PER_SAMPLE);
  assert.deepEqual(samples, decode([0.25, 0.5, -0.75]));
  assert.equal(leftover.byteLength, 0);
});

test('takeFrames consumes whole frames across chunk boundaries', () => {
  const chunks = [decode([1, 2, 3, 4, 5, 6]), decode([7, 8, 9, 10])]; // 3 + 2 frames
  const taken = takeFrames(chunks, 4);
  assert.equal(taken.framesTaken, 4);
  assert.deepEqual(taken.samples, decode([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.equal(taken.chunks.length, 1);
  assert.deepEqual(taken.chunks[0], decode([9, 10]));

  // The input queue must not be mutated: takeFrames is a pure step.
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0], decode([1, 2, 3, 4, 5, 6]));
});

test('takeFrames returns less than requested when the queue runs dry', () => {
  const chunks = [decode([1, 2, 3, 4])]; // 2 frames
  const taken = takeFrames(chunks, 10);
  assert.equal(taken.framesTaken, 2);
  assert.deepEqual(taken.samples, decode([1, 2, 3, 4]));
  assert.deepEqual(taken.chunks, []);
});

test('takeFrames from an empty queue yields nothing', () => {
  const taken = takeFrames([], 8);
  assert.equal(taken.framesTaken, 0);
  assert.equal(taken.samples.length, 0);
  assert.deepEqual(taken.chunks, []);
});

test('takeFrames rejects invalid arguments', () => {
  assert.throws(() => takeFrames([], -1), RangeError);
  assert.throws(() => takeFrames([], 1.5), RangeError);
  assert.throws(() => takeFrames([], 1, 0), RangeError);
  assert.throws(() => takeFrames([decode([1, 2, 3])], 1), RangeError); // half a stereo frame
});

test('split frames survive a round trip through appendBytes and takeFrames', () => {
  // Two channels split awkwardly over three network chunks, then scheduled in
  // 2-frame slices — the shape stream-source.ts actually uses.
  const chunks = [PAYLOAD.subarray(0, 3), PAYLOAD.subarray(3, 9), PAYLOAD.subarray(9)];
  let leftover: Uint8Array = new Uint8Array(0);
  const queue: Float32Array[] = [];
  for (const chunk of chunks) {
    const step = appendBytes(leftover, chunk);
    leftover = step.leftover;
    if (step.samples.length > 0) queue.push(step.samples);
  }
  assert.equal(leftover.byteLength, 0);
  assert.equal(queue.reduce((sum, chunk) => sum + chunk.length / STREAM_CHANNELS, 0), 3);

  const first = takeFrames(queue, 2);
  assert.deepEqual(first.samples, decode([0.5, -0.25, 1, -1]));
  const second = takeFrames(first.chunks, 2);
  assert.deepEqual(second.samples, decode([0.125, 0.75]));
  assert.deepEqual(second.chunks, []);
});
