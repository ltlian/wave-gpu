/**
 * Read path B: an `AudioWorkletNode` capture tap.
 *
 * The worklet sees every 128-frame render quantum exactly, so unlike the
 * analyser this is a real, sample-accurate stream of what is playing. It is
 * inserted as a silent branch (`node → gain(0) → destination`) so the graph
 * keeps pulling it without adding any audible signal.
 *
 * Transport (see worklet/capture-worklet.ts for the ring layout):
 *  - SharedArrayBuffer ring when the page is cross-origin isolated (COOP+COEP)
 *    → the main thread reads whenever it likes, with no per-frame messages;
 *  - otherwise a postMessage fallback of transferable Float32Arrays (~47 Hz)
 *    accumulated into a small rolling buffer here.
 *
 * In both modes the worklet also posts {type:'stats'} about once a second;
 * those drive the `blocks`/`rms`/`peak` readout. Both read paths simply expose
 * the latest samples, so `read()` is true as soon as the tap is warm.
 */

import { TAP_CAPACITY } from '../../../shared/audio.ts';
import type { SampleTap } from '../../types.ts';
import workletUrl from '../worklet/capture-worklet.ts?worker&url';

const PROCESSOR_NAME = 'wave-capture';
const SAMPLE_BYTES = Float32Array.BYTES_PER_ELEMENT;
/** Bytes of Int32 control at the start of the SharedArrayBuffer. */
const CONTROL_BYTES = 8;
/** Size of the mono rolling buffer used by the postMessage fallback. */
const FALLBACK_CAPACITY = 4_096;
const FALLBACK_MASK = FALLBACK_CAPACITY - 1;

export interface WorkletTapOptions {
  /** Recoverable failures (worklet load, SAB creation) are reported here. */
  onError?: (message: string) => void;
  /** Ring size; rounded up to a power of two. Defaults to shared TAP_CAPACITY. */
  capacity?: number;
}

export interface WorkletTap extends SampleTap {
  /** True when the tap is running on a SharedArrayBuffer ring. */
  readonly ring: boolean;
}

interface Ring {
  sab: SharedArrayBuffer;
  control: Int32Array;
  samples: Float32Array;
  capacity: number;
}

