/**
 * Drop zone + file picker for the `file` entry point.
 *
 * The page never parses the file: it only hands a `File` to the engine, which
 * wraps it in a blob URL. This module is responsible for the two ways a local
 * file can arrive (drag-and-drop, and the picker button / hidden input) and for
 * the visual drag-over state.
 */

export interface FileDropOptions {
  onFile: (file: File) => void;
  onError: (message: string) => void;
}

export interface FileDrop {
  /** Open the OS file picker (used by the "file" entry button when nothing is loaded). */
  openPicker(): void;
}

function hasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return types !== undefined && Array.from(types).includes('Files');
}

export function createFileDrop(doc: Document, options: FileDropOptions): FileDrop {
  const input = doc.querySelector<HTMLInputElement>('#file-input');
  const button = doc.querySelector<HTMLButtonElement>('#load-file');
  const stage = doc.querySelector<HTMLElement>('.stage');

  let dragDepth = 0;

  function setDragging(dragging: boolean): void {
    stage?.classList.toggle('is-dragover', dragging);
  }

  function openPicker(): void {
    if (!input) return;
    input.value = ''; // allow picking the same file again
    input.click();
  }

  button?.addEventListener('click', openPicker);

  input?.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) options.onFile(file);
    input.value = '';
  });

  // Listen on the whole document so dropping anywhere on the page works, not
  // just precisely on the canvas.
  doc.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    setDragging(true);
  });

  doc.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  });

  doc.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragging(false);
  });

  doc.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    // Stop the browser from navigating away to the dropped file.
    event.preventDefault();
    dragDepth = 0;
    setDragging(false);

    const file = event.dataTransfer?.files?.[0];
    if (!file) {
      options.onError('that drop did not contain a file');
      return;
    }
    options.onFile(file);
  });

  return { openPicker };
}
