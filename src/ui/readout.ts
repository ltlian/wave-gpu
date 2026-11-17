/**
 * The live readout panel and the three header badges.
 *
 * `main.ts` assembles a `ReadoutState` snapshot from the engine and visualizer;
 * this module only formats it into the `[data-field]` cells and the
 * `[data-badge]` pills. All writes are idempotent (compared before assigning) so
 * the 10 Hz refresh does not churn the DOM or the aria-live region.
 */

import { TAP_CAPACITY } from '../../shared/audio.ts';
import type { FileInfo, ReadoutState } from '../types.ts';

const NO_VALUE = '—';

export interface Readout {
  update(state: ReadoutState): void;
}

/** AudioContext latencies are in seconds; the panel speaks milliseconds. */
function formatLatency(seconds: number | null): string {
  return seconds === null || !Number.isFinite(seconds) ? NO_VALUE : `${(seconds * 1000).toFixed(2)} ms`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function formatFile(file: FileInfo | null): string {
  if (file === null) return NO_VALUE;
  const duration = formatDuration(file.durationSeconds);
  return duration.length > 0 ? `${file.name} · ${duration}` : file.name;
}

function formatLevel(rms: number, peak: number): string {
  return `${rms.toFixed(4)} / ${peak.toFixed(4)}`;
}

function formatStreamStats(bytes: number, chunks: number): string {
  const kib = bytes > 0 ? Math.round(bytes / 1024) : 0;
  return `${kib} KiB · ${chunks} chunks`;
}

export function createReadout(root: ParentNode): Readout {
  const fields = new Map<string, HTMLElement>();
  for (const element of root.querySelectorAll<HTMLElement>('[data-field]')) {
    const name = element.dataset.field;
    if (name) fields.set(name, element);
  }
  const badges = new Map<string, HTMLElement>();
  for (const element of root.querySelectorAll<HTMLElement>('[data-badge]')) {
    const name = element.dataset.badge;
    if (name) badges.set(name, element);
  }

  function setField(name: string, value: string): void {
    const element = fields.get(name);
    if (!element || element.textContent === value) return;
    element.textContent = value;
    // Long values wrap (see styles.css); the title still carries the full text.
    element.title = value;
  }

  function setBadge(name: string, text: string, tone: 'live' | 'warn' | 'neutral'): void {
    const element = badges.get(name);
    if (!element) return;
    if (element.textContent !== text) element.textContent = text;
    element.classList.toggle('is-live', tone === 'live');
    element.classList.toggle('is-warn', tone === 'warn');
  }

  function update(state: ReadoutState): void {
    const contextIdle = state.contextState === 'none';
    const contextLabel = contextIdle ? 'idle' : state.contextState;

    setField('entry', state.entry ?? NO_VALUE);
    setField('track', state.track.length > 0 ? state.track : NO_VALUE);
    setField('file', formatFile(state.file));
    setField('tap', state.tap);
    setField('context-state', contextIdle ? 'not created' : state.contextState);
    setField('sample-rate', state.sampleRate > 0 ? `${state.sampleRate} Hz` : NO_VALUE);
    setField('base-latency', formatLatency(state.baseLatency));
    setField('output-latency', formatLatency(state.outputLatency));
    setField('coi', state.crossOriginIsolated ? 'true' : 'false');
    setField('sab', state.ring ? `yes · ${TAP_CAPACITY}` : contextIdle ? NO_VALUE : 'no · postMessage');
    setField('worklet-blocks', Number.isFinite(state.workletBlocks) ? String(Math.round(state.workletBlocks)) : NO_VALUE);
    setField('worklet-level', formatLevel(state.workletRms, state.workletPeak));
    setField('analyser-level', formatLevel(state.analyserRms, state.analyserPeak));
    setField('stream-stats', formatStreamStats(state.streamBytes, state.streamChunks));
    setField('gpu', `${state.gpuBackend}${state.gpuReady ? ' · ready' : ' · not ready'}`);
    setField('display-gain', `×${state.displayGain.toFixed(1)}`);
    setField('fps', Number.isFinite(state.fps) ? String(Math.round(state.fps)) : NO_VALUE);

    setBadge(
      'context',
      `context: ${contextLabel}`,
      state.contextState === 'running' ? 'live' : contextIdle ? 'neutral' : 'warn',
    );
    setBadge(
      'gpu',
      `gpu: ${state.gpuBackend}${state.gpuReady ? '' : ' (not ready)'}`,
      state.gpuReady && state.gpuBackend === 'webgpu' ? 'live' : 'warn',
    );
    const ringLabel = state.ring ? 'SAB' : contextIdle ? NO_VALUE : 'postMessage';
    setBadge('ring', `ring: ${ringLabel}`, state.ring ? 'live' : contextIdle ? 'neutral' : 'warn');
  }

  return { update };
}
