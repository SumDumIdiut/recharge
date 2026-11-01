/** Small form pieces shared by the forum and profile editors. */
import { h } from '../dom.js';
import { button } from '../components/button.js';
import { validateImages } from './format.js';

export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = h('label', { className: 'form-field' });
  wrap.appendChild(h('span', { className: 'form-label', text: label }));
  wrap.appendChild(control);
  if (hint) wrap.appendChild(h('span', { className: 'form-hint dim', text: hint }));
  return wrap;
}

export function textInput(value = '', placeholder = '', max?: number): HTMLInputElement {
  const input = h('input', { className: 'input', attrs: { type: 'text', placeholder, autocomplete: 'off', spellcheck: 'false' } });
  if (max) input.maxLength = max * 2; // the counter is the real limit; this only stops runaway pastes
  input.value = value;
  return input;
}

export function textArea(value = '', placeholder = '', rows = 5): HTMLTextAreaElement {
  const area = h('textarea', { className: 'input textarea', attrs: { placeholder, rows: String(rows) } });
  area.value = value;
  return area;
}

/** A "123 / 5000" counter that turns red past the limit. */
export function counter(source: HTMLInputElement | HTMLTextAreaElement, max: number): HTMLElement {
  const node = h('span', { className: 'form-count dim' });
  const update = () => {
    const length = source.value.replace(/\r\n?/g, '\n').trim().length;
    node.textContent = length + ' / ' + max;
    node.classList.toggle('is-over', length > max);
  };
  source.addEventListener('input', update);
  update();
  return node;
}

export function formError(): { element: HTMLElement; show(message: string | null): void } {
  const element = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
  return {
    element,
    show(message) {
      element.hidden = !message;
      element.textContent = message || '';
    },
  };
}

export interface ImagePicker {
  element: HTMLElement;
  files(): File[];
  /** Existing pictures the person chose to drop. */
  removed(): string[];
  error(): string | null;
  clear(): void;
}

/** Choose up to `max` pictures with thumbnails, counting `existing` ones already on the post. */
export function imagePicker(max: number, existing: Array<{ path: string; url: Promise<string | null> }> = []): ImagePicker {
  const root = h('div', { className: 'picker' });
  const row = h('div', { className: 'picker-row' });
  const input = h('input', { attrs: { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: 'multiple' } });
  input.hidden = true;
  let picked: File[] = [];
  const dropped = new Set<string>();
  const urls = new Map<File, string>();

  function kept(): number { return existing.filter((e) => !dropped.has(e.path)).length; }
  function room(): number { return Math.max(0, max - kept() - picked.length); }

  const add = button('Add pictures', { kind: 'secondary', icon: 'image', onClick: () => input.click() });
  const note = h('span', { className: 'dim' });

  function paint(): void {
    row.replaceChildren();
    for (const entry of existing) {
      if (dropped.has(entry.path)) continue;
      const tile = h('span', { className: 'picker-tile' });
      const image = h('img', { attrs: { alt: '', decoding: 'async' } });
      void entry.url.then((url) => { if (url) image.src = url; });
      tile.appendChild(image);
      tile.appendChild(h('button', { className: 'picker-x', title: 'Remove this picture', attrs: { type: 'button', 'aria-label': 'Remove picture' }, text: 'x', on: { click: () => { dropped.add(entry.path); paint(); } } }));
      row.appendChild(tile);
    }
    for (const file of picked) {
      let url = urls.get(file);
      if (!url) { url = URL.createObjectURL(file); urls.set(file, url); }
      const tile = h('span', { className: 'picker-tile' });
      tile.appendChild(h('img', { attrs: { src: url, alt: '', decoding: 'async' } }));
      tile.appendChild(h('button', { className: 'picker-x', title: 'Remove this picture', attrs: { type: 'button', 'aria-label': 'Remove picture' }, text: 'x', on: { click: () => { picked = picked.filter((f) => f !== file); paint(); } } }));
      row.appendChild(tile);
    }
    add.disabled = room() === 0;
    note.textContent = max + ' pictures at most, 5 MB each (' + room() + ' left)';
  }

  input.addEventListener('change', () => {
    const chosen = Array.from(input.files || []);
    input.value = '';
    picked = picked.concat(chosen).slice(0, Math.max(0, max - kept()));
    paint();
  });

  const bar = h('div', { className: 'picker-bar' });
  bar.appendChild(add);
  bar.appendChild(note);
  root.appendChild(bar);
  root.appendChild(input);
  root.appendChild(row);
  paint();

  return {
    element: root,
    files: () => picked.slice(),
    removed: () => Array.from(dropped),
    error: () => validateImages(picked, max),
    clear() {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      picked = [];
      dropped.clear();
      paint();
    },
  };
}
