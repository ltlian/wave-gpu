/**
 * SVG renderer: the same frame as WebGPU/Canvas2D, painted as retained-mode DOM
 * instead of into a canvas.
 *
 * This is the third consumer in the demo: it proves the drawing layer is
 * decoupled from where the samples came from. Nothing here knows about entry
 * points or taps — `visualizer.ts` hands it a display-normalised 2048-sample
 * frame and a target size, exactly like the other two backends. The visualizer
 * hides the stage canvas while this backend owns an `<svg>` sibling.
 *
 * Deliberately simple for a first pass: one filled envelope path, one rim path,
 * one gradient on the shared cached backdrop. It is a placeholder for whichever
 * third rendering method the project settles on; the point is that swapping it
 * in changes only `src/gpu/`. The column count is much lower than Canvas2D's
 * because every frame rebuilds the path data.
 */

import { FRAME_SAMPLES } from '../../shared/audio.ts';
import { createColumnEnvelope } from './envelope.ts';
import type { BackendFrame, CanvasSize, RenderBackend } from './visualizer.ts';

export interface SvgOptions {
  /** Envelope columns; 2048 must divide evenly by this. */
  columns: number;
  /** Whether to keep the drop-shadow glow on the envelope. */
  glow: boolean;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const GRADIENT_STOPS: ReadonlyArray<readonly [string, string]> = [
  ['0', '#7c4dff'],
  ['0.55', '#4f9cf8'],
  ['1', '#22d3ee'],
];

export function createSvgBackend(
  stage: HTMLElement,
  report: (message: string) => void,
  options: SvgOptions = { columns: 64, glow: true },
): RenderBackend | null {
  let width = 1;
  let height = 1;
  let destroyed = false;
  const envelope = createColumnEnvelope(Math.max(8, Math.min(FRAME_SAMPLES, Math.round(options.columns))));
  const columns = envelope.columns;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `stage-svg${options.glow ? '' : ' no-glow'}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('preserveAspectRatio', 'none');

  try {
    const defs = document.createElementNS(SVG_NS, 'defs');
    const gradient = document.createElementNS(SVG_NS, 'linearGradient');
    gradient.setAttribute('id', 'wave-gradient');
    gradient.setAttribute('x1', '0');
    gradient.setAttribute('y1', '0');
    gradient.setAttribute('x2', '1');
    gradient.setAttribute('y2', '0');
    for (const [offset, color] of GRADIENT_STOPS) {
      const stop = document.createElementNS(SVG_NS, 'stop');
      stop.setAttribute('offset', offset);
      stop.setAttribute('stop-color', color);
      gradient.append(stop);
    }
    defs.append(gradient);
    svg.append(defs);

    const fill = document.createElementNS(SVG_NS, 'path');
    fill.setAttribute('class', 'wave-fill');
    const rim = document.createElementNS(SVG_NS, 'path');
    rim.setAttribute('class', 'wave-rim');
    svg.append(fill, rim);

    stage.append(svg);

    function resize(size: CanvasSize): void {
      if (destroyed) return;
      width = Math.max(1, size.width);
      height = Math.max(1, size.height);
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }

    function render(frame: BackendFrame): void {
      if (destroyed || frame.samples.length < FRAME_SAMPLES) return;
      envelope.compute(frame.samples);
      const midY = height / 2;
      const xAt = (column: number): number => ((column + 0.5) / columns) * width;
      const { ampScale } = envelope;
      const halfAt = (column: number): number =>
        Math.min(height * 0.49, Math.max(1.5, (envelope.amplitudes[column] * ampScale + 0.008) * height));

      let top = '';
      let bottom = '';
      for (let column = 0; column < columns; column++) {
        const x = xAt(column).toFixed(1);
        const y = (midY - halfAt(column)).toFixed(1);
        top += `${column === 0 ? 'M' : 'L'} ${x} ${y} `;
      }
      for (let column = columns - 1; column >= 0; column--) {
        bottom += `L ${xAt(column).toFixed(1)} ${(midY + halfAt(column)).toFixed(1)} `;
      }
      fill.setAttribute('d', `${top}${bottom}Z`);
      rim.setAttribute('d', top.trim());
    }

    function destroy(): void {
      destroyed = true;
      svg.remove();
    }

    return { backend: 'svg', resize, render, destroy };
  } catch (error) {
    svg.remove();
    const message = error instanceof Error ? error.message : String(error);
    report(`SVG renderer could not be created: ${message}`);
    return null;
  }
}
