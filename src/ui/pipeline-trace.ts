/**
 * The trace that joins the selected option in each layer.
 *
 * DOM-only and stateless: this module measures the three selected chips, then
 * writes one orthogonal SVG path through the gaps between the columns. It reads
 * the selection back from the buttons' `aria-pressed` state, which `ui/controls.ts`
 * owns, so no selection state is duplicated here. `main.ts` calls `update()` from
 * its (10 Hz) readout refresh; the call is cheap and no-ops when neither the
 * selection nor the layout changed. A `ResizeObserver` catches the rest: window
 * resizes, scrollbar changes, and the font swap on first paint.
 */

const LAYERS = ['entry', 'tap', 'renderer'] as const;
type LayerId = (typeof LAYERS)[number];

/** data attribute carrying each layer's option id, as written in index.html. */
const OPTION_ATTR: Record<LayerId, string> = {
  entry: 'data-entry',
  tap: 'data-tap',
  renderer: 'data-renderer',
};

interface Point {
  x: number;
  y: number;
}

export interface PipelineTrace {
  /** Recompute the path if the selection or the layout changed. */
  update(): void;
}

const NO_UPDATE: PipelineTrace = { update() {} };

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Centre of one edge of `element`, in `frame`'s content-box coordinates. */
function anchor(element: Element, side: 'left' | 'right', frame: Element): Point {
  const rect = element.getBoundingClientRect();
  const container = frame.getBoundingClientRect();
  return {
    x: round(side === 'left' ? rect.left - container.left : rect.right - container.left),
    y: round(rect.top - container.top + rect.height / 2),
  };
}

/** One horizontal run, one vertical jog in the middle, one horizontal run. */
function elbow(from: Point, to: Point): Point[] {
  const midX = (from.x + to.x) / 2;
  return [from, { x: midX, y: from.y }, { x: midX, y: to.y }, to];
}

/** Rounded polyline through axis-aligned points (M/L/Q), for H+V routing. */
function roundedPath(points: Point[], radius = 9): string {
  if (points.length < 2) return '';
  const parts = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 1; i < points.length - 1; i += 1) {
    const point = points[i];
    const before = points[i - 1];
    const after = points[i + 1];
    const inLength = Math.hypot(before.x - point.x, before.y - point.y);
    const outLength = Math.hypot(after.x - point.x, after.y - point.y);
    if (inLength === 0 || outLength === 0) continue;
    const r = Math.min(radius, inLength / 2, outLength / 2);
    const start = {
      x: point.x + ((before.x - point.x) / inLength) * r,
      y: point.y + ((before.y - point.y) / inLength) * r,
    };
    const end = {
      x: point.x + ((after.x - point.x) / outLength) * r,
      y: point.y + ((after.y - point.y) / outLength) * r,
    };
    parts.push(`L ${round(start.x)} ${round(start.y)}`, `Q ${point.x} ${point.y} ${round(end.x)} ${round(end.y)}`);
  }
  const last = points[points.length - 1];
  parts.push(`L ${last.x} ${last.y}`);
  return parts.join(' ');
}

