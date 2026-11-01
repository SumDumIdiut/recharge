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

export interface Section {
  node: HTMLElement;
  dispose?: () => void;
}
