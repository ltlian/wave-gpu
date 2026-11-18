/**
 * The audio layer's front door: one lazily created AudioContext, one master
 * gain, three interchangeable sources and two interchangeable taps.
 *
 *                           ┌─ analyser tap  (poll getFloatTimeDomainData)
 *   source ─▶ masterGain ───┼─ worklet tap   (SAB ring / postMessage)
 *   (element | decode |      │
 *    stream)                 └─ outputGain ─▶ destination  (starts muted)
 *
 * The graph is lazy because an AudioContext cannot reliably start without a
 * user gesture: the first `start()`/`resume()` — which the UI calls from a
 * click — creates it. Both taps are attached at that point; switching taps only
 * changes which one `readFrame()` reads, so the audio path never stutters for a
 * readout change. `outputGain` sits after the taps and starts at 0, so arriving
 * at the page never produces sound unless the UI's speaker control is used.
 *
 * Source switches are serialised: the previous source is stopped before the
 * next one starts, so there is never more than one source feeding the gain.
 * Recoverable failures are reported through `onError` and never thrown out of
 * the public API — the page (and the visualization) must stay alive.
 */

import type { AudioEngine, AudioSource, EntryPointId, FileInfo, SampleTap, SourceStats, TapId } from '../types.ts';
import { createDecodedBufferSource } from './sources/decoded-buffer-source.ts';
import { createElementSource } from './sources/element-source.ts';
import { createFileSource } from './sources/file-source.ts';
import { createStreamSource } from './sources/stream-source.ts';
import { createAnalyserTap } from './taps/analyser-tap.ts';
import { createWorkletTap } from './taps/worklet-tap.ts';
import type { FileSource } from './sources/file-source.ts';
import type { WorkletTap } from './taps/worklet-tap.ts';

/** Master gain: headroom for the bundled track and the full-scale synth loop. */
const MASTER_GAIN = 0.35;
/** Entry point used by the first Play click (before one is chosen). */
const DEFAULT_ENTRY: EntryPointId = 'element';
const DEFAULT_TAP: TapId = 'worklet';
const ZERO_STATS: SourceStats = { bytes: 0, chunks: 0 };

