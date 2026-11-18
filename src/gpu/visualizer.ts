/**
 * Backend selection, runtime switching and the display-side frame preparation.
 *
 * Three backends share one `RenderBackend` contract: a WebGPU compute/render
 * pipeline, an immediate-mode Canvas2D drawing, and a retained-mode SVG layer.
 * The SVG backend mounts a sibling `<svg>` and hides the canvas instead of using
 * it, but it still receives the same normalised frame, so nothing above this
 * module needs to know which one is drawing.
 *
 * `createVisualizer(canvas)` tries WebGPU first; if any part of that fails it
 * records a human-readable reason and builds the Canvas2D renderer instead, so
 * the app always has something to draw into. Every backend stays available to
 * the UI afterwards (`setBackend()`), which is what the renderer control uses
 * to compare them on a machine that supports both. Everything here is
 * display-only: the audio tap owns the samples and `src/main.ts` owns the raw
 * RMS/peak values, so this module never writes to the caller's buffer — the
 * auto-gain is applied to an internal copy and the raw meta values only drive
 * colour.
 */

import { FRAME_SAMPLES } from '../../shared/audio.ts';
import type { FrameMeta, RendererId, Visualizer } from '../types.ts';
import { createCanvas2dBackend } from './canvas2d.ts';
import { createDisplayGain } from './display-gain.ts';
import { createSvgBackend } from './svg.ts';
import { createWebGpuBackend } from './webgpu.ts';

/** CSS-pixel size of the stage plus the device-pixel-ratio to render at. */
export interface CanvasSize {
  width: number;
  height: number;
  dpr: number;
}

/** Per-frame input shared by every backend (samples are the normalised copy). */
export interface BackendFrame {
  samples: Float32Array;
  /** Seconds since load; only used for slow cosmetic breathing. */
  time: number;
  /** 0..1 colour energy from the raw RMS/peak. */
  level: number;
  /** 0..1 peak emphasis from the raw RMS/peak. */
  crest: number;
  /** Drawn half-height (fraction of the panel) for a full-scale column. */
  ampScale: number;
}

export interface RenderBackend {
  readonly backend: RendererId;
  resize(size: CanvasSize): void;
  render(frame: BackendFrame): void;
  destroy(): void;
}

/** Never upscale beyond 2x: the stage canvas is already large. */
const MAX_DPR = 2;
/** Fewer than this many stored messages keeps the strip readable. */
const MAX_ERRORS = 16;

/** Idle preview frames: fixed, pleasant level — no auto-gain chasing. */
const IDLE_LEVEL = 0.42;
const IDLE_CREST = 0.5;
/** Fixed drawn half-height for the idle preview's loudest column. */
const IDLE_TARGET_HALF_HEIGHT = 0.3;

const SAMPLES_PER_COLUMN = 8;
const COLUMN_COUNT = FRAME_SAMPLES / SAMPLES_PER_COLUMN;
/** Drawn half-height (fraction of the panel) for the loudest live column. */
const TARGET_HALF_HEIGHT = 0.42;
/** Envelope-scale smoothing: quick to open up, calm coming back down. */
const ENVELOPE_ATTACK = 0.75;
const ENVELOPE_RELEASE = 0.12;
/** Keeps a flat frame from asking for an infinite envelope scale. */
const MIN_ENVELOPE_PEAK = 0.005;

function createBlankVisualizer(errors: string[]): Visualizer {
  return {
    backend: '2d',
    ready: false,
    errors,
    webgpuAvailable: false,
    webgpuUnavailableReason: null,
    displayGain: 1,
    frames: 0,
    render() {
      // Nothing can draw: stay silent instead of throwing from the frame loop.
    },
    resize() {},
    async setBackend() {
      // No backend exists to switch away from.
    },
    destroy() {},
  };
}

