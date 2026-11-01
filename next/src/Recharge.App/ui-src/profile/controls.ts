/** Form controls for the profile editor. Each returns a labelled row that the editor's search can show or hide. */
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { selectControl } from '../components/select.js';
import { switchControl } from '../settings/ui.js';
import { cleanText, hex, textLength, type Choice, type Ext } from './schema.js';

export interface Ctx {
  get(): Ext;
  /** Change the draft. Edits with the same `key` in quick succession become one undo step (sliders, colour pickers, typing). */
  change(fn: (e: Ext) => void, key?: string): void;
  /** Rebuild the controls from the draft (after undo, a preset, a reset). */
  rebuild(): void;
}

export function searchText(...parts: string[]): string {
  return parts.join(' ').toLowerCase();
}

export function row(label: string, hint: string, control: Node, keywords = ''): HTMLElement {
  const node = h('div', { className: 'pe-row', dataset: { search: searchText(label, hint, keywords) } });
  node.appendChild(h('div', { className: 'pe-label', text: label }));
  node.appendChild(control);
  if (hint) node.appendChild(h('div', { className: 'pe-hint', text: hint }));
  return node;
}

export function group(title: string, ...rows: HTMLElement[]): HTMLElement {
  const g = h('div', { className: 'pe-group', dataset: { group: title.toLowerCase() } });
  g.appendChild(h('h3', { className: 'pe-group-title', text: title }));
  for (const r of rows) g.appendChild(r);
  return g;
}

export function colorPicker(value: string, onInput: (hexValue: string) => void, label: string): HTMLInputElement {
  const input = h('input', { className: 'color-input', attrs: { type: 'color', 'aria-label': label } });
  input.value = hex(value) ?? '#41f88d';
  input.addEventListener('input', () => onInput(input.value.toLowerCase()));
  return input;
}