export function createPipelineTrace(root: ParentNode): PipelineTrace {
  const busElement = root.querySelector<HTMLElement>('#bus');
  const svgElement = root.querySelector<SVGSVGElement>('#route');
  const glowElement = root.querySelector<SVGPathElement>('#route-glow');
  const lineElement = root.querySelector<SVGPathElement>('#route-line');
  const pulseElement = root.querySelector<SVGPathElement>('#route-pulse');
  const pulseTwoElement = root.querySelector<SVGPathElement>('#route-pulse-2');
  const nodeLayerElement = root.querySelector<SVGGElement>('#route-nodes');
  const gradientElement = root.querySelector<SVGLinearGradientElement>('#flow');
  const stage = root.querySelector<HTMLElement>('.stage');
  if (
    !busElement ||
    !svgElement ||
    !glowElement ||
    !lineElement ||
    !pulseElement ||
    !pulseTwoElement ||
    !nodeLayerElement ||
    !gradientElement
  ) {
    return NO_UPDATE;
  }

  // Aliased after the null check so the nested callbacks see non-null types.
  const bus = busElement;
  const svg = svgElement;
  const glow = glowElement;
  const line = lineElement;
  const pulse = pulseElement;
  const pulseTwo = pulseTwoElement;
  const nodeLayer = nodeLayerElement;
  const gradient = gradientElement;

  let lastSignature = '';
  let scheduled = 0;

  function selected(layer: LayerId): HTMLElement | null {
    return bus.querySelector<HTMLElement>(
      `[data-layer="${layer}"] [${OPTION_ATTR[layer]}][aria-pressed="true"]`,
    );
  }

  function render(): void {
    // Below the layout breakpoint the trace is hidden and the columns stack;
    // skip the geometry work entirely.
    if (svg.getBoundingClientRect().width === 0) return;

    const entryChip = selected('entry');
    const tapChip = selected('tap');
    const rendererChip = selected('renderer');
    if (!entryChip || !tapChip || !rendererChip) return;

    const width = bus.clientWidth;
    const height = bus.clientHeight;
    if (width < 1 || height < 1) return;

    // Measure before deciding whether to redraw: a chip width change (CSS, font
    // swap) moves the anchors without changing the panel's own size.
    const entryOut = anchor(entryChip, 'right', bus);
    const tapIn = anchor(tapChip, 'left', bus);
    const tapOut = anchor(tapChip, 'right', bus);
    const rendererIn = anchor(rendererChip, 'left', bus);
    const rendererOut = anchor(rendererChip, 'right', bus);

    // The rail leaves the renderer column, turns up in the panel's right gutter
    // and ends on the stage's bottom border, so the trace reads as feeding the
    // frame itself. The distance is viewport-dependent: measure it every time.
    const riserX = width - 6;
    const stageBottom =
      stage === null ? null : round(stage.getBoundingClientRect().bottom - bus.getBoundingClientRect().top);

    const signature = [
      entryChip.dataset.entry,
      tapChip.dataset.tap,
      rendererChip.dataset.renderer,
      `${width}x${height}`,
      `${entryOut.x},${entryOut.y}`,
      `${tapIn.x},${tapIn.y}`,
      `${tapOut.x},${tapOut.y}`,
      `${rendererIn.x},${rendererIn.y}`,
      `${riserX},${stageBottom ?? 'none'}`,
    ].join('|');
    if (signature === lastSignature) return;
    lastSignature = signature;

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    gradient.setAttribute('x1', '0');
    gradient.setAttribute('x2', String(width));
    gradient.setAttribute('y1', '0');
    gradient.setAttribute('y2', '0');

    const tail =
      stageBottom === null
        ? roundedPath([rendererOut, { x: riserX, y: rendererOut.y }])
        : roundedPath(
            [rendererOut, { x: riserX, y: rendererOut.y }, { x: riserX, y: stageBottom + 1 }],
            9,
          );

    const path = [
      roundedPath(elbow(entryOut, tapIn)),
      roundedPath(elbow(tapOut, rendererIn)),
      tail,
    ].join(' ');

    for (const element of [glow, line, pulse, pulseTwo]) element.setAttribute('d', path);

    // The last dot is the plug on the stage's frame, where the rail lands.
    const stops = [entryOut, tapIn, tapOut, rendererIn];
    if (stageBottom !== null) stops.push({ x: riserX, y: stageBottom + 1 });

    nodeLayer.replaceChildren();
    for (const point of stops) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', String(point.x));
      dot.setAttribute('cy', String(point.y));
      dot.setAttribute('r', '3.4');
      dot.setAttribute('class', 'route-node');
      nodeLayer.append(dot);
    }
  }

  /** Coalesce bursts of update() calls into one measurement per frame. */
  function update(): void {
    if (scheduled !== 0) return;
    scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      render();
    });
  }

  new ResizeObserver(update).observe(bus);
  if (stage !== null) new ResizeObserver(update).observe(stage);
  globalThis.addEventListener('resize', update);
  document.fonts?.ready.then(update).catch(() => {});

  return { update };
}
