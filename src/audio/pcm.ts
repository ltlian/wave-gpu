/**
 * Pure, browser-free helpers for the stream endpoint's wire format:
 * interleaved stereo little-endian 32-bit floats (`f32le`).
 *
 * fetch() hands us byte chunks of arbitrary size — a chunk may start or end in
 * the middle of a float, or even between the left and right halves of a stereo
 * frame. Everything here therefore works in bytes and only ever emits *whole
 * frames*, carrying the remainder (< 8 bytes) into the next call.
 *
 * No DOM APIs and no imports, so this file runs under `node --test` unchanged.
 */

export const BYTES_PER_SAMPLE = Float32Array.BYTES_PER_ELEMENT; // 4
/** Channels in the stream format (interleaved). */
export const STREAM_CHANNELS = 2;
/** Bytes in one stereo frame: L and R as f32le. */
export const STREAM_FRAME_BYTES = STREAM_CHANNELS * BYTES_PER_SAMPLE; // 8

/** Byte tail too short to complete a frame; always shorter than `frameBytes`. */
export interface AppendResult {
  /** Whole frames decoded from `leftover` + `incoming`, interleaved. */
  samples: Float32Array;
  /** The bytes that did not complete a frame (0..frameBytes-1 bytes). */
  leftover: Uint8Array;
}

export interface TakeFramesResult {
  /** Exactly `framesTaken * channels` interleaved samples. */
  samples: Float32Array;
  /** The chunks that were not consumed (the input is never mutated). */
  chunks: Float32Array[];
  framesTaken: number;
}

function assertFrameBytes(frameBytes: number): void {
  if (!Number.isInteger(frameBytes) || frameBytes <= 0 || frameBytes % BYTES_PER_SAMPLE !== 0) {
    throw new RangeError(`frameBytes must be a positive multiple of ${BYTES_PER_SAMPLE}`);
  }
}

function emptySamples(): Float32Array {
  return new Float32Array(0);
}

/**
 * Decode `byteLength` bytes of little-endian f32 samples starting at
 * `byteOffset` inside `bytes`. A DataView is used (rather than a Float32Array
 * view) so the result is correct on big-endian hosts and for any byte offset —
 * network chunks are not guaranteed to be 4-byte aligned in their buffer.
 */
function decodeFloat32Le(bytes: Uint8Array, byteOffset: number, byteLength: number): Float32Array {
  const samples = new Float32Array(byteLength / BYTES_PER_SAMPLE);
  if (samples.length === 0) return samples;
  const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset, byteLength);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getFloat32(i * BYTES_PER_SAMPLE, true);
  }
  return samples;
}

/**
 * Append newly received bytes to a partial frame and decode everything that now
 * forms whole frames. The returned `leftover` is always shorter than one frame,
 * so the caller can feed it straight back in on the next network chunk.
 */
export function appendBytes(
  leftover: Uint8Array,
  incoming: Uint8Array,
  frameBytes: number = STREAM_FRAME_BYTES,
): AppendResult {
  assertFrameBytes(frameBytes);
  if (leftover.byteLength >= frameBytes) {
    throw new RangeError('leftover must be smaller than one frame');
  }
  if (incoming.byteLength === 0) {
    return { samples: emptySamples(), leftover };
  }

  const leftoverBytes = leftover.byteLength;
  const total = leftoverBytes + incoming.byteLength;
  const wholeBytes = total - (total % frameBytes);
  if (wholeBytes === 0) {
    const merged = new Uint8Array(total);
    merged.set(leftover, 0);
    merged.set(incoming, leftoverBytes);
    return { samples: emptySamples(), leftover: merged };
  }

  // Fast path: no partial frame at the boundary, so decode the chunk in place.
  if (leftoverBytes === 0) {
    return {
      samples: decodeFloat32Le(incoming, 0, wholeBytes),
      leftover: incoming.subarray(wholeBytes),
    };
  }

  // Straddling path: concatenate the partial frame with the chunk's head.
  const merged = new Uint8Array(wholeBytes);
  merged.set(leftover, 0);
  const consumed = wholeBytes - leftoverBytes; // bytes taken from `incoming`
  merged.set(incoming.subarray(0, consumed), leftoverBytes);
  return {
    samples: decodeFloat32Le(merged, 0, wholeBytes),
    leftover: wholeBytes === total ? emptyBytes() : incoming.slice(consumed),
  };
}

function emptyBytes(): Uint8Array {
  return new Uint8Array(0);
}

/**
 * Pop at most `frames` interleaved frames from a queue of whole-frame chunks.
 * Chunks are consumed head-first and a chunk may be split across calls; the
 * returned `chunks` array is a new array and the input chunks are not mutated,
 * so this is safe to use as a pure "state -> next state" step.
 */
export function takeFrames(
  chunks: readonly Float32Array[],
  frames: number,
  channels: number = STREAM_CHANNELS,
): TakeFramesResult {
  if (!Number.isInteger(frames) || frames < 0) {
    throw new RangeError('frames must be a non-negative integer');
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new RangeError('channels must be a positive integer');
  }

  const remaining = [...chunks];
  const wanted = frames * channels;
  const samples = new Float32Array(wanted);
  let written = 0;
  while (written < wanted && remaining.length > 0) {
    const head = remaining[0];
    if (head.length % channels !== 0) {
      throw new RangeError('chunk length must be a whole number of frames');
    }
    if (head.length === 0) {
      remaining.shift();
      continue;
    }
    const take = Math.min(head.length, wanted - written);
    samples.set(head.subarray(0, take), written);
    written += take;
    if (take === head.length) remaining.shift();
    else remaining[0] = head.subarray(take);
  }

  return {
    samples: written === wanted ? samples : samples.slice(0, written),
    chunks: remaining,
    framesTaken: written / channels,
  };
}
