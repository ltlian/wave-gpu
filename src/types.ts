/**
 * The small set of contracts that keep this example's layers independent.
 *
 *   ingest (AudioSource)  →  tap (SampleTap)  →  consume (Visualizer)
 *
 * The browser's Web Audio graph is the meeting point: a source connects to the
 * engine's master gain, both taps are attached to that gain, and the frame loop
 * reads whichever tap is selected and hands the samples to the visualizer.
 * Nothing in `sources/` knows about WebGPU; nothing in `gpu/` knows where the
 * samples came from.
 */

export const ENTRY_POINT_IDS = ['element', 'decode', 'stream', 'file'] as const;
export type EntryPointId = (typeof ENTRY_POINT_IDS)[number];

export const TAP_IDS = ['worklet', 'analyser'] as const;
export type TapId = (typeof TAP_IDS)[number];

/** The drawing backends; the user can switch between them at runtime. */
export const RENDERER_IDS = ['webgpu', '2d', 'svg'] as const;
export type RendererId = (typeof RENDERER_IDS)[number];

export interface SourceStats {
  bytes: number;
  chunks: number;
}

/** A local file the user dropped or picked; `durationSeconds` is 0 until known. */
export interface FileInfo {
  name: string;
  size: number;
  durationSeconds: number;
}

/**
 * One way of getting audio into the graph. Implementations own everything
 * below the destination node: element playback, buffer decoding, fetching and
 * scheduling raw PCM chunks, or a user's local file behind a blob URL.
 */
export interface AudioSource {
  readonly id: EntryPointId;
  /** Only meaningful for network sources; zeros otherwise. */
  readonly stats: SourceStats;
  start(context: AudioContext, destination: AudioNode): Promise<void>;
  stop(): void;
  /** Optional cleanup for sources that hold external resources (blob URLs, tracks). */
  dispose?(): void;
}

/**
 * One way of reading what is playing. Every tap sees the same master gain,
 * so the read path can change without touching the entry point.
 */
export interface SampleTap {
  readonly id: TapId;
  /** Latest RMS / peak of the tapped signal (mono downmix). */
  readonly rms: number;
  readonly peak: number;
  /** Worklet render quanta processed; 0 for the analyser. */
  readonly blocks: number;
  /**
   * Wire the tap into the graph. `master` is the signal to read, `destination`
   * exists so a worklet tap can stay "actively processing" through a silent gain.
   */
  attach(master: AudioNode, destination: AudioNode): void;
  /** Fill `out` with the most recent samples. False until the tap is warm. */
  read(out: Float32Array): boolean;
  dispose(): void;
}

export interface FrameMeta {
  rms: number;
  peak: number;
}

/** The consumer: anything that can draw a frame of samples. */
export interface Visualizer {
  readonly backend: RendererId;
  readonly ready: boolean;
  readonly errors: readonly string[];
  /** True while WebGPU can be selected; false after a failed initialisation. */
  readonly webgpuAvailable: boolean;
  /** Why WebGPU is unavailable, for the disabled control's tooltip. */
  readonly webgpuUnavailableReason: string | null;
  readonly displayGain: number;
  readonly frames: number;
  render(samples: Float32Array, meta: FrameMeta): void;
  resize(): void;
  /** Switch drawing backends; a no-op when already active or unavailable. */
  setBackend(backend: RendererId): Promise<void>;
  destroy(): void;
}

/**
 * Owns the AudioContext, the master gain, the sources and the taps. Created
 * lazily because a context cannot reliably start without a user gesture.
 */
export interface AudioEngine {
  readonly context: AudioContext | null;
  readonly activeEntry: EntryPointId | null;
  readonly activeTap: TapId;
  readonly paused: boolean;
  /** True when the worklet tap is running on a SharedArrayBuffer ring. */
  readonly ring: boolean;
  readonly stats: SourceStats;
  /** The file currently loaded into the `file` entry point, if any. */
  readonly file: FileInfo | null;
  ensureContext(): Promise<AudioContext>;
  start(entry: EntryPointId): Promise<void>;
  /** Load a local file (blob URL + `<audio>`) and switch the engine to it. */
  loadFile(file: File): Promise<void>;
  setEntryPoint(entry: EntryPointId): Promise<void>;
  setTap(tap: TapId): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Fill `out` from the active tap. False when there is nothing to read yet. */
  readFrame(out: Float32Array): boolean;
  getTap(tap: TapId): SampleTap | null;
  dispose(): void;
}

/** Snapshot the UI needs to render the live readout. */
export interface ReadoutState {
  entry: EntryPointId | null;
  /** Which audio the engine is playing: the bundled track, the stream loop. */
  track: string;
  file: FileInfo | null;
  tap: TapId;
  playing: boolean;
  contextState: AudioContextState | 'none';
  sampleRate: number;
  baseLatency: number | null;
  outputLatency: number | null;
  crossOriginIsolated: boolean;
  ring: boolean;
  workletBlocks: number;
  workletRms: number;
  workletPeak: number;
  analyserRms: number;
  analyserPeak: number;
  streamBytes: number;
  streamChunks: number;
  /** Which renderer is drawing ('webgpu' | '2d' | 'svg'). */
  rendererBackend: string;
  rendererReady: boolean;
  displayGain: number;
  fps: number;
}
