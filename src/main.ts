/**
 * Wiring only: build the engine + visualizer, bind the controls, connect the
 * render loop, and expose a small read-only probe for debugging/verification.
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
import { createPipelineAccent } from './ui/pipeline-accent.ts';
import { createPipelineTrace } from './ui/pipeline-trace.ts';
import { createReadout } from './ui/readout.ts';
import { installDebugHook } from './debug.ts';
import { STREAM_LOOP_LABEL, TRACK_LABEL } from './audio/tracks.ts';
import { createRenderLoop } from './render-loop.ts';
import type { AudioEngine, EntryPointId, ReadoutState, RendererId, TapId, Visualizer } from './types.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
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
    // Tapping a layer while paused changes no audio graph state the loop would
    // notice, so refresh the readout and trace explicitly.
    updateReadout();
  },
  onRenderer: (renderer) => {
    void switchRenderer(renderer);
  },
});
const readout = createReadout(document);
const trace = createPipelineTrace(document);
const accent = createPipelineAccent(document);

/** What is audible, as opposed to how it got there (`entry`). */
function describeTrack(entry: EntryPointId | null): string {
  if (entry === 'stream') return STREAM_LOOP_LABEL;
  if (entry === 'file') return 'local file';
  if (entry === 'element' || entry === 'decode') return TRACK_LABEL;
  return '';
}

let playing = false;
let busy = false;
let switchingRenderer = false;

/**
 * Swap the drawing backend. The audio graph, tap selection and readout are all
 * untouched; only the renderer behind the stage canvas changes.
 */
async function switchRenderer(renderer: RendererId): Promise<void> {
  if (switchingRenderer || visualizer.backend === renderer) return;
  switchingRenderer = true;
  try {
    await visualizer.setBackend(renderer);
  } finally {
    switchingRenderer = false;
    forwardVisualizerErrors();
    if (!playing) loop.drawIdle();
    updateReadout();
  }
}

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
    loop.sync();
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
    loop.sync();
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
    loop.sync();
  }
}

function updateReadout(): void {
  forwardVisualizerErrors();
  const context = engine.context;
  const worklet = engine.getTap('worklet');
  const analyser = engine.getTap('analyser');
  const state: ReadoutState = {
    entry: engine.activeEntry,
    track: describeTrack(engine.activeEntry),
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
    rendererBackend: visualizer.backend,
    rendererReady: visualizer.ready,
    displayGain: visualizer.displayGain,
    fps: loop.fps,
  };
  readout.update(state);
  controls.setPlaying(playing);
  controls.setEntryPoint(engine.activeEntry ?? 'element');
  controls.setTap(engine.activeTap);
  controls.setRenderer(visualizer.backend);
  controls.setRendererAvailable('webgpu', visualizer.webgpuAvailable, visualizer.webgpuUnavailableReason);
  trace.update();
}

const loop = createRenderLoop({
  engine,
  visualizer,
  accent,
  isPlaying: () => playing,
  onReadout: updateReadout,
});

installDebugHook({
  engine,
  visualizer,
  errors: () => errors.list(),
  isPlaying: () => playing,
  setPlaying: (value) => {
    playing = value;
    loop.sync();
  },
});

loop.drawIdle();
updateReadout();
