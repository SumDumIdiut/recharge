import { h } from '../dom.js';
import { icon } from '../icons.js';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectOptions {
  label?: string;
  value?: string;
  onChange?: (value: string) => void;
}

/** A labelled native select, styled to match the theme. */
export function selectControl(options: SelectOption[], settings: SelectOptions = {}): HTMLElement {
  const wrap = h('label', { className: 'select-wrap' });
  if (settings.label) wrap.appendChild(h('span', { className: 'select-label', text: settings.label }));
  const select = h('select', { className: 'select' });
  for (const option of options) {
    const node = h('option', { text: option.label, attrs: { value: option.value } });
    if (option.value === settings.value) node.selected = true;
    select.appendChild(node);
  }
  if (settings.onChange) {
    select.addEventListener('change', () => settings.onChange?.(select.value));
  }
  wrap.appendChild(select);
  wrap.appendChild(icon('chevron-down', 16));
  return wrap;
}
