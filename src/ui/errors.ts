/**
 * The error strip: a tiny append-only log under the stage.
 *
 * Everything that goes wrong in the app funnels here (audio failures, WebGPU
 * diagnostics, window errors wired up in `main.ts`). The panel stays hidden
 * while there is nothing to show and appears on the first message. Each
 * message is also printed to the browser console, so a broken page leaves a
 * trail in DevTools for anyone who cannot see (or does not scroll to) the panel.
 */

/** How many messages the panel keeps; older ones fall off the top. */
const MAX_MESSAGES = 8;

export interface ErrorStrip {
  add(message: string): void;
  list(): string[];
}

export function createErrorStrip(root: ParentNode): ErrorStrip {
  const panelElement = root.querySelector<HTMLElement>('#errors-panel');
  const listElement = root.querySelector<HTMLElement>('#errors');
  const messages: string[] = [];

  function updateVisibility(): void {
    if (panelElement) panelElement.hidden = messages.length === 0;
  }

  function add(message: string): void {
    const text = message.trim();
    if (text.length === 0) return;
    // Repeats are common (e.g. a failing frame each animation frame); only keep
    // consecutive duplicates out so an alternating pair can still be seen.
    if (messages.length > 0 && messages[messages.length - 1] === text) return;

    messages.push(text);
    while (messages.length > MAX_MESSAGES) messages.shift();

    // Mirror the strip in the console: a user reporting "black screen" should
    // have the actual reason available in DevTools.
    console.error(`[wave-gpu] ${text}`);

    if (listElement) {
      const item = document.createElement('li');
      item.textContent = text;
      listElement.append(item);
      while (listElement.children.length > MAX_MESSAGES) {
        listElement.firstElementChild?.remove();
      }
    }
    updateVisibility();
  }

  function list(): string[] {
    return messages.slice();
  }

  updateVisibility();
  return { add, list };
}
