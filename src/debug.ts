/**
 * A tiny, deliberately read-mostly debug hook. It is also what the recording
 * of the demo was verified with: `window.__wave.probe()` returns a JSON-safe
 * snapshot of the context, both taps, the stream and the GPU backend.
 */

import type { AudioEngine, EntryPointId, FileInfo, TapId, Visualizer } from './types.ts';

export interface ProbeSnapshot {
  ready: boolean;
  entry: EntryPointId | null;
  file: FileInfo | null;
  tap: TapId;
  playing: boolean;
  muted: boolean;
  context: {
    state: AudioContextState | 'none';
    sampleRate: number;
    baseLatency: number | null;
    outputLatency: number | null;
    currentTime: number;
  };
  crossOriginIsolated: boolean;
  ring: boolean;
  taps: {
    worklet: { blocks: number; rms: number; peak: number };
    analyser: { rms: number; peak: number };
  };
  stream: { bytes: number; chunks: number };
  gpu: {
    backend: string;
    ready: boolean;
    webgpuAvailable: boolean;
    frames: number;
    errors: string[];
    displayGain: number;
  };
  errors: string[];
}

export interface DebugDeps {
  engine: AudioEngine;
  visualizer: Visualizer;
  errors: () => readonly string[];
  isPlaying: () => boolean;
  setPlaying: (playing: boolean) => void;
}

export interface WaveDebugApi {
  probe(): ProbeSnapshot;
  start(entry?: EntryPointId): Promise<void>;
  setEntryPoint(entry: EntryPointId): Promise<void>;
  setTap(tap: TapId): void;
  setMuted(muted: boolean): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

declare global {
  interface Window {
    __wave?: WaveDebugApi;
  }
}

export function installDebugHook(deps: DebugDeps): void {
  const { engine, visualizer } = deps;

  const probe = (): ProbeSnapshot => {
    const context = engine.context;
    const worklet = engine.getTap('worklet');
    const analyser = engine.getTap('analyser');
    return {
      ready: true,
      entry: engine.activeEntry,
      file: engine.file,
      tap: engine.activeTap,
      playing: deps.isPlaying(),
      muted: engine.muted,
      context: {
        state: context?.state ?? 'none',
        sampleRate: context?.sampleRate ?? 0,
        baseLatency: context?.baseLatency ?? null,
        outputLatency: context?.outputLatency ?? null,
        currentTime: context?.currentTime ?? 0,
      },
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      ring: engine.ring,
      taps: {
        worklet: {
          blocks: worklet?.blocks ?? 0,
          rms: worklet?.rms ?? 0,
          peak: worklet?.peak ?? 0,
        },
        analyser: { rms: analyser?.rms ?? 0, peak: analyser?.peak ?? 0 },
      },
      stream: { bytes: engine.stats.bytes, chunks: engine.stats.chunks },
      gpu: {
        backend: visualizer.backend,
        ready: visualizer.ready,
        webgpuAvailable: visualizer.webgpuAvailable,
        frames: visualizer.frames,
        errors: [...visualizer.errors],
        displayGain: visualizer.displayGain,
      },
      errors: [...deps.errors()],
    };
  };

  window.__wave = {
    probe,
    async start(entry = 'element') {
      await engine.start(entry);
      deps.setPlaying(true);
    },
    async setEntryPoint(entry) {
      await engine.setEntryPoint(entry);
    },
    setTap(tap) {
      engine.setTap(tap);
    },
    setMuted(muted) {
      engine.setMuted(muted);
    },
    async pause() {
      await engine.pause();
      deps.setPlaying(false);
    },
    async resume() {
      await engine.resume();
      deps.setPlaying(true);
    },
  };
}
