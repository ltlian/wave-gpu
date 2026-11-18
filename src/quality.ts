/**
 * One place to decide how much work the demo does.
 *
 * Phones are the target of the low tier: half the frames, a 1x backing store,
 * fewer canvas columns, no blur. `?quality=low|high` overrides the detection so
 * the tradeoff can be compared on the same device.
 */

export type QualityTier = 'high' | 'low';

export interface QualityProfile {
  tier: QualityTier;
  /** Backing-store cap for the canvas backends and the cached stage backdrop. */
  maxDpr: number;
  /** Render-loop cap, frames per second. */
  maxFps: number;
  /** How often the pipeline accent CSS variable is written. */
  accentHz: number;
  /** Canvas2D envelope columns (2048 samples split this many ways). */
  canvasColumns: number;
  /** Whether Canvas2D uses its expensive `shadowBlur` glow. */
  canvasGlow: boolean;
  /** SVG envelope columns — far fewer, because every frame rebuilds path data. */
  svgColumns: number;
  /** Whether the SVG renderer keeps its drop-shadow filter. */
  svgGlow: boolean;
}

function detectTier(): QualityTier {
  const override = new URLSearchParams(globalThis.location?.search ?? '').get('quality');
  if (override === 'low' || override === 'high') return override;
  const coarse = globalThis.matchMedia?.('(pointer: coarse)').matches === true;
  const cores = globalThis.navigator?.hardwareConcurrency ?? 8;
  return coarse || cores <= 4 ? 'low' : 'high';
}

function createProfile(): QualityProfile {
  if (detectTier() === 'low') {
    return {
      tier: 'low',
      maxDpr: 1,
      maxFps: 30,
      accentHz: 30,
      canvasColumns: 128,
      canvasGlow: false,
      svgColumns: 32,
      svgGlow: false,
    };
  }
  return {
    tier: 'high',
    maxDpr: 2,
    maxFps: 60,
    accentHz: 60,
    canvasColumns: 256,
    canvasGlow: true,
    svgColumns: 64,
    svgGlow: true,
  };
}

export const quality: QualityProfile = createProfile();