/** One colour. With `optional`, a switch decides between "automatic" (null) and a chosen colour. */
export function colorRow(ctx: Ctx, label: string, hint: string, get: () => string | null, set: (e: Ext, v: string | null) => void, fallback: string, key: string, keywords = ''): HTMLElement {
  const box = h('div', { className: 'pe-inline' });
  const current = get();
  const picker = colorPicker(current ?? fallback, (v) => ctx.change((e) => set(e, v), key), label);
  picker.hidden = current === null;
  const auto = switchControl(label + ' custom', current !== null, (on) => {
    picker.hidden = !on;
    ctx.change((e) => set(e, on ? picker.value.toLowerCase() : null), key + ':on');
    auto.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  box.append(auto, picker, h('span', { className: 'dim', text: current === null ? 'Automatic' : '' }));
  const note = box.lastElementChild as HTMLElement;
  auto.addEventListener('click', () => { note.textContent = picker.hidden ? 'Automatic' : ''; });
  return row(label, hint, box, keywords);
}

export function plainColorRow(ctx: Ctx, label: string, hint: string, get: () => string, set: (e: Ext, v: string) => void, key: string, keywords = ''): HTMLElement {
  return row(label, hint, h('div', { className: 'pe-inline' }, colorPicker(get(), (v) => ctx.change((e) => set(e, v), key), label)), keywords);
}

/** 1 to N colour stops that can be added and removed. */
export function stopsRow(ctx: Ctx, label: string, hint: string, get: () => string[], set: (e: Ext, v: string[]) => void, min: number, max: number, key: string, keywords = ''): HTMLElement {
  const box = h('div', { className: 'pe-inline pe-stops' });
  const paint = (): void => {
    box.replaceChildren();
    const stops = get();
    stops.forEach((stop, i) => {
      const cell = h('span', { className: 'pe-stop' });
      cell.appendChild(colorPicker(stop, (v) => ctx.change((e) => { const next = get().slice(); next[i] = v; set(e, next); }, key + ':' + i), label + ' ' + (i + 1)));
      if (stops.length > min) {
        const remove = h('button', { className: 'pe-x', title: 'Remove this colour', attrs: { type: 'button', 'aria-label': 'Remove colour ' + (i + 1) } }, icon('x', 12));
        remove.addEventListener('click', () => { ctx.change((e) => { const next = get().slice(); next.splice(i, 1); set(e, next); }); ctx.rebuild(); });
        cell.appendChild(remove);
      }
      box.appendChild(cell);
    });
    if (stops.length < max) {
      const add = h('button', { className: 'btn btn-ghost pe-add', attrs: { type: 'button' } }, icon('plus', 14), h('span', { text: 'Add' }));
      add.addEventListener('click', () => {
        ctx.change((e) => { const next = get().slice(); next.push(next[next.length - 1] ?? '#41f88d'); set(e, next); });
        ctx.rebuild();
      });
      box.appendChild(add);
    }
  };
  paint();
  return row(label, hint, box, keywords);
}

export function selectRow(ctx: Ctx, label: string, hint: string, choices: Choice[], get: () => string, set: (e: Ext, v: string) => void, keywords = ''): HTMLElement {
  const wrap = selectControl(choices, { value: get(), onChange: (v) => { ctx.change((e) => set(e, v)); ctx.rebuild(); } });
  return row(label, hint, wrap, keywords + ' ' + choices.map((c) => c.label).join(' '));
}

/** Short lists as buttons; the current one is marked. */
export function segmentedRow(ctx: Ctx, label: string, hint: string, choices: Choice[], get: () => string, set: (e: Ext, v: string) => void, keywords = '', structural = false): HTMLElement {
  const box = h('div', { className: 'pe-seg', attrs: { role: 'radiogroup', 'aria-label': label } });
  const paint = (): void => {
    for (const b of Array.from(box.children) as HTMLElement[]) {
      const on = b.dataset.value === get();
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  };
  for (const c of choices) {
    const b = h('button', { className: 'pe-seg-btn', text: c.label, dataset: { value: c.value }, attrs: { type: 'button', role: 'radio' } });
    b.addEventListener('click', () => { ctx.change((e) => set(e, c.value)); if (structural) ctx.rebuild(); else paint(); });
    box.appendChild(b);
  }
  paint();
  return row(label, hint, box, keywords + ' ' + choices.map((c) => c.label).join(' '));
}

/** Several of a list, as toggle chips. `max` caps how many can be on. */
export function multiRow(ctx: Ctx, label: string, hint: string, choices: Choice[], get: () => string[], set: (e: Ext, v: string[]) => void, keywords = '', max = 99): HTMLElement {
  const box = h('div', { className: 'chips' });
  const paint = (): void => {
    for (const b of Array.from(box.children) as HTMLElement[]) {
      const on = get().includes(b.dataset.value!);
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };
  for (const c of choices) {
    const b = h('button', { className: 'chip', text: c.label, dataset: { value: c.value }, attrs: { type: 'button' } });
    b.addEventListener('click', () => {
      const now = get();
      const next = now.includes(c.value) ? now.filter((x) => x !== c.value) : [...now, c.value];
      if (next.length > max) return;
      ctx.change((e) => set(e, next));
      paint();
    });
    box.appendChild(b);
  }
  paint();
  return row(label, hint, box, keywords + ' ' + choices.map((c) => c.label).join(' '));
}

export function sliderRow(ctx: Ctx, label: string, hint: string, min: number, max: number, step: number, unit: string, get: () => number, set: (e: Ext, v: number) => void, key: string, keywords = ''): HTMLElement {
  const input = h('input', { className: 'pe-range', attrs: { type: 'range', min: String(min), max: String(max), step: String(step), 'aria-label': label } });
  input.value = String(get());
  const readout = h('span', { className: 'pe-readout', text: get() + unit });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    readout.textContent = v + unit;
    ctx.change((e) => set(e, v), key);
  });
  return row(label, hint, h('div', { className: 'pe-inline' }, input, readout), keywords);
}

export function toggleRow(ctx: Ctx, label: string, hint: string, get: () => boolean, set: (e: Ext, v: boolean) => void, keywords = ''): HTMLElement {
  const sw = switchControl(label, get(), (on) => { ctx.change((e) => set(e, on)); sw.setAttribute('aria-checked', on ? 'true' : 'false'); });
  return row(label, hint, h('div', { className: 'pe-inline' }, sw), keywords);
}

export function textRow(ctx: Ctx, label: string, hint: string, get: () => string, set: (e: Ext, v: string) => void, max: number, key: string, options: { multiline?: boolean; placeholder?: string; keywords?: string } = {}): HTMLElement {
  const input = options.multiline
    ? h('textarea', { className: 'input textarea', attrs: { rows: '5', placeholder: options.placeholder ?? '' } })
    : h('input', { className: 'input', attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: options.placeholder ?? '' } });
  input.value = get();
  const count = h('span', { className: 'form-count dim' });
  const update = (): void => {
    const n = textLength(input.value.replace(/\r\n?/g, '\n').trim());
    count.textContent = n + ' / ' + max;
    count.classList.toggle('is-over', n > max);
  };
  input.addEventListener('input', () => {
    update();
    const v = cleanText(input.value, max, !!options.multiline);
    ctx.change((e) => set(e, v), key);
  });
  update();
  return row(label, hint, h('div', { className: 'pe-text' }, input, count), options.keywords ?? '');
}

/**
 * Drag-to-reorder for the children of `list` (each child carries data-i). Also makes the rows keyboard friendly through the
 * up/down buttons the caller adds. `onMove(from, to)` receives indexes before the move.
 */
export function sortable(list: HTMLElement, onMove: (from: number, to: number) => void): void {
  let from = -1;
  list.addEventListener('dragstart', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (!item || item.parentElement !== list) return;
    from = Number(item.dataset.i);
    item.classList.add('is-dragging');
    if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(from)); }
  });
  list.addEventListener('dragover', (event) => {
    if (from < 0) return;
    event.preventDefault();
    const over = (event.target as HTMLElement).closest<HTMLElement>('[data-i]');
    for (const c of Array.from(list.children)) c.classList.toggle('is-over', c === over && Number((c as HTMLElement).dataset.i) !== from);
  });
  list.addEventListener('dragleave', (event) => {
    if (event.target === list) for (const c of Array.from(list.children)) c.classList.remove('is-over');
  });
  list.addEventListener('drop', (event) => {
    event.preventDefault();
    const over = (event.target as HTMLElement).closest<HTMLElement>('[data-i]');
    const to = over ? Number(over.dataset.i) : -1;
    const start = from;
    from = -1;
    for (const c of Array.from(list.children)) c.classList.remove('is-over', 'is-dragging');
    if (start >= 0 && to >= 0 && to !== start) onMove(start, to);
  });
  list.addEventListener('dragend', () => {
    from = -1;
    for (const c of Array.from(list.children)) c.classList.remove('is-over', 'is-dragging');
  });
}

export function iconButton(name: string, title: string, onClick: () => void, disabled = false, extra = ''): HTMLButtonElement {
  const b = h('button', { className: 'pe-ibtn' + (extra ? ' ' + extra : ''), title, attrs: { type: 'button', 'aria-label': title } }, icon(name, 14));
  b.disabled = disabled;
  b.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
  return b;
}
