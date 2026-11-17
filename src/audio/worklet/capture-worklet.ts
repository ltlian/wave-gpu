/**
 * The audio-thread half of the worklet tap.
 *
 * The main thread inserts the node as a silent branch of the graph:
 *
 *     masterGain ──▶ capture (this processor) ──▶ gain(0) ──▶ destination
 *
 * The gain of zero keeps the processor *pulled* by the destination without
 * contributing any audible signal, so `process()` is called for every 128-frame
 * render quantum and we see exactly what is playing.
 *
 * Two ways of getting samples to the main thread:
 *
 *  1. SharedArrayBuffer ring (needs crossOriginIsolated, i.e. COOP+COEP).
 *     Byte layout, shared with taps/worklet-tap.ts:
 *
 *       bytes 0..7    Int32Array control, length 2
 *                     control[0] = monotonic uint32 write counter, published
 *                                  with Atomics.store AFTER the samples it
 *                                  counts have been written
 *                     control[1] = reserved
 *       bytes 8..     Float32Array `capacity` mono samples, index
 *                     `counter & (capacity - 1)` (capacity is a power of two)
 *
 *     The counter is stored as a signed int32 but read back with `>>> 0`, so it
 *     stays wrap-safe (~24.8 h at 48 kHz).
 *
 *  2. postMessage fallback (no SAB): every 8 render quanta (~21 ms, ~47 Hz at
 *     48 kHz) transfer a Float32Array of mono samples to the main thread.
 *
 * In both modes a {type:'stats'} message arrives about once a second, which is
 * what drives the "worklet blocks / rms / peak" readout.
 *
 * This file must stay self-contained: Vite's `?worker&url` pipeline bundles it
 * as a standalone audio-worklet module, so it cannot import anything. The
 * AudioWorklet globals (`AudioWorkletProcessor`, `registerProcessor`,
 * `sampleRate`) are declared below: the DOM lib shipped with TypeScript 7 does
 * not expose the AudioWorkletGlobalScope members. Keeping this file a module
 * (the empty export) stops those declarations leaking into the application.
 */

export {};

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}

declare const sampleRate: number;

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

const DEFAULT_CAPACITY = 32_768; // power of two; mirrors shared/audio.ts TAP_CAPACITY
const MIN_CAPACITY = 1_024;
const FRAMES_PER_MESSAGE = 8 * 128; // 8 render quanta ≈ 21.3 ms

interface CaptureOptions {
  sab: SharedArrayBuffer | null;
  capacity: number;
}

interface FramesMessage {
  type: 'frames';
  samples: Float32Array<ArrayBuffer>;
}

interface StatsMessage {
  type: 'stats';
  blocks: number;
  rms: number;
  peak: number;
}

function readOptions(raw: unknown): CaptureOptions {
  const options: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const requested =
    typeof options.capacity === 'number' && Number.isFinite(options.capacity)
      ? options.capacity
      : DEFAULT_CAPACITY;
  const exponent = Math.round(Math.log2(Math.max(MIN_CAPACITY, requested)));
  const capacity = 2 ** exponent;
  const candidate = options.sab;
  // Reject a SAB that is too small for the requested ring rather than reading
  // past its end; the tap then falls back to postMessage.
  const sab =
    typeof SharedArrayBuffer === 'function' &&
    candidate instanceof SharedArrayBuffer &&
    candidate.byteLength >= 8 + capacity * Float32Array.BYTES_PER_ELEMENT
      ? candidate
      : null;
  return { sab, capacity };
}

class CaptureProcessor extends AudioWorkletProcessor {
  readonly capacity: number;
  readonly mask: number;
  readonly control: Int32Array | null;
  readonly ring: Float32Array | null;

  /** Monotonic uint32 sample counter (wraps after ~24.8 h at 48 kHz). */
  counter = 0;
  blocks = 0;

  readonly mono = new Float32Array(128);
  msg: Float32Array<ArrayBuffer> = new Float32Array(FRAMES_PER_MESSAGE);
  msgFill = 0;

  statsSamples = 0;
  statsSumSq = 0;
  statsPeak = 0;
  readonly statsEvery = Math.max(1, Math.round(sampleRate));

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    const { sab, capacity } = readOptions(options?.processorOptions);
    this.capacity = capacity;
    this.mask = capacity - 1;
    if (sab !== null) {
      this.control = new Int32Array(sab, 0, 2);
      this.ring = new Float32Array(sab, 8, capacity);
    } else {
      this.control = null;
      this.ring = null;
    }
  }

  /** Mono-downmix one render quantum into `this.mono`; returns frame count. */
  mixdown(input: readonly Float32Array[] | undefined): number {
    const left = input?.[0];
    const mono = this.mono;
    const frames = Math.min(left?.length ?? mono.length, mono.length);
    if (left === undefined) {
      mono.fill(0, 0, frames);
      return frames;
    }
    const right = input?.[1];
    if (right === undefined) {
      mono.set(left.subarray(0, frames));
      return frames;
    }
    for (let i = 0; i < frames; i += 1) {
      mono[i] = (left[i] + right[i]) * 0.5;
    }
    return frames;
  }

  writeRing(frames: number): void {
    const ring = this.ring;
    const control = this.control;
    if (ring === null || control === null) return;
    const mono = this.mono;
    const mask = this.mask;
    let counter = this.counter;
    for (let i = 0; i < frames; i += 1) {
      // Samples first: the counter is only published once the values it counts
      // are in the ring, so the reader never sees unwritten samples.
      ring[counter & mask] = mono[i];
      counter = (counter + 1) >>> 0;
    }
    this.counter = counter;
    Atomics.store(control, 0, counter);
  }

  flushFrames(): void {
    const samples = this.msg;
    const message: FramesMessage = { type: 'frames', samples };
    // Transfer ownership so the audio thread never blocks copying; a fresh
    // buffer is allocated for the next batch.
    this.port.postMessage(message, [samples.buffer]);
    this.msg = new Float32Array(FRAMES_PER_MESSAGE);
    this.msgFill = 0;
  }

  postFrames(frames: number): void {
    const mono = this.mono;
    let offset = 0;
    while (offset < frames) {
      const take = Math.min(FRAMES_PER_MESSAGE - this.msgFill, frames - offset);
      this.msg.set(mono.subarray(offset, offset + take), this.msgFill);
      this.msgFill += take;
      offset += take;
      if (this.msgFill >= FRAMES_PER_MESSAGE) this.flushFrames();
    }
  }

  accumulateStats(frames: number): void {
    const mono = this.mono;
    for (let i = 0; i < frames; i += 1) {
      const value = mono[i];
      this.statsSumSq += value * value;
      const magnitude = value < 0 ? -value : value;
      if (magnitude > this.statsPeak) this.statsPeak = magnitude;
    }
    this.statsSamples += frames;
  }

  postStatsIfDue(): void {
    if (this.statsSamples < this.statsEvery) return;
    const message: StatsMessage = {
      type: 'stats',
      blocks: this.blocks,
      rms: Math.sqrt(this.statsSumSq / this.statsSamples),
      peak: this.statsPeak,
    };
    this.port.postMessage(message);
    this.statsSamples = 0;
    this.statsSumSq = 0;
    this.statsPeak = 0;
  }

  process(inputs: Float32Array[][]): boolean {
    const frames = this.mixdown(inputs[0]);
    if (this.ring !== null) this.writeRing(frames);
    else this.postFrames(frames);

    this.accumulateStats(frames);
    this.blocks += 1;
    this.postStatsIfDue();
    return true; // keep processing even while the input is momentarily silent
  }
}

registerProcessor('wave-capture', CaptureProcessor);
