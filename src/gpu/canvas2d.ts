/**
 * Canvas2D fallback: the same picture as the WebGPU pass, drawn with paths.
 *
 * It buckets the 2048 samples into the requested number of columns (256 on the
 * desktop tier, 128 on the mobile tier), then fills a symmetric violet→cyan
 * envelope with a gradient. The stage backdrop and grid come from the shared
 * cached layer (`stage-backdrop.ts`), so a frame only clears the canvas and
 * draws the envelope; the soft `shadowBlur` glow is skipped on the low tier.
 */

import { FRAME_SAMPLES } from '../../shared/audio.ts';
import type { BackendFrame, CanvasSize, RenderBackend } from './visualizer.ts';

export interface Canvas2dOptions {
  /** Envelope columns; 2048 must divide evenly by this. */
  columns: number;
  /** Whether to spend the frame on the `shadowBlur` glow. */
  glow: boolean;
}

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
  options: Canvas2dOptions = { columns: 256, glow: true },
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
  const columns = Math.max(16, Math.min(FRAME_SAMPLES, Math.round(options.columns)));
  const samplesPerColumn = FRAME_SAMPLES / columns;

  const amplitudes = new Float32Array(columns);
  const smoothed = new Float32Array(columns);
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

  /** 2048 samples → symmetric half-amplitudes per column, plus one smoothing pass. */
  function computeAmps(samples: Float32Array): void {
    for (let column = 0; column < columns; column++) {
      const base = column * samplesPerColumn;
      let minimum = 1;
      let maximum = -1;
      let sum = 0;
      for (let i = 0; i < samplesPerColumn; i++) {
        const value = samples[base + i];
        if (value < minimum) minimum = value;
        if (value > maximum) maximum = value;
        sum += value;
      }
      const center = sum / samplesPerColumn;
      const left = Math.abs(maximum - center);
      const right = Math.abs(center - minimum);
      amplitudes[column] = left > right ? left : right;
    }
    // One neighbour pass keeps column edges from looking like a picket fence.
    for (let column = 0; column < columns; column++) {
      const left = amplitudes[column > 0 ? column - 1 : column];
      const right = amplitudes[column < columns - 1 ? column + 1 : column];
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

    // The backdrop, halo, grid and centre line live in the shared cached canvas
    // underneath; only clear this frame and draw the envelope on top of it.
    ctx.clearRect(0, 0, width, height);

    // ---- palette driven by the raw display level --------------------------
    computeAmps(frame.samples);
    const leftColor = mix(VIOLET, CYAN, 0.08 + energy * 0.22);
    const rightColor = mix(VIOLET, CYAN, 0.78 + energy * 0.18);
    const fillAlpha = 0.26 + energy * 0.34;
    const rimAlpha = Math.min(1, (0.68 + energy * 0.32) * breathe);
    const rimColor = mix(WHITE, VIOLET, 0.32);

    // Normalise this backend's own columns so the drawn envelope lands on the
    // same target height no matter how many samples a column summarises.
    let ampPeak = 0;
    for (let column = 0; column < columns; column++) {
      if (amplitudes[column] > ampPeak) ampPeak = amplitudes[column];
    }
    const ampScale = ampPeak > 1e-5 ? 0.42 / ampPeak : 0;
    const xAt = (column: number): number => ((column + 0.5) / columns) * width;
    const halfAt = (column: number): number =>
      Math.min(height * 0.49, Math.max(1.5, (amplitudes[column] * ampScale + 0.008) * height));

    const fill = ctx.createLinearGradient(0, 0, width, 0);
    fill.addColorStop(0, rgba(leftColor, fillAlpha));
    fill.addColorStop(1, rgba(rightColor, fillAlpha));

    // ---- glowing symmetric envelope ---------------------------------------
    ctx.save();
    if (options.glow) {
      ctx.shadowColor = 'rgba(120, 180, 255, 0.55)';
      ctx.shadowBlur = 18;
    }
    ctx.fillStyle = fill;
    ctx.beginPath();
    for (let column = 0; column < columns; column++) {
      const y = midY - halfAt(column);
      if (column === 0) ctx.moveTo(xAt(column), y);
      else ctx.lineTo(xAt(column), y);
    }
    for (let column = columns - 1; column >= 0; column--) {
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
    for (let column = 0; column < columns; column++) {
      const y = midY - halfAt(column);
      if (column === 0) ctx.moveTo(xAt(column), y);
      else ctx.lineTo(xAt(column), y);
    }
    ctx.stroke();

    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    for (let column = 0; column < columns; column++) {
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
