/**
 * DOM-only controls: the transport button and the three layer columns.
 *
 * These functions never talk to the audio engine or the visualizer — they call
 * the callbacks from `main.ts` and otherwise just reflect the state they are
 * told about (label, `aria-pressed`, disabled while an async transition is in
 * flight, and a renderer the browser cannot provide grayed out with the reason
 * as its tooltip). Keeping the DOM writes here means `main.ts` can stay a pure
 * wiring layer.
 */

import { ENTRY_POINT_IDS, RENDERER_IDS, TAP_IDS } from '../types.ts';
import type { EntryPointId, RendererId, TapId } from '../types.ts';

export interface ControlOptions {
  onTogglePlayback: () => void;
  onToggleMute: () => void;
  onEntryPoint: (entry: EntryPointId) => void;
  onTap: (tap: TapId) => void;
  onRenderer: (renderer: RendererId) => void;
}

export interface Controls {
  /** Reflect transport state: Play → Pause → Resume. */
  setPlaying(playing: boolean): void;
  /** Reflect the output mute state on the speaker button. */
  setMuted(muted: boolean): void;
  setEntryPoint(id: EntryPointId): void;
  setTap(id: TapId): void;
  setRenderer(id: RendererId): void;
  /**
   * Gray out a renderer this browser cannot provide, with `reason` as its
   * tooltip. Idempotent, so `main.ts` can call it from the 10 Hz readout update.
   */
  setRendererAvailable(id: RendererId, available: boolean, reason?: string | null): void;
  /** Disable every control while an async transition is in progress. */
  setBusy(busy: boolean): void;
}

function isEntryPointId(value: string | undefined): value is EntryPointId {
  return value !== undefined && (ENTRY_POINT_IDS as readonly string[]).includes(value);
}

function isTapId(value: string | undefined): value is TapId {
  return value !== undefined && (TAP_IDS as readonly string[]).includes(value);
}

function isRendererId(value: string | undefined): value is RendererId {
  return value !== undefined && (RENDERER_IDS as readonly string[]).includes(value);
}

export function createControls(root: ParentNode, options: ControlOptions): Controls {
  const startButton = root.querySelector<HTMLButtonElement>('#start');
  const muteButton = root.querySelector<HTMLButtonElement>('#mute');
  const entryButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-entry]'));
  const tapButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-tap]'));
  const rendererButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-renderer]'));
  const allButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('button'));

  let playing = false;
  /** Once playback has started the button reads Resume instead of Play. */
  let started = false;
  let muted = true;
  let busy = false;
  let entry: EntryPointId = ENTRY_POINT_IDS[0];
  let tap: TapId = TAP_IDS[0];
  let renderer: RendererId = RENDERER_IDS[0];
  const rendererAvailable: Record<RendererId, boolean> = { webgpu: true, '2d': true, svg: true };
  const rendererReason: Record<RendererId, string | null> = { webgpu: null, '2d': null, svg: null };

  function renderStartLabel(): void {
    if (!startButton) return;
    const label = playing ? 'Pause' : started ? 'Resume' : 'Play';
    if (startButton.textContent !== label) startButton.textContent = label;
    const state = playing ? 'playing' : started ? 'paused' : 'idle';
    if (startButton.dataset.state !== state) startButton.dataset.state = state;
  }

  function renderMute(): void {
    if (!muteButton) return;
    const pressed = String(muted);
    if (muteButton.getAttribute('aria-pressed') !== pressed) {
      muteButton.setAttribute('aria-pressed', pressed);
    }
    const tooltip = muted ? 'Unmute audio' : 'Mute audio';
    if (muteButton.title !== tooltip) muteButton.title = tooltip;
  }

  function renderPressed(): void {
    for (const button of entryButtons) {
      const pressed = button.dataset.entry === entry;
      if (button.getAttribute('aria-pressed') !== String(pressed)) {
        button.setAttribute('aria-pressed', String(pressed));
      }
    }
    for (const button of tapButtons) {
      const pressed = button.dataset.tap === tap;
      if (button.getAttribute('aria-pressed') !== String(pressed)) {
        button.setAttribute('aria-pressed', String(pressed));
      }
    }
    for (const button of rendererButtons) {
      const pressed = button.dataset.renderer === renderer;
      if (button.getAttribute('aria-pressed') !== String(pressed)) {
        button.setAttribute('aria-pressed', String(pressed));
      }
    }
  }

  function applyDisabled(): void {
    for (const button of allButtons) {
      const id = button.dataset.renderer;
      const unavailable = isRendererId(id) && !rendererAvailable[id];
      const disabled = busy || unavailable;
      if (button.disabled !== disabled) button.disabled = disabled;
    }
  }

  startButton?.addEventListener('click', () => {
    if (!busy) options.onTogglePlayback();
  });

  muteButton?.addEventListener('click', () => {
    if (!busy) options.onToggleMute();
  });

  for (const button of entryButtons) {
    button.addEventListener('click', () => {
      if (busy) return;
      const value = button.dataset.entry;
      if (isEntryPointId(value)) options.onEntryPoint(value);
    });
  }

  for (const button of tapButtons) {
    button.addEventListener('click', () => {
      if (busy) return;
      const value = button.dataset.tap;
      if (isTapId(value)) options.onTap(value);
    });
  }

  for (const button of rendererButtons) {
    button.addEventListener('click', () => {
      if (busy) return;
      const value = button.dataset.renderer;
      // The disabled attribute should make this unreachable; the availability
      // check keeps it true even if a stray click bypasses it.
      if (isRendererId(value) && rendererAvailable[value]) options.onRenderer(value);
    });
  }

  renderStartLabel();
  renderPressed();
  renderMute();

  return {
    setPlaying(value: boolean): void {
      playing = value;
      if (value) started = true;
      renderStartLabel();
    },
    setMuted(value: boolean): void {
      muted = value;
      renderMute();
    },
    setEntryPoint(id: EntryPointId): void {
      entry = id;
      renderPressed();
    },
    setTap(id: TapId): void {
      tap = id;
      renderPressed();
    },
    setRenderer(id: RendererId): void {
      renderer = id;
      renderPressed();
    },
    setRendererAvailable(id: RendererId, available: boolean, reason: string | null = null): void {
      const text = reason ?? null;
      if (rendererAvailable[id] === available && rendererReason[id] === text) return;
      rendererAvailable[id] = available;
      rendererReason[id] = text;
      for (const button of rendererButtons) {
        if (button.dataset.renderer !== id) continue;
        button.title = available ? '' : (text ?? 'Not available in this browser');
      }
      applyDisabled();
    },
    setBusy(value: boolean): void {
      busy = value;
      applyDisabled();
      if (startButton) startButton.setAttribute('aria-busy', String(value));
    },
  };
}
