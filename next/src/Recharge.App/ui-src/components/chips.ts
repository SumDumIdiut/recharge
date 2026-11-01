import { h } from '../dom.js';

export interface ChipItem {
  value: string;
  label: string;
  count?: number;
}

export interface ChipOptions {
  value?: string;
  multi?: boolean;
  values?: string[];
  onChange?: (value: string, values: string[]) => void;
}

/** Single-select or multi-select chips. Multi-select keeps a stable value array. */
export function chips(items: ChipItem[], options: ChipOptions = {}): HTMLElement {
  const root = h('div', { className: 'chips', attrs: { role: 'group' } });
  let selected = options.multi
    ? (options.values || (options.value ? [options.value] : [])).slice()
    : [options.value || ''];

  function paint(): void {
    for (const child of Array.from(root.children) as HTMLButtonElement[]) {
      const active = selected.includes(child.dataset.value || '');
      child.classList.toggle('is-on', active);
      child.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  for (const item of items) {
    const chip = h('button', {
      className: 'chip',
      attrs: { type: 'button', 'aria-pressed': 'false' },
      dataset: { value: item.value },
    });
    chip.appendChild(h('span', { text: item.label }));
    if (item.count !== undefined) {
      chip.appendChild(h('span', { className: 'chip-count', text: String(item.count) }));
    }
    chip.addEventListener('click', () => {
      if (options.multi) {
        if (selected.includes(item.value)) selected = selected.filter((value) => value !== item.value);
        else selected = selected.concat(item.value);
      } else {
        selected = [item.value];
      }
      paint();
      if (options.onChange) options.onChange(item.value, selected.slice());
    });
    root.appendChild(chip);
  }
  paint();
  return root;
}
