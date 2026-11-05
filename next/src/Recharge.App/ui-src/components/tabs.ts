import { h } from '../dom.js';
import { icon } from '../icons.js';

export interface TabItem {
  value: string;
  label: string;
  icon?: string;
  /** A small count after the label. */
  count?: number;
}

export interface TabOptions {
  value?: string;
  onChange?: (value: string) => void;
}

/** A horizontal tab row. Tabs do not own routing; callers decide what onChange does. */
export function tabs(items: TabItem[], options: TabOptions = {}): HTMLElement {
  const root = h('div', { className: 'tabs', attrs: { role: 'tablist' } });
  let value = options.value || (items[0] ? items[0].value : '');

  function paint(): void {
    for (const child of Array.from(root.children) as HTMLButtonElement[]) {
      const active = child.dataset.value === value;
      child.classList.toggle('is-on', active);
      child.setAttribute('aria-selected', active ? 'true' : 'false');
      child.tabIndex = active ? 0 : -1;
    }
  }

  for (const item of items) {
    const tab = h('button', {
      className: 'tab',
      attrs: { type: 'button', role: 'tab', 'aria-selected': 'false' },
      dataset: { value: item.value },
    });
    if (item.icon) tab.appendChild(icon(item.icon, 18));
    tab.appendChild(h('span', { text: item.label }));
    if (item.count !== undefined) tab.appendChild(h('span', { className: 'tab-count', text: String(item.count) }));
    tab.addEventListener('click', () => {
      if (value === item.value) return;
      value = item.value;
      paint();
      if (options.onChange) options.onChange(item.value);
    });
    tab.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const index = items.findIndex((entry) => entry.value === value);
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next = items[(index + step + items.length) % items.length];
      if (!next) return;
      value = next.value;
      paint();
      const target = root.querySelector('[data-value="' + next.value + '"]') as HTMLElement | null;
      if (target) target.focus();
      if (options.onChange) options.onChange(next.value);
    });
    root.appendChild(tab);
  }
  paint();
  return root;
}