export interface AudioEngineOptions {
  /** Receives human-readable, recoverable failures (shown in the error strip). */
  onError: (message: string) => void;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createAudioEngine(options: AudioEngineOptions): AudioEngine {
  const onError = (message: string): void => options.onError(message);

  let context: AudioContext | null = null;
  let contextPromise: Promise<AudioContext> | null = null;
  let masterGain: GainNode | null = null;
  let outputGain: GainNode | null = null;
  /** Audio output is muted until the user turns the speaker on. */
  let muted = true;
  let analyserTap: SampleTap | null = null;
  let workletTap: WorkletTap | null = null;
  let fileSource: FileSource | null = null;
  let fileInfo: FileInfo | null = null;

  const sources = new Map<EntryPointId, AudioSource>();
  let activeEntry: EntryPointId | null = null;
  let activeTap: TapId = DEFAULT_TAP;
  let disposed = false;
  /** Serialises source switches; see `enqueue()`. */
  let switchChain: Promise<void> = Promise.resolve();

  function getFileSource(): FileSource {
    if (fileSource === null) {
      fileSource = createFileSource(onError);
      sources.set('file', fileSource);
    }
    return fileSource;
  }

  function getSource(entry: EntryPointId): AudioSource {
    const existing = sources.get(entry);
    if (existing !== undefined) return existing;
    let source: AudioSource;
    if (entry === 'element') source = createElementSource(onError);
    else if (entry === 'decode') source = createDecodedBufferSource(onError);
    else if (entry === 'stream') source = createStreamSource(onError);
    else source = getFileSource();
    sources.set(entry, source);
    return source;
  }

  function enqueue(task: () => Promise<void>): Promise<void> {
    // Chain onto the previous switch whether it succeeded or failed, and never
    // let a rejected link poison the queue.
    const run = switchChain.then(task, task);
    switchChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function createGraph(): Promise<AudioContext> {
    // 'interactive' asks for the smallest buffer the device supports: good for
    // a live demo, at the (small) cost of a higher dropout risk.
    const created = new AudioContext({ latencyHint: 'interactive' });
    context = created;

    masterGain = created.createGain();
    masterGain.gain.value = MASTER_GAIN;

    outputGain = created.createGain();
    outputGain.gain.value = muted ? 0 : 1;
    masterGain.connect(outputGain);
    outputGain.connect(created.destination);

    // Attach both taps eagerly so a tap switch never has to touch the graph.
    const analyser = createAnalyserTap();
    const worklet = createWorkletTap({ onError });
    analyserTap = analyser;
    workletTap = worklet;
    for (const tap of [analyser, worklet]) {
      try {
        tap.attach(masterGain, created.destination);
      } catch (error) {
        onError(`could not attach the ${tap.id} tap: ${describeError(error)}`);
      }
    }

    // A context created without a live user gesture starts suspended. That is
    // not fatal: the click that triggered us, or the next one, calls resume().
    try {
      if (created.state !== 'running') await created.resume();
    } catch {
      // Autoplay policy only; the controls can retry.
    }
    return created;
  }

  async function ensureContext(): Promise<AudioContext> {
    if (context !== null) return context;
    if (contextPromise !== null) return contextPromise;
    contextPromise = createGraph();
    try {
      return await contextPromise;
    } finally {
      contextPromise = null;
    }
  }

  function stopActiveSource(): void {
    const entry = activeEntry;
    activeEntry = null;
    if (entry === null) return;
    const source = sources.get(entry);
    if (source === undefined) return;
    try {
      source.stop();
    } catch (error) {
      onError(`could not stop the ${entry} source: ${describeError(error)}`);
    }
  }

  /** Stop whatever is playing, then start `entry`. Runs inside `enqueue`. */
  async function startEntry(entry: EntryPointId): Promise<void> {
    let ctx: AudioContext;
    try {
      ctx = await ensureContext();
    } catch (error) {
      onError(`audio context could not be created: ${describeError(error)}`);
      return;
    }
    if (disposed) return;
    const gain = masterGain;
    if (gain === null) return;

    stopActiveSource();
    const source = getSource(entry);
    try {
      await source.start(ctx, gain);
      // A stop() may have landed while start() was awaiting (e.g. the decode
      // fetch): only claim the entry if this source was not superseded.
      if (disposed) {
        source.stop();
        return;
      }
      activeEntry = entry;
    } catch (error) {
      try {
        source.stop();
      } catch {
        // nothing to clean up
      }
      // Sources report their own failures through onError; repeating the same
      // message here is harmless because the error strip drops duplicates.
      onError(describeError(error));
    }
  }

  async function start(entry: EntryPointId): Promise<void> {
    if (disposed) return;
    let ctx: AudioContext;
    try {
      ctx = await ensureContext();
    } catch (error) {
      onError(`audio context could not be created: ${describeError(error)}`);
      return;
    }
    try {
      if (ctx.state !== 'running') await ctx.resume();
    } catch (error) {
      onError(`AudioContext.resume() was blocked (${describeError(error)}) — press Play again`);
    }
    if (disposed) return;
    if (activeEntry === entry) return; // already the active source
    await enqueue(() => startEntry(entry));
  }

  async function setEntryPoint(entry: EntryPointId): Promise<void> {
    if (disposed || activeEntry === entry) return;
    await enqueue(() => startEntry(entry));
  }

  /**
   * Load a local file and make it the active source.
   *
   * The whole swap runs inside `enqueue()` so two fast drops cannot interleave:
   * stop whatever is playing, decode the file's metadata, then start the file
   * source. The browser does the actual decoding (see `file-source.ts`).
   */
  function loadFile(file: File): Promise<void> {
    if (disposed) return Promise.resolve();
    return enqueue(async () => {
      if (disposed) return;
      let ctx: AudioContext;
      try {
        ctx = await ensureContext();
      } catch (error) {
        onError(`audio context could not be created: ${describeError(error)}`);
        return;
      }
      if (ctx.state !== 'running') {
        try {
          await ctx.resume();
        } catch (error) {
          onError(`AudioContext.resume() was blocked (${describeError(error)}) — press Play again after interacting with the page`);
        }
      }
      if (disposed) return;

      stopActiveSource();
      const source = getFileSource();
      try {
        fileInfo = await source.load(file);
      } catch (error) {
        fileInfo = null;
        onError(`could not load "${file.name}": ${describeError(error)}`);
        return;
      }
      const gain = masterGain;
      if (gain === null) return;
      try {
        await source.start(ctx, gain);
        if (disposed) {
          source.stop();
          return;
        }
        activeEntry = 'file';
      } catch (error) {
        try {
          source.stop();
        } catch {
          // nothing to clean up
        }
        onError(describeError(error));
      }
    });
  }

  async function pause(): Promise<void> {
    const ctx = context;
    if (ctx === null) return;
    try {
      await ctx.suspend();
    } catch (error) {
      onError(`AudioContext.suspend() failed: ${describeError(error)}`);
    }
  }

  async function resume(): Promise<void> {
    if (disposed) return;
    let ctx: AudioContext;
    try {
      ctx = await ensureContext();
    } catch (error) {
      onError(`audio context could not be created: ${describeError(error)}`);
      return;
    }
    try {
      if (ctx.state !== 'running') await ctx.resume();
    } catch (error) {
      onError(`AudioContext.resume() was blocked (${describeError(error)}) — press Play again after interacting with the page`);
    }
    // The primary Play button calls resume() before any entry point is chosen,
    // so that first resume also boots the default source.
    if (activeEntry === null) await enqueue(() => startEntry(DEFAULT_ENTRY));
  }

  function setTap(tap: TapId): void {
    activeTap = tap;
  }

  function setMuted(next: boolean): void {
    if (muted === next) return;
    muted = next;
    const ctx = context;
    const gain = outputGain;
    if (ctx === null || gain === null) return;
    const now = ctx.currentTime;
    try {
      // A short ramp avoids the click a hard gain jump would make.
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(muted ? 0 : 1, now + 0.03);
    } catch (error) {
      onError(`could not change the audio output: ${describeError(error)}`);
    }
  }

  /** Scratch buffer used to refresh the non-active tap (readout only). */
  let levelScratch: Float32Array | null = null;

  function readFrame(out: Float32Array): boolean {
    if (activeEntry === null) return false;
    const ctx = context;
    if (ctx === null || ctx.state !== 'running') return false;
    const tap = activeTap === 'worklet' ? workletTap : analyserTap;
    if (tap === null) return false;
    try {
      // Keep the other tap warm too: the readout shows both read paths, and the
      // graph does not care which one the frame loop consumes.
      const other = activeTap === 'worklet' ? analyserTap : workletTap;
      if (other !== null) {
        if (levelScratch === null || levelScratch.length !== out.length) {
          levelScratch = new Float32Array(out.length);
        }
        try {
          other.read(levelScratch);
        } catch {
          // A stale level is cosmetic; never let it break the frame loop.
        }
      }
      return tap.read(out);
    } catch (error) {
      onError(`reading the ${tap.id} tap failed: ${describeError(error)}`);
      return false;
    }
  }

  function getTap(tap: TapId): SampleTap | null {
    return tap === 'worklet' ? workletTap : analyserTap;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopActiveSource();
    for (const source of sources.values()) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
      try {
        source.dispose?.();
      } catch {
        // best-effort cleanup of external resources
      }
    }
    sources.clear();
    fileSource = null;
    fileInfo = null;
    analyserTap?.dispose();
    workletTap?.dispose();
    analyserTap = null;
    workletTap = null;
    if (outputGain !== null) {
      try {
        outputGain.disconnect();
      } catch {
        // already disconnected
      }
      outputGain = null;
    }
    if (masterGain !== null) {
      try {
        masterGain.disconnect();
      } catch {
        // already disconnected
      }
      masterGain = null;
    }
    const ctx = context;
    context = null;
    if (ctx !== null) void ctx.close().catch(() => {});
  }

  return {
    get context() {
      return context;
    },
    get activeEntry() {
      return activeEntry;
    },
    get activeTap() {
      return activeTap;
    },
    get paused() {
      return context !== null && context.state === 'suspended';
    },
    get muted() {
      return muted;
    },
    get ring() {
      return workletTap?.ring ?? false;
    },
    get stats() {
      if (activeEntry === null) return ZERO_STATS;
      return sources.get(activeEntry)?.stats ?? ZERO_STATS;
    },
    get file() {
      return fileInfo;
    },
    ensureContext,
    start,
    loadFile,
    setEntryPoint,
    setTap,
    setMuted,
    pause,
    resume,
    readFrame,
    getTap,
    dispose,
  };
}
