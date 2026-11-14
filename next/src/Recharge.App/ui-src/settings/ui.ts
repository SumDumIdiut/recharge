import { h } from '../dom.js';

export function row(label: string, hint: string, control: Node): HTMLElement {
  const node = h('div', { className: 'setting-row' });
  const copy = h('div', { className: 'setting-copy' });
  copy.appendChild(h('div', { className: 'setting-label', text: label }));
  if (hint) copy.appendChild(h('div', { className: 'setting-hint', text: hint }));
  node.appendChild(copy);
  node.appendChild(h('div', { className: 'setting-control' }, control));
  return node;
}

export function panel(title: string, ...rows: Node[]): HTMLElement {
  const node = h('section', { className: 'panel settings-panel' });
  node.appendChild(h('h2', { className: 'panel-title', text: title }));
  for (const child of rows) node.appendChild(child);
  return node;
}

export function wrap(...children: Node[]): HTMLElement {
  return h('div', { className: 'settings-row-wrap' }, ...children);
}

export function switchControl(label: string, on: boolean, onToggle: (next: boolean) => void): HTMLButtonElement {
  const toggle = h('button', { className: 'switch', attrs: { type: 'button', role: 'switch', 'aria-label': label, 'aria-checked': on ? 'true' : 'false' } });
  toggle.appendChild(h('span', { className: 'switch-knob' }));
  toggle.addEventListener('click', () => onToggle(toggle.getAttribute('aria-checked') !== 'true'));
  return toggle;
}

export function setSwitch(toggle: HTMLElement, on: boolean): void {
  toggle.setAttribute('aria-checked', on ? 'true' : 'false');
}

/** A 0..1 slider shown as a percentage; calls onInput with the 0..1 value as it moves. */
export function sliderControl(value: number, onInput: (next: number) => void): HTMLElement {
  const box = h('div', { className: 'settings-slider' });
  const input = h('input', { className: 'settings-range', attrs: { type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'Opacity' } }) as HTMLInputElement;
  const readout = h('span', { className: 'settings-slider-value' });
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  input.value = String(pct);
  readout.textContent = pct + '%';
  input.addEventListener('input', () => {
    const p = Number(input.value);
    readout.textContent = p + '%';
    onInput(p / 100);
  });
  box.append(input, readout);
  return box;
}

export interface Section {
  node: HTMLElement;
  dispose?: () => void;
}
