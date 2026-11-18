/**
 * The shared, cached stage backdrop: dark gradient, soft halo, grid and centre
 * line.
 *
 * It is painted once per resize into its own canvas under the drawing canvas, so
 * Canvas2D and SVG both get the same static stage for free and the frame loop
 * only has to draw the waveform. (WebGPU keeps its own in-shader backdrop: its
 * canvas is opaque and the WGSL already draws these guides, so sharing this
 * layer there is not a free change.)
 */

import { quality } from '../quality.ts';
import type { CanvasSize } from './visualizer.ts';

export interface StageBackdrop {
  resize(size: CanvasSize): void;
  destroy(): void;
}

function paint(context: CanvasRenderingContext2D, width: number, height: number): void {
  const backdrop = context.createLinearGradient(0, 0, 0, height);
  backdrop.addColorStop(0, '#05070d');
  backdrop.addColorStop(0.55, '#0a0e1b');
  backdrop.addColorStop(1, '#04060b');
  context.fillStyle = backdrop;
  context.fillRect(0, 0, width, height);

  const halo = context.createRadialGradient(
    width * 0.5,
    height * 0.5,
    Math.min(width, height) * 0.05,
    width * 0.5,
    height * 0.5,
    Math.max(width, height) * 0.75,
  );
  halo.addColorStop(0, 'rgba(70, 96, 190, 0.12)');
  halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
  context.fillStyle = halo;
  context.fillRect(0, 0, width, height);

  context.lineWidth = 1;
  context.strokeStyle = 'rgba(96, 120, 190, 0.10)';
  context.beginPath();
  for (let i = 1; i < 16; i++) {
    const x = Math.round((width * i) / 16) + 0.5;
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  for (let i = 1; i < 8; i++) {
    const y = Math.round((height * i) / 8) + 0.5;
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  context.stroke();

  const centreY = Math.round(height / 2) + 0.5;
  context.strokeStyle = 'rgba(110, 140, 230, 0.22)';
  context.beginPath();
  context.moveTo(0, centreY);
  context.lineTo(width, centreY);
  context.stroke();
}

export function createStageBackdrop(stage: HTMLElement): StageBackdrop | null {
  const canvas = document.createElement('canvas');
  canvas.className = 'stage-backdrop';
  canvas.setAttribute('aria-hidden', 'true');
  stage.prepend(canvas);

  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext('2d');
  } catch {
    context = null;
  }
  if (!context) {
    canvas.remove();
    return null;
  }
  const ctx = context;
  let destroyed = false;

  function resize(size: CanvasSize): void {
    if (destroyed) return;
    const dpr = Math.max(1, Math.min(size.dpr > 0 ? size.dpr : 1, quality.maxDpr));
    const width = Math.max(1, Math.round(size.width));
    const height = Math.max(1, Math.round(size.height));
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint(ctx, width, height);
  }

  function destroy(): void {
    destroyed = true;
    canvas.remove();
  }

  return { resize, destroy };
}
