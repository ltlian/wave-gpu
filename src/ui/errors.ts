/**
 * The error strip: a tiny append-only log under the stage.
 *
 * Everything that goes wrong in the app funnels here (audio failures, WebGPU
 * diagnostics, window errors wired up in `main.ts`). It is deliberately simple:
 * newest at the bottom, no throwing when the list is missing, and the marker
 * `<li class="errors-empty">none</li>` is dropped as soon as something arrives.
 */

/** How many messages the panel keeps; older ones fall off the top. */
const MAX_MESSAGES = 8;

export interface ErrorStrip {
  add(message: string): void;
  list(): string[];
}

export function createErrorStrip(root: ParentNode): ErrorStrip {
  const listElement = root.querySelector<HTMLElement>('#errors');
  const messages: string[] = [];

  function add(message: string): void {
    const text = message.trim();
    if (text.length === 0) return;
    // Repeats are common (e.g. a failing frame each animation frame); only keep
    // consecutive duplicates out so an alternating pair can still be seen.
    if (messages.length > 0 && messages[messages.length - 1] === text) return;

    messages.push(text);
    while (messages.length > MAX_MESSAGES) messages.shift();

    if (!listElement) return;
    listElement.querySelector('.errors-empty')?.remove();
    const item = document.createElement('li');
    item.textContent = text;
    listElement.append(item);
    while (listElement.children.length > MAX_MESSAGES) {
      listElement.firstElementChild?.remove();
    }
  }

  function list(): string[] {
    return messages.slice();
  }

  return { add, list };
}
