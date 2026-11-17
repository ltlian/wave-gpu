/**
 * Backend selection and the display-side frame preparation.
 *
 * `createVisualizer(canvas)` tries WebGPU first; if any part of that fails it
 * records a human-readable reason and builds the Canvas2D renderer instead, so
 * the app always has something to draw into. Everything here is display-only:
 * the audio tap owns the samples and `src/main.ts` owns the raw RMS/peak values,
 * so this module never writes to the caller's buffer — the auto-gain is applied
 * to an internal copy and the raw meta values only drive colour.
 */

import { FRAME_SAMPLES } from '../../shared/audio.ts';
import type { FrameMeta, Visualizer } from '../types.ts';
import { createCanvas2dBackend } from './canvas2d.ts';
import { createDisplayGain } from './display-gain.ts';
import { createWebGpuBackend } from './webgpu.ts';

/** CSS-pixel size of the stage plus the device-pixel-ratio to render at. */
export interface CanvasSize {
  width: number;
  height: number;
  dpr: number;
}

/** Per-frame input shared by both backends (samples are the normalised copy). */
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
  readonly backend: 'webgpu' | '2d';
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
    displayGain: 1,
    frames: 0,
    render() {
      // Nothing can draw: stay silent instead of throwing from the frame loop.
    },
    resize() {},
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

  let target = canvas;
  let backend: RenderBackend | null = null;

  try {
    backend = await createWebGpuBackend(target, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report(`WebGPU initialisation failed unexpectedly: ${message} — the Canvas2D fallback will be used.`);
  }

  if (!backend) {
    // Collect Canvas2D creation messages instead of reporting them immediately:
    // on a canvas already bound to a 'webgpu' context getContext('2d') returns
    // null, and the replacement-canvas path below then succeeds. Reporting the
    // first attempt's message in that case would be misleading.
    const fallbackMessages: string[] = [];
    backend = createCanvas2dBackend(target, (message) => fallbackMessages.push(message));
    if (!backend) {
      // cloneNode() preserves the element type, so this assertion is safe; using
      // the cast keeps the code independent of a global HTMLCanvasElement binding.
      const clone = canvas.cloneNode(false) as HTMLCanvasElement;
      if (canvas.parentNode) {
        canvas.parentNode.replaceChild(clone, canvas);
        target = clone;
        backend = createCanvas2dBackend(clone, report);
        if (backend) {
          report('WebGPU left the stage canvas bound to a GPU context; the Canvas2D fallback used a replacement canvas.');
        } else {
          for (const message of fallbackMessages) report(message);
        }
      } else {
        for (const message of fallbackMessages) report(message);
      }
    }
  }

  if (!backend) {
    report('No rendering backend is available — the stage will stay blank.');
    return createBlankVisualizer(errors);
  }
  const renderer = backend;

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
    if (destroyed) return;
    try {
      renderer.resize(measure());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report(`Visualizer resize failed: ${message}`);
    }
  }

  // ResizeObserver covers layout changes of the stage panel; the window listener
  // also catches a devicePixelRatio change (e.g. moving to another display).
  const observer = new ResizeObserver(applySize);
  observer.observe(target);
  window.addEventListener('resize', applySize);
  applySize();

  function render(input: Float32Array, meta: FrameMeta): void {
    if (destroyed) return;

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
      renderer.destroy();
    } catch {
      // The backend is being torn down; nothing left to report.
    }
  }

  return {
    backend: renderer.backend,
    ready: true,
    errors,
    get displayGain(): number {
      return appliedGain;
    },
    get frames(): number {
      return frames;
    },
    render,
    resize: applySize,
    destroy,
  };
}