interface Stats {
  blocks: number;
  rms: number;
  peak: number;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function powerOfTwoCapacity(requested: number | undefined): number {
  const value = requested !== undefined && Number.isFinite(requested) ? requested : TAP_CAPACITY;
  return 2 ** Math.round(Math.log2(Math.max(1_024, value)));
}

/** Create the shared ring, or return null when isolation/SAB is unavailable. */
function createRing(capacity: number, onError: (message: string) => void): Ring | null {
  if (globalThis.crossOriginIsolated !== true) return null;
  if (typeof SharedArrayBuffer !== 'function') return null;
  try {
    const sab = new SharedArrayBuffer(CONTROL_BYTES + capacity * SAMPLE_BYTES);
    return {
      sab,
      control: new Int32Array(sab, 0, 2),
      samples: new Float32Array(sab, CONTROL_BYTES, capacity),
      capacity,
    };
  } catch (error) {
    onError(`SharedArrayBuffer ring could not be created: ${describeError(error)}`);
    return null;
  }
}

export function createWorkletTap(options: WorkletTapOptions = {}): WorkletTap {
  const onError = options.onError ?? (() => {});
  const capacity = powerOfTwoCapacity(options.capacity);

  let ring: Ring | null = null;
  let node: AudioWorkletNode | null = null;
  let silentGain: GainNode | null = null;
  let started = false;
  let disposed = false;
  let ringMode = false;

  const stats: Stats = { blocks: 0, rms: 0, peak: 0 };

  // postMessage fallback: a mono rolling buffer the worklet's frames are
  // appended to, so the main thread can always read "the latest N samples".
  const fallback = new Float32Array(FALLBACK_CAPACITY);
  let fallbackWrite = 0;
  let fallbackTotal = 0;

  function pushFallback(samples: Float32Array): void {
    let write = fallbackWrite;
    for (let i = 0; i < samples.length; i += 1) {
      fallback[write & FALLBACK_MASK] = samples[i];
      write = (write + 1) >>> 0;
    }
    fallbackWrite = write;
    fallbackTotal += samples.length;
  }

  function readFallback(out: Float32Array): boolean {
    if (fallbackTotal < out.length) return false;
    const start = (fallbackWrite - out.length) >>> 0;
    for (let i = 0; i < out.length; i += 1) {
      out[i] = fallback[(start + i) & FALLBACK_MASK];
    }
    return true;
  }

  function readRing(target: Ring, out: Float32Array): boolean {
    // `>>> 0` keeps the uint32 counter arithmetic wrap-safe.
    const written = Atomics.load(target.control, 0) >>> 0;
    if (written < out.length) return false; // not warmed up yet
    const start = (written - out.length) >>> 0;
    const ringMask = target.capacity - 1;
    for (let i = 0; i < out.length; i += 1) {
      out[i] = target.samples[(start + i) & ringMask];
    }
    return true;
  }

  function onMessage(event: MessageEvent): void {
    const data: unknown = event.data;
    if (typeof data !== 'object' || data === null) return;
    const message = data as { type?: unknown; blocks?: unknown; rms?: unknown; peak?: unknown; samples?: unknown };
    if (message.type === 'stats') {
      stats.blocks = typeof message.blocks === 'number' ? message.blocks : stats.blocks;
      stats.rms = typeof message.rms === 'number' ? message.rms : 0;
      stats.peak = typeof message.peak === 'number' ? message.peak : 0;
      return;
    }
    if (message.type === 'frames' && message.samples instanceof Float32Array) {
      pushFallback(message.samples);
    }
  }

  async function load(context: AudioContext, master: AudioNode, destination: AudioNode): Promise<void> {
    try {
      ring = createRing(capacity, onError);
      // `?worker&url` is the Vite pipeline that works for both `vite dev` and a
      // production build; a plain `?url` would emit un-transpiled TypeScript.
      await context.audioWorklet.addModule(workletUrl);
      if (disposed) return;

      const workletNode = new AudioWorkletNode(context, PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { sab: ring?.sab ?? null, capacity },
      });
      workletNode.port.onmessage = onMessage;

      // A gain of zero keeps the worklet on an actively pulled path: the
      // destination pulls silence through it, so process() runs every quantum.
      const silent = context.createGain();
      silent.gain.value = 0;
      master.connect(workletNode);
      workletNode.connect(silent);
      silent.connect(destination);

      node = workletNode;
      silentGain = silent;
      ringMode = ring !== null;
    } catch (error) {
      onError(`worklet capture tap failed to start: ${describeError(error)}`);
    }
  }

  return {
    id: 'worklet',
    get rms() {
      return stats.rms;
    },
    get peak() {
      return stats.peak;
    },
    get blocks() {
      return stats.blocks;
    },
    get ring() {
      return ringMode;
    },

    attach(master, destination) {
      if (started || disposed) return;
      started = true;
      // The engine always attaches taps to nodes owned by an AudioContext
      // (never an OfflineAudioContext); only AudioContext has audioWorklet.
      const context = master.context as AudioContext;
      void load(context, master, destination);
    },

    read(out) {
      if (ring !== null) return readRing(ring, out);
      // While the worklet module is still loading neither path is warm yet.
      return readFallback(out);
    },

    dispose() {
      disposed = true;
      if (node !== null) {
        node.port.onmessage = null;
        try {
          node.disconnect();
        } catch {
          // already disconnected
        }
        node = null;
      }
      if (silentGain !== null) {
        try {
          silentGain.disconnect();
        } catch {
          // already disconnected
        }
        silentGain = null;
      }
      ring = null;
      ringMode = false;
    },
  };
}
