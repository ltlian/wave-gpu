/**
 * The stage's frame loop: read the active tap, draw a frame, feed the pipeline
 * accents, refresh the readout.
 *
 * It deliberately runs only while audio is playing, the stage is on screen and
 * the document is visible. When it cannot run it draws a single static idle
 * frame instead, so a paused or off-screen page does no rendering at all.
 */

import { FRAME_SAMPLES } from '../shared/audio.ts';
import { createIdlePreview } from './idle-preview.ts';
import { quality } from './quality.ts';
import type { AudioEngine, Visualizer } from './types.ts';
import type { PipelineAccent } from './ui/pipeline-accent.ts';

export interface RenderLoopOptions {
  engine: AudioEngine;
  visualizer: Visualizer;
  accent: PipelineAccent;
  isPlaying: () => boolean;
  /** Called at ~10 Hz while the loop runs so the readout can refresh. */
  onReadout: () => void;
}

export interface RenderLoop {
  /** Rendered frames per second; 0 until the first sample window closes. */
  readonly fps: number;
  /** Start or stop the loop to match playing / visibility / intersection. */
  sync(): void;
  /** Draw one static idle frame (startup, resize, paused backend switch). */
  drawIdle(): void;
}

export function createRenderLoop(options: RenderLoopOptions): RenderLoop {
  const idlePreview = createIdlePreview(FRAME_SAMPLES);
  const frame = new Float32Array(FRAME_SAMPLES);

  let framesSinceSample = 0;
  let sampledAt = performance.now();
  let readoutAt = 0;
  let loopRunning = false;
  let rafId = 0;
  let lastRenderAt = 0;
  let stageVisible = true;
  let fps = 0;

  document.body.classList.toggle('low-quality', quality.tier === 'low');

  function measure(samples: Float32Array): { rms: number; peak: number } {
    let sumSquares = 0;
    let peak = 0;
    for (const value of samples) {
      sumSquares += value * value;
      const magnitude = value < 0 ? -value : value;
      if (magnitude > peak) peak = magnitude;
    }
    return { rms: Math.sqrt(sumSquares / samples.length), peak };
  }

  function tick(now: number): void {
    rafId = 0;
    if (!loopRunning) return;

    // The low tier renders at 30 fps; the readout still refreshes at 10 Hz.
    // The 0.85 tolerance keeps a 60 Hz display from landing just under two
    // intervals and silently dropping to 20 fps.
    if (now - lastRenderAt < (1000 / quality.maxFps) * 0.85) {
      rafId = requestAnimationFrame(tick);
      return;
    }
    lastRenderAt = now;

    const live = options.engine.readFrame(frame);
    if (!live) idlePreview.write(frame, now);
    const meta = live ? measure(frame) : { rms: 0, peak: 0 };
    options.visualizer.render(frame, meta);
    options.accent.update(meta.rms, meta.peak, now);

    framesSinceSample += 1;
    const elapsed = now - sampledAt;
    if (elapsed >= 500) {
      fps = Math.round((framesSinceSample * 1000) / elapsed);
      framesSinceSample = 0;
      sampledAt = now;
    }
    if (now - readoutAt >= 100) {
      readoutAt = now;
      options.onReadout();
    }
    rafId = requestAnimationFrame(tick);
  }

  function stop(): void {
    loopRunning = false;
    if (rafId !== 0) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    document.body.classList.remove('is-animating');
    options.accent.reset();
  }

  function sync(): void {
    if (!options.isPlaying() || document.hidden || !stageVisible) {
      stop();
      return;
    }
    if (loopRunning) return;
    loopRunning = true;
    document.body.classList.add('is-animating');
    lastRenderAt = 0;
    framesSinceSample = 0;
    sampledAt = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  function drawIdle(): void {
    idlePreview.write(frame, performance.now());
    options.visualizer.render(frame, { rms: 0, peak: 0 });
    options.accent.reset();
  }

  const stage = document.querySelector<HTMLElement>('.stage');
  if (stage !== null && 'IntersectionObserver' in globalThis) {
    new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        stageVisible = entry?.isIntersecting ?? true;
        sync();
      },
      { threshold: 0 },
    ).observe(stage);
  }
  document.addEventListener('visibilitychange', sync);
  globalThis.addEventListener('resize', () => {
    if (options.isPlaying()) return;
    // Double rAF: let the visualizer's ResizeObserver resize the canvas first.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!options.isPlaying()) drawIdle();
      });
    });
  });

  return {
    get fps(): number {
      return fps;
    },
    sync,
    drawIdle,
  };
}
