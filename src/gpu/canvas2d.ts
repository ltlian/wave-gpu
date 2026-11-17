/**
 * Canvas2D fallback: the same picture as the WebGPU pass, drawn with paths.
 *
 * Used when WebGPU is unavailable (no adapter, blocked, shader failure, ...).
 * It buckets the 2048 samples into the same 256 columns × 8 samples summary the
 * GPU compute shader would produce, then fills a symmetric violet→cyan envelope
 * with a gradient and a soft `shadowBlur` glow. 256 columns and a handful of
 * gradients per frame is comfortably a 60 fps workload for Canvas2D.
 */

import { FRAME_SAMPLES } from '../../shared/audio.ts';
import type { BackendFrame, CanvasSize, RenderBackend } from './visualizer.ts';

/** Each column summarises this many samples (2048 / 8 = 256 columns). */
const SAMPLES_PER_COLUMN = 8;
const COLUMN_COUNT = FRAME_SAMPLES / SAMPLES_PER_COLUMN;

type Rgb = readonly [number, number, number];

const VIOLET: Rgb = [124, 77, 255];
const CYAN: Rgb = [34, 211, 238];
const WHITE: Rgb = [255, 255, 255];

function mix(from: Rgb, to: Rgb, t: number): Rgb {
  return [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ];
}

function rgba(color: Rgb, alpha: number): string {
  return `rgba(${Math.round(color[0])}, ${Math.round(color[1])}, ${Math.round(color[2])}, ${alpha})`;
}

export function createCanvas2dBackend(
  canvas: HTMLCanvasElement,
  report: (message: string) => void,
): RenderBackend | null {
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext('2d');
  } catch {
    // Chromium returns null instead of throwing when the canvas is bound to a
    // different context type, but be defensive in case another engine throws.
    report('Canvas2D: canvas.getContext("2d") threw while creating the fallback context.');
    return null;
  }
  if (!context) {
    report('Canvas2D: canvas.getContext("2d") returned null.');
    return null;
  }
  const ctx = context;

  const amplitudes = new Float32Array(COLUMN_COUNT);
  const smoothed = new Float32Array(COLUMN_COUNT);
  let dpr = 1;
  let cssWidth = 1;
  let cssHeight = 1;
  let destroyed = false;

  function resize(size: CanvasSize): void {
    if (destroyed) return;
    dpr = size.dpr > 0 ? size.dpr : 1;
    cssWidth = Math.max(1, size.width);
    cssHeight = Math.max(1, size.height);
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  }

  /** 2048 samples → 256 symmetric half-amplitudes, plus one smoothing pass. */
  function computeAmps(samples: Float32Array): void {
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
      amplitudes[column] = left > right ? left : right;
    }
    // One neighbour pass keeps column edges from looking like a picket fence.
    for (let column = 0; column < COLUMN_COUNT; column++) {
      const left = amplitudes[column > 0 ? column - 1 : column];
      const right = amplitudes[column < COLUMN_COUNT - 1 ? column + 1 : column];
      smoothed[column] = (left + amplitudes[column] * 2 + right) * 0.25;
    }
    amplitudes.set(smoothed);
  }

  function render(frame: BackendFrame): void {
    if (destroyed) return;
    if (canvas.width < 1 || canvas.height < 1) return;
    if (frame.samples.length < FRAME_SAMPLES) return;

    const width = cssWidth;
    const height = cssHeight;
    const midY = height * 0.5;
    const energy = Math.min(1, Math.max(0, frame.level));
    const breathe = 0.84 + 0.16 * Math.sin(frame.time * 0.7);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ---- backdrop + soft halo ---------------------------------------------
    const backdrop = ctx.createLinearGradient(0, 0, 0, height);
    backdrop.addColorStop(0, '#05070d');
    backdrop.addColorStop(0.55, '#0a0e1b');
    backdrop.addColorStop(1, '#04060b');
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, width, height);

    const halo = ctx.createRadialGradient(
      width * 0.5,
      height * 0.5,
      Math.min(width, height) * 0.05,
      width * 0.5,
      height * 0.5,
      Math.max(width, height) * 0.75,
    );
    halo.addColorStop(0, 'rgba(70, 96, 190, 0.12)');
    halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, width, height);

    // ---- grid + centre line ----------------------------------------------
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(96, 120, 190, 0.10)';
    ctx.beginPath();
    for (let i = 1; i < 16; i++) {
      const x = Math.round((width * i) / 16) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let i = 1; i < 8; i++) {
      const y = Math.round((height * i) / 8) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
    const centreY = Math.round(midY) + 0.5;
    ctx.strokeStyle = 'rgba(110, 140, 230, 0.22)';
    ctx.beginPath();
    ctx.moveTo(0, centreY);
    ctx.lineTo(width, centreY);
    ctx.stroke();

    // ---- palette driven by the raw display level --------------------------
    computeAmps(frame.samples);
    const leftColor = mix(VIOLET, CYAN, 0.08 + energy * 0.22);
    const rightColor = mix(VIOLET, CYAN, 0.78 + energy * 0.18);
    const fillAlpha = 0.26 + energy * 0.34;
    const rimAlpha = Math.min(1, (0.68 + energy * 0.32) * breathe);
    const rimColor = mix(WHITE, VIOLET, 0.32);

    // Display-normalised samples: amplitude 1 is full scale (see visualizer.ts).
    const ampScale = frame.ampScale;
    const xAt = (column: number): number => ((column + 0.5) / COLUMN_COUNT) * width;
    const halfAt = (column: number): number =>
      Math.min(height * 0.49, Math.max(1.5, (amplitudes[column] * ampScale + 0.008) * height));

    const fill = ctx.createLinearGradient(0, 0, width, 0);
    fill.addColorStop(0, rgba(leftColor, fillAlpha));
    fill.addColorStop(1, rgba(rightColor, fillAlpha));

    // ---- glowing symmetric envelope ---------------------------------------
    ctx.save();
    ctx.shadowColor = 'rgba(120, 180, 255, 0.55)';
    ctx.shadowBlur = 18;
    ctx.fillStyle = fill;
    ctx.beginPath();
    for (let column = 0; column < COLUMN_COUNT; column++) {
      const y = midY - halfAt(column);
      if (column === 0) ctx.moveTo(xAt(column), y);
      else ctx.lineTo(xAt(column), y);
    }
    for (let column = COLUMN_COUNT - 1; column >= 0; column--) {
      ctx.lineTo(xAt(column), midY + halfAt(column));
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // ---- crisp top edge, dimmer bottom edge ------------------------------
    const rim = ctx.createLinearGradient(0, 0, width, 0);
    rim.addColorStop(0, rgba(mix(leftColor, rimColor, 0.42), rimAlpha));
    rim.addColorStop(1, rgba(mix(rightColor, rimColor, 0.42), rimAlpha));
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rim;
    ctx.beginPath();
    for (let column = 0; column < COLUMN_COUNT; column++) {
      const y = midY - halfAt(column);
      if (column === 0) ctx.moveTo(xAt(column), y);
      else ctx.lineTo(xAt(column), y);
    }
    ctx.stroke();

    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    for (let column = 0; column < COLUMN_COUNT; column++) {
      const y = midY + halfAt(column);
      if (column === 0) ctx.moveTo(xAt(column), y);
      else ctx.lineTo(xAt(column), y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function destroy(): void {
    destroyed = true;
  }

  return { backend: '2d', resize, render, destroy };
}
