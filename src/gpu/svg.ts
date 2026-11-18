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
 * one gradient. It is a placeholder for whichever third rendering method the
 * project settles on; the point is that swapping it in changes only `src/gpu/`.
 */

import type { BackendFrame, CanvasSize, RenderBackend } from './visualizer.ts';

const SAMPLES_PER_COLUMN = 8;
const COLUMN_COUNT = 256;
const SVG_NS = 'http://www.w3.org/2000/svg';
const GRADIENT_STOPS: ReadonlyArray<readonly [string, string]> = [
  ['0', '#7c4dff'],
  ['0.55', '#4f9cf8'],
  ['1', '#22d3ee'],
];

export function createSvgBackend(
  stage: HTMLElement,
  report: (message: string) => void,
): RenderBackend | null {
  let width = 1;
  let height = 1;
  let destroyed = false;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'stage-svg');
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

    // The canvas backends paint a measurement grid; draw the same guides as two
    // static paths so the third backend does not look like a different app.
    const grid = document.createElementNS(SVG_NS, 'path');
    grid.setAttribute('class', 'wave-grid');
    const centre = document.createElementNS(SVG_NS, 'path');
    centre.setAttribute('class', 'wave-centre');

    const fill = document.createElementNS(SVG_NS, 'path');
    fill.setAttribute('class', 'wave-fill');
    const rim = document.createElementNS(SVG_NS, 'path');
    rim.setAttribute('class', 'wave-rim');
    svg.append(grid, centre, fill, rim);

    stage.append(svg);

    const amplitudes = new Float32Array(COLUMN_COUNT);
    const smoothed = new Float32Array(COLUMN_COUNT);

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
        const centre = sum / SAMPLES_PER_COLUMN;
        const left = Math.abs(maximum - centre);
        const right = Math.abs(centre - minimum);
        amplitudes[column] = left > right ? left : right;
      }
      for (let column = 0; column < COLUMN_COUNT; column++) {
        const left = amplitudes[column > 0 ? column - 1 : column];
        const right = amplitudes[column < COLUMN_COUNT - 1 ? column + 1 : column];
        smoothed[column] = (left + amplitudes[column] * 2 + right) * 0.25;
      }
      amplitudes.set(smoothed);
    }

    function resize(size: CanvasSize): void {
      if (destroyed) return;
      width = Math.max(1, size.width);
      height = Math.max(1, size.height);
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

      let verticals = '';
      for (let i = 1; i < 16; i++) {
        const x = (width * i) / 16;
        verticals += `M ${x.toFixed(2)} 0 L ${x.toFixed(2)} ${height.toFixed(2)} `;
      }
      grid.setAttribute('d', verticals.trim());
      centre.setAttribute('d', `M 0 ${(height / 2).toFixed(2)} L ${width.toFixed(2)} ${(height / 2).toFixed(2)}`);
    }

    function render(frame: BackendFrame): void {
      if (destroyed || frame.samples.length < COLUMN_COUNT * SAMPLES_PER_COLUMN) return;
      computeAmps(frame.samples);
      const midY = height / 2;
      const xAt = (column: number): number => ((column + 0.5) / COLUMN_COUNT) * width;
      const halfAt = (column: number): number =>
        Math.min(height * 0.49, Math.max(1.5, (amplitudes[column] * frame.ampScale + 0.008) * height));

      let top = '';
      let bottom = '';
      for (let column = 0; column < COLUMN_COUNT; column++) {
        const x = xAt(column).toFixed(2);
        const y = (midY - halfAt(column)).toFixed(2);
        top += `${column === 0 ? 'M' : 'L'} ${x} ${y} `;
      }
      for (let column = COLUMN_COUNT - 1; column >= 0; column--) {
        bottom += `L ${xAt(column).toFixed(2)} ${(midY + halfAt(column)).toFixed(2)} `;
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
