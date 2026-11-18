/**
 * Publishes a smoothed audio level to the pipeline panel as a CSS custom
 * property (`--level`, 0..1).
 *
 * The CSS uses it only for paint-only accents: the selected chips' LED dot and
 * glow, and the trace glow and pulses. Nothing here touches layout, and there
 * is at most one style write per animation frame, driven from main.ts's existing
 * frame loop — no extra timers, no extra measurements.
 *
 * Attack is quick enough to catch transients; release is slow enough that the
 * panel breathes instead of flickering. Motion-sensitive users get a static
 * panel: with `prefers-reduced-motion: reduce` the property is pinned to 0.
 */

export interface PipelineAccent {
  /** `rms` and `peak` are the raw (un-normalised) frame values from main.ts. */
  update(rms: number, peak: number, now: number): void;
}

/** Asymmetric smoothing time constants (ms). */
const ATTACK_MS = 55;
const RELEASE_MS = 320;

export function createPipelineAccent(root: ParentNode): PipelineAccent {
  const pipeline = root.querySelector<HTMLElement>('#pipeline');
  const motionQuery = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  let reducedMotion = motionQuery?.matches === true;
  let level = 0;
  let lastAt = 0;
  let lastWritten = '0';

  motionQuery?.addEventListener?.('change', (event) => {
    reducedMotion = event.matches;
  });

  function write(value: number): void {
    if (!pipeline) return;
    const text = value.toFixed(3);
    if (text === lastWritten) return;
    lastWritten = text;
    pipeline.style.setProperty('--level', text);
  }

  return {
    update(rms: number, peak: number, now: number): void {
      if (!pipeline) return;
      if (reducedMotion) {
        write(0);
        return;
      }

      // Same weighting the visualizer derives its colour energy from, so the
      // pipeline accents and the drawn frame respond to the same signal.
      const target = Math.min(1, Math.max(0, rms * 3.5 + peak * 1.5));
      const dt = lastAt === 0 ? 16 : Math.min(100, Math.max(1, now - lastAt));
      lastAt = now;

      const tau = target > level ? ATTACK_MS : RELEASE_MS;
      level += (target - level) * (1 - Math.exp(-dt / tau));
      // Snap the tail to zero so a paused page settles exactly at rest.
      if (target === 0 && level < 0.004) level = 0;
      write(level);
    },
  };
}
