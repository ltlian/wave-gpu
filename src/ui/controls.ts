/**
 * DOM-only controls: the transport button and the two toggle groups.
 *
 * These functions never talk to the audio engine — they call the callbacks from
 * `main.ts` and otherwise just reflect the state they are told about (label,
 * `aria-pressed`, disabled while an async transition is in flight). Keeping the
 * DOM writes here means `main.ts` can stay a pure wiring layer.
 */

import { ENTRY_POINT_IDS, TAP_IDS } from '../types.ts';
import type { EntryPointId, TapId } from '../types.ts';

export interface ControlOptions {
  onTogglePlayback: () => void;
  onEntryPoint: (entry: EntryPointId) => void;
  onTap: (tap: TapId) => void;
}

export interface Controls {
  /** Reflect transport state: Start → Pause → Resume. */
  setPlaying(playing: boolean): void;
  setEntryPoint(id: EntryPointId): void;
  setTap(id: TapId): void;
  /** Disable every control while an async transition is in progress. */
  setBusy(busy: boolean): void;
}

function isEntryPointId(value: string | undefined): value is EntryPointId {
  return value !== undefined && (ENTRY_POINT_IDS as readonly string[]).includes(value);
}

function isTapId(value: string | undefined): value is TapId {
  return value !== undefined && (TAP_IDS as readonly string[]).includes(value);
}

export function createControls(root: ParentNode, options: ControlOptions): Controls {
  const startButton = root.querySelector<HTMLButtonElement>('#start');
  const entryButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-entry]'));
  const tapButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-tap]'));
  const allButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('button'));

  let playing = false;
  /** Once playback has started the button reads Resume instead of Start. */
  let started = false;
  let busy = false;
  let entry: EntryPointId = ENTRY_POINT_IDS[0];
  let tap: TapId = TAP_IDS[0];

  function renderStartLabel(): void {
    if (!startButton) return;
    const label = playing ? 'Pause' : started ? 'Resume' : 'Start';
    if (startButton.textContent !== label) startButton.textContent = label;
    const state = playing ? 'playing' : started ? 'paused' : 'idle';
    if (startButton.dataset.state !== state) startButton.dataset.state = state;
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
  }

  startButton?.addEventListener('click', () => {
    if (!busy) options.onTogglePlayback();
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

  renderStartLabel();
  renderPressed();

  return {
    setPlaying(value: boolean): void {
      playing = value;
      if (value) started = true;
      renderStartLabel();
    },
    setEntryPoint(id: EntryPointId): void {
      entry = id;
      renderPressed();
    },
    setTap(id: TapId): void {
      tap = id;
      renderPressed();
    },
    setBusy(value: boolean): void {
      busy = value;
      for (const button of allButtons) {
        if (button.disabled !== value) button.disabled = value;
      }
      if (startButton) startButton.setAttribute('aria-busy', String(value));
    },
  };
}
