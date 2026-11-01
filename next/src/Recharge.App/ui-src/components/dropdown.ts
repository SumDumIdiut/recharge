import { h } from '../dom.js';
import { icon } from '../icons.js';

/**
 * Themed dropdowns. WebKitGTK draws a native <select>'s list as a GTK popup that no CSS reaches, so every select on the page is
 * shown through a themed trigger and menu instead. The native select stays in the DOM, hidden, and remains the source of truth:
 * code keeps reading .value and listening for 'change', and setting .value or .selectedIndex updates the trigger.
 */

const ENHANCED = new WeakSet<HTMLSelectElement>();
const proto = HTMLSelectElement.prototype;
const valueProp = Object.getOwnPropertyDescriptor(proto, 'value')!;
const indexProp = Object.getOwnPropertyDescriptor(proto, 'selectedIndex')!;

let open: { close(): void } | null = null;

export function enhanceSelect(select: HTMLSelectElement): void {
  if (ENHANCED.has(select) || select.multiple || select.dataset.native === '1') return;
  ENHANCED.add(select);

  const trigger = h('button', { className: (select.className ? select.className + ' ' : '') + 'dd-trigger', attrs: { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' } });
  const label = h('span', { className: 'dd-label' });
  trigger.append(label, icon('chevron-down', 16));
  const aria = select.getAttribute('aria-label');
  if (aria) trigger.setAttribute('aria-label', aria);
  if (select.title) trigger.title = select.title;
  select.classList.add('dd-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.after(trigger);

  const refresh = (): void => {
    const option = select.options[indexProp.get!.call(select) as number];
    label.textContent = option ? option.text : '';
    trigger.disabled = select.disabled;
  };
  // Programmatic changes don't fire events, so the instance's value and selectedIndex update the trigger too.
  Object.defineProperty(select, 'value', { configurable: true, get() { return valueProp.get!.call(this); }, set(v: string) { valueProp.set!.call(this, v); refresh(); } });
  Object.defineProperty(select, 'selectedIndex', { configurable: true, get() { return indexProp.get!.call(this); }, set(v: number) { indexProp.set!.call(this, v); refresh(); } });
  select.addEventListener('change', refresh);
  new MutationObserver(refresh).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label'] });
  refresh();

  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    if (open) { const was = trigger.getAttribute('aria-expanded') === 'true'; open.close(); if (was) return; }
    openMenu(select, trigger, refresh);
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) openMenu(select, trigger, refresh);
    }
  });
}

function openMenu(select: HTMLSelectElement, trigger: HTMLElement, refresh: () => void): void {
  const options = Array.from(select.options);
  if (options.length === 0 || select.disabled) return;
  const menu = h('div', { className: 'dd-menu', attrs: { role: 'listbox', tabindex: '-1' } });
  let active = Math.max(0, indexProp.get!.call(select) as number);
  const rows = options.map((option, i) => {
    const row = h('div', { className: 'dd-option', attrs: { role: 'option', 'aria-selected': String(option.selected) } });
    row.append(h('span', { className: 'dd-text', text: option.text }));
    if (option.selected) row.append(icon('check', 14));
    if (option.disabled) row.classList.add('is-disabled');
    row.addEventListener('mousemove', () => setActive(i));
    row.addEventListener('mousedown', (event) => event.preventDefault());
    row.addEventListener('click', () => pick(i));
    menu.append(row);
    return row;
  });

  function setActive(i: number): void {
    rows[active]?.classList.remove('is-active');
    active = i;
    rows[active]?.classList.add('is-active');
  }
  function scrollToActive(): void { rows[active]?.scrollIntoView({ block: 'nearest' }); }
  function move(step: number): void {
    let i = active;
    for (let n = 0; n < rows.length; n++) {
      i = Math.min(rows.length - 1, Math.max(0, i + step));
      if (!options[i].disabled) break;
    }
    setActive(i);
    scrollToActive();
  }
  function pick(i: number): void {
    if (options[i].disabled) return;
    const changed = (indexProp.get!.call(select) as number) !== i;
    indexProp.set!.call(select, i);
    close();
    refresh();
    if (changed) {
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    trigger.focus();
  }

  let typed = '';
  let typedAt = 0;
  // Capture on window runs before the modal's document listener, so Escape closes the menu, not the dialog under it.
  function onKey(event: KeyboardEvent): void {
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(1), ArrowUp: () => move(-1), Home: () => { setActive(0); scrollToActive(); }, End: () => { setActive(rows.length - 1); scrollToActive(); },
      PageDown: () => move(8), PageUp: () => move(-8), Enter: () => pick(active), ' ': () => pick(active), Escape: () => { close(); trigger.focus(); }, Tab: () => close(),
    };
    const run = keys[event.key];
    if (run) {
      if (event.key !== 'Tab') { event.preventDefault(); event.stopPropagation(); }
      run();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      typed = now - typedAt > 700 ? event.key.toLowerCase() : typed + event.key.toLowerCase();
      typedAt = now;
      const found = options.findIndex((o) => !o.disabled && o.text.toLowerCase().startsWith(typed));
      if (found >= 0) { setActive(found); scrollToActive(); }
      event.preventDefault();
      event.stopPropagation();
    }
  }
  function onDown(event: MouseEvent): void {
    if (!menu.contains(event.target as Node) && !trigger.contains(event.target as Node)) close();
  }
  function onScroll(event: Event): void { if (!menu.contains(event.target as Node)) close(); }

  function close(): void {
    menu.remove();
    trigger.setAttribute('aria-expanded', 'false');
    trigger.classList.remove('is-open');
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', close);
    if (open === handle) open = null;
  }
  const handle = { close };
  open = handle;

  document.body.append(menu);
  place(menu, trigger);
  setActive(active);
  scrollToActive();
  trigger.setAttribute('aria-expanded', 'true');
  trigger.classList.add('is-open');
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', close);
}

/** Under the trigger, or above it when there is more room there; never off screen. */
function place(menu: HTMLElement, trigger: HTMLElement): void {
  const r = trigger.getBoundingClientRect();
  const gap = 4, edge = 8;
  const below = window.innerHeight - r.bottom - edge - gap;
  const above = r.top - edge - gap;
  const up = below < 200 && above > below;
  menu.style.minWidth = Math.round(r.width) + 'px';
  menu.style.maxHeight = Math.max(120, Math.min(340, up ? above : below)) + 'px';
  const width = menu.offsetWidth;
  menu.style.left = Math.round(Math.max(edge, Math.min(r.left, window.innerWidth - width - edge))) + 'px';
  if (up) menu.style.bottom = Math.round(window.innerHeight - r.top + gap) + 'px';
  else menu.style.top = Math.round(r.bottom + gap) + 'px';
  if (up) menu.classList.add('is-up');
}

/** Enhances every select now and as pages add them. Call once at startup. */
export function themeAllSelects(root: HTMLElement = document.body): void {
  const scan = (node: ParentNode): void => {
    if (node instanceof HTMLSelectElement) enhanceSelect(node);
    else node.querySelectorAll?.('select').forEach((s) => enhanceSelect(s as HTMLSelectElement));
  };
  scan(root);
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) scan(node as Element);
  }).observe(root, { childList: true, subtree: true });
}
