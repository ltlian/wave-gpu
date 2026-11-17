/**
 * Wiring only: build the engine + visualizer, bind the controls, run the frame
 * loop, and expose a small read-only probe for debugging/verification.
 *
 * Everything interesting lives one directory down:
 *   audio/  — how audio gets into the graph and how it is tapped
 *   gpu/    — how sampled frames become pixels
 *   ui/     — DOM-only code
 */

import './styles.css';
import { createAudioEngine } from './audio/engine.ts';
import { createVisualizer } from './gpu/visualizer.ts';
import { createControls } from './ui/controls.ts';
import { createErrorStrip } from './ui/errors.ts';
import { createFileDrop } from './ui/file-drop.ts';
import { createReadout } from './ui/readout.ts';
import { installDebugHook } from './debug.ts';
import { createIdlePreview } from './idle-preview.ts';
import { FRAME_SAMPLES } from '../shared/audio.ts';
import type { AudioEngine, EntryPointId, ReadoutState, TapId, Visualizer } from './types.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
const stageNote = document.querySelector<HTMLElement>('#stage-note');
if (!canvas) throw new Error('missing #stage canvas');

const errors = createErrorStrip(document);
window.addEventListener('error', (event) => {
  errors.add(event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  errors.add(`unhandled rejection: ${String(event.reason)}`);
});

const visualizer: Visualizer = await createVisualizer(canvas);

/** Surface GPU errors that appear after startup, not just the ones from init. */
let forwardedVisualizerErrors = 0;
function forwardVisualizerErrors(): void {
  for (; forwardedVisualizerErrors < visualizer.errors.length; forwardedVisualizerErrors += 1) {
    const message = visualizer.errors[forwardedVisualizerErrors];
    if (message !== undefined) errors.add(message);
  }
}
forwardVisualizerErrors();
stageNote?.remove();

const engine: AudioEngine = createAudioEngine({ onError: (message) => errors.add(message) });

const fileDrop = createFileDrop(document, {
  onFile: (file) => {
    void loadFile(file);
  },
  onError: (message) => errors.add(message),
});

const controls = createControls(document, {
  onTogglePlayback: () => {
    void togglePlayback();
  },
  onEntryPoint: (entry) => {
    // The "file" button has no audio of its own until something is loaded.
    if (entry === 'file' && engine.file === null) {
      fileDrop.openPicker();
      return;
    }
    void selectEntryPoint(entry);
  },
  onTap: (tap) => {
    engine.setTap(tap);
    controls.setTap(tap);
  },
});
const readout = createReadout(document);

let playing = false;
let busy = false;
let fps = 0;

async function togglePlayback(): Promise<void> {
  if (busy) return;
  busy = true;
  controls.setBusy(true);
  try {
    if (playing) {
      await engine.pause();
      playing = false;
    } else {
      await engine.resume();
      playing = true;
    }
  } finally {
    busy = false;
    controls.setBusy(false);
    controls.setPlaying(playing);
    updateReadout();
  }
}

async function selectEntryPoint(entry: EntryPointId): Promise<void> {
  if (busy) return;
  busy = true;
  controls.setBusy(true);
  try {
    if (!playing) {
      await engine.start(entry);
      playing = true;
      controls.setPlaying(true);
    } else {
      await engine.setEntryPoint(entry);
    }
  } finally {
    busy = false;
    controls.setBusy(false);
    updateReadout();
  }
}

/**
 * A file arrived from the picker or a drop. The engine owns the actual loading
 * (blob URL + browser decoder); here we just serialise the UI around it.
 */
async function loadFile(file: File): Promise<void> {
  if (busy) return;
  busy = true;
  controls.setBusy(true);
  try {
    await engine.loadFile(file);
    playing = engine.activeEntry !== null && !engine.paused;
  } finally {
    busy = false;
    controls.setBusy(false);
    controls.setPlaying(playing);
    updateReadout();
  }
}

function updateReadout(): void {
  forwardVisualizerErrors();
  const context = engine.context;
  const worklet = engine.getTap('worklet');
  const analyser = engine.getTap('analyser');
  const state: ReadoutState = {
    entry: engine.activeEntry,
    file: engine.file,
    tap: engine.activeTap,
    playing,
    contextState: context?.state ?? 'none',
    sampleRate: context?.sampleRate ?? 0,
    baseLatency: context?.baseLatency ?? null,
    outputLatency: context?.outputLatency ?? null,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    ring: engine.ring,
    workletBlocks: worklet?.blocks ?? 0,
    workletRms: worklet?.rms ?? 0,
    workletPeak: worklet?.peak ?? 0,
    analyserRms: analyser?.rms ?? 0,
    analyserPeak: analyser?.peak ?? 0,
    streamBytes: engine.stats.bytes,
    streamChunks: engine.stats.chunks,
    gpuBackend: visualizer.backend,
    gpuReady: visualizer.ready,
    displayGain: visualizer.displayGain,
    fps,
  };
  readout.update(state);
  controls.setPlaying(playing);
  controls.setEntryPoint(engine.activeEntry ?? 'element');
  controls.setTap(engine.activeTap);
}

installDebugHook({
  engine,
  visualizer,
  errors: () => errors.list(),
  isPlaying: () => playing,
  setPlaying: (value) => {
    playing = value;
  },
});

const idlePreview = createIdlePreview(FRAME_SAMPLES);
const frame = new Float32Array(FRAME_SAMPLES);

let framesSinceSample = 0;
let sampledAt = performance.now();
let readoutAt = 0;

function measure(samples: Float32Array): { rms: number; peak: number } {
  let sumSquares = 0;
  let peak = 0;
  for (const value of samples) {
    sumSquares += value * value;
    const magnitude = value < 0 ? -value : value;
    if (magnitude > peak) peak = magnitude;
  }
  return { rms: Math.sqrt(sumSquares / samples.length), peak };
}

function tick(now: number): void {
  const live = engine.readFrame(frame);
  if (!live) idlePreview.write(frame, now);
  visualizer.render(frame, live ? measure(frame) : { rms: 0, peak: 0 });

  framesSinceSample += 1;
  const elapsed = now - sampledAt;
  if (elapsed >= 500) {
    fps = Math.round((framesSinceSample * 1000) / elapsed);
    framesSinceSample = 0;
    sampledAt = now;
  }
  if (now - readoutAt >= 100) {
    readoutAt = now;
    updateReadout();
  }
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
updateReadout();