export async function createVisualizer(canvas: HTMLCanvasElement): Promise<Visualizer> {
  const errors: string[] = [];
  const report = (message: string): void => {
    const text = message.trim();
    if (text.length === 0 || text === errors[errors.length - 1]) return;
    if (errors.length >= MAX_ERRORS) errors.shift();
    errors.push(text);
  };

  /** The stage panel; the SVG backend mounts its `<svg>` here. */
  const stage = canvas.parentElement;

  let target = canvas;
  let renderer: RenderBackend | null = null;
  let kind: RendererId | null = null;
  let webgpuAvailable = false;
  let webgpuUnavailableReason: string | null = null;

  /**
   * A canvas that has handed out one context type can never hand out the other,
   * so switching backends (or recovering from a failed WebGPU attempt) swaps in
   * an identical, context-free clone and keeps drawing into that. `cloneNode`
   * also copies the current backing-store size, so the swap does not flash.
   */
  function replaceCanvas(): boolean {
    const clone = target.cloneNode(false) as HTMLCanvasElement;
    if (!target.parentNode) return false;
    target.parentNode.replaceChild(clone, target);
    target = clone;
    return true;
  }

  /** Mount WebGPU on the current canvas, recording why it failed if it did. */
  async function mountWebGpu(): Promise<boolean> {
    const reasonStart = errors.length;
    try {
      const next = await createWebGpuBackend(target, report);
      if (next) {
        renderer = next;
        kind = 'webgpu';
        webgpuAvailable = true;
        webgpuUnavailableReason = null;
        return true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report(`WebGPU initialisation failed unexpectedly: ${message} — the Canvas2D fallback will be used.`);
    }
    webgpuAvailable = false;
    webgpuUnavailableReason = errors[reasonStart] ?? 'WebGPU is not available in this browser.';
    return false;
  }

  /**
   * Mount the SVG backend on an `<svg>` sibling of the stage canvas. The canvas
   * is only hidden, never removed or resized, so `measure()` and the existing
   * ResizeObserver keep working while the SVG layer is active.
   */
  function mountSvg(): boolean {
    if (!stage) {
      report('The SVG renderer needs a stage container to mount into.');
      return false;
    }
    const next = createSvgBackend(stage, report);
    if (!next) return false;
    renderer = next;
    kind = 'svg';
    target.style.visibility = 'hidden';
    return true;
  }

  /**
   * Mount Canvas2D on the current canvas, replacing the element if a WebGPU
   * attempt has bound it. `quiet` suppresses the replacement note for a
   * user-initiated switch, where a fresh element is expected rather than a
   * fallback.
   */
  function mountCanvas2d(quiet: boolean): boolean {
    // Collect the first attempt's messages instead of reporting them
    // immediately: on a canvas already bound to a 'webgpu' context
    // getContext('2d') returns null, and the replacement-canvas path below then
    // succeeds. Reporting the first attempt's message in that case would be
    // misleading.
    const attemptMessages: string[] = [];
    const first = createCanvas2dBackend(target, (message) => attemptMessages.push(message));
    if (first) {
      renderer = first;
      kind = '2d';
      return true;
    }
    if (replaceCanvas()) {
      const second = createCanvas2dBackend(target, report);
      if (second) {
        renderer = second;
        kind = '2d';
        if (!quiet) {
          report('WebGPU left the stage canvas bound to a GPU context; the Canvas2D fallback used a replacement canvas.');
        }
        return true;
      }
    }
    for (const message of attemptMessages) report(message);
    return false;
  }

  if (!(await mountWebGpu()) && !mountCanvas2d(false)) {
    report('No rendering backend is available — the stage will stay blank.');
    return createBlankVisualizer(errors);
  }

  const drawSamples = new Float32Array(FRAME_SAMPLES);
  const displayGain = createDisplayGain();
  let frames = 0;
  let appliedGain = 1;
  let envelopePeak = 0;
  let destroyed = false;

  /**
   * Largest per-column excursion of an already-normalised frame, i.e. what the
   * compute shader's `max(|max-center|, |center-min|)` will produce for the
   * loudest column.
   */
  function measureColumnPeak(samples: Float32Array): number {
    let peak = 0;
    for (let column = 0; column < COLUMN_COUNT; column++) {
      const base = column * SAMPLES_PER_COLUMN;
      let minimum = 1;
      let maximum = -1;
      let sum = 0;
      for (let i = 0; i < SAMPLES_PER_COLUMN; i++) {
        const value = samples[base + i];
        if (value < minimum) minimum = value;
        if (value > maximum) maximum = value;
        sum += value;
      }
      const center = sum / SAMPLES_PER_COLUMN;
      const left = Math.abs(maximum - center);
      const right = Math.abs(center - minimum);
      const excursion = left > right ? left : right;
      if (excursion > peak) peak = excursion;
    }
    return peak;
  }

  /**
   * Normalising the sample peak to ±1 fixes the sample scale, not the drawn
   * envelope: eight samples of bass-heavy audio span only a fraction of full
   * scale, so a fixed uniform would draw a thin line. Track the loudest column
   * excursion separately and scale the envelope so it reaches TARGET_HALF_HEIGHT
   * — the same display-only idea as the prototype, just split from the copy
   * normalisation so the samples themselves stay in ±1.
   */
  function envelopeScaleFor(samples: Float32Array): number {
    const measured = Math.max(measureColumnPeak(samples), MIN_ENVELOPE_PEAK);
    if (envelopePeak === 0) envelopePeak = measured;
    else envelopePeak += (measured - envelopePeak) * (measured > envelopePeak ? ENVELOPE_ATTACK : ENVELOPE_RELEASE);
    return TARGET_HALF_HEIGHT / Math.max(envelopePeak, MIN_ENVELOPE_PEAK);
  }

  function measure(): CanvasSize {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, MAX_DPR);
    const rect = target.getBoundingClientRect();
    return { width: Math.max(1, rect.width), height: Math.max(1, rect.height), dpr };
  }

  function applySize(): void {
    if (destroyed || renderer === null) return;
    try {
      renderer.resize(measure());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report(`Visualizer resize failed: ${message}`);
    }
  }

  // ResizeObserver covers layout changes of the stage panel; the window listener
  // also catches a devicePixelRatio change (e.g. moving to another display).
  // The observer is re-pointed whenever a backend switch replaces the canvas.
  const observer = new ResizeObserver(applySize);
  observer.observe(target);
  window.addEventListener('resize', applySize);
  applySize();

  function attachToCanvas(): void {
    observer.disconnect();
    observer.observe(target);
    applySize();
  }

  /**
   * Switch drawing backends without disturbing the audio/readout side. The
   * current renderer is torn down and a fresh canvas element is used, because a
   * canvas cannot change context type once it has handed one out.
   */
  async function setBackend(next: RendererId): Promise<void> {
    if (destroyed || next === kind) return;
    if (next === 'webgpu' && !webgpuAvailable) return;

    renderer?.destroy();
    renderer = null;
    kind = null;

    if (next === 'svg') {
      if (mountSvg()) {
        // Unlike the canvas backends there is no attachToCanvas() here: the
        // canvas keeps its size while hidden, so the observer still tracks the
        // panel, but the new SVG layer needs its initial viewBox.
        applySize();
        return;
      }
      // The SVG layer could not be created: keep the page drawing on the canvas
      // rather than blanking the stage.
      target.style.visibility = '';
      if (mountCanvas2d(true)) {
        attachToCanvas();
        return;
      }
      report('No rendering backend is available — the stage will stay blank.');
      return;
    }

    // Any canvas backend needs a visible, context-free canvas: it may have been
    // hidden for the SVG layer, and a canvas cannot hand out a second context.
    target.style.visibility = '';
    replaceCanvas();
    if (next === 'webgpu') {
      if (await mountWebGpu()) {
        attachToCanvas();
        return;
      }
      // WebGPU failed on a canvas that worked before (e.g. the GPU went away):
      // keep the page drawing by falling back.
      replaceCanvas();
    }
    if (mountCanvas2d(true)) {
      attachToCanvas();
    } else {
      report('No rendering backend is available — the stage will stay blank.');
    }
  }

  function render(input: Float32Array, meta: FrameMeta): void {
    if (destroyed || renderer === null) return;

    const count = Math.min(input.length, FRAME_SAMPLES);
    drawSamples.set(input.subarray(0, count), 0);
    if (count < FRAME_SAMPLES) drawSamples.fill(0, count);

    // Idle preview frames arrive with raw rms/peak of 0 (main.ts keeps drawing
    // while no tap has samples yet). Draw them at a fixed, pleasant level.
    const idle = !(meta.peak > 0) && !(meta.rms > 0);
    let level: number;
    let crest: number;
    let ampScale: number;
    if (idle) {
      appliedGain = 1;
      level = IDLE_LEVEL;
      crest = IDLE_CREST;
      // The idle preview is smooth and low-frequency, so its 8-sample columns
      // barely span anything: use a fixed drawn target (no auto-gain animation).
      ampScale = IDLE_TARGET_HALF_HEIGHT / Math.max(measureColumnPeak(drawSamples), MIN_ENVELOPE_PEAK);
    } else {
      // Only the internal copy is normalised; the caller's buffer and meta stay raw.
      appliedGain = displayGain.apply(drawSamples);
      ampScale = envelopeScaleFor(drawSamples);
      level = Math.min(1, meta.rms * 3.5 + meta.peak * 1.5);
      crest = Math.min(1, meta.peak * 4);
    }

    renderer.render({ samples: drawSamples, time: performance.now() / 1000, level, crest, ampScale });
    frames += 1;
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    observer.disconnect();
    window.removeEventListener('resize', applySize);
    try {
      renderer?.destroy();
    } catch {
      // The backend is being torn down; nothing left to report.
    }
    renderer = null;
    target.style.visibility = '';
  }

  return {
    get backend(): RendererId {
      return kind ?? '2d';
    },
    get ready(): boolean {
      return renderer !== null;
    },
    errors,
    get webgpuAvailable(): boolean {
      return webgpuAvailable;
    },
    get webgpuUnavailableReason(): string | null {
      return webgpuUnavailableReason;
    },
    get displayGain(): number {
      return appliedGain;
    },
    get frames(): number {
      return frames;
    },
    render,
    resize: applySize,
    setBackend,
    destroy,
  };
}
